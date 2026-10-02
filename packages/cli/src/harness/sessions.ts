/**
 * Saved harness sessions (AGT-1565): a book is planned over weeks, so the
 * conversation with pablo survives quitting. It lives under the work's own
 * `.pablo/sessions/` (machine state, gitignored with the rest of `.pablo/`)
 * and is resumed the next time the work is opened.
 *
 * Two pieces:
 *
 * - `fileSessionStore`: the Agent SDK's `SessionStore` adapter over that
 *   directory. The SDK mirrors every transcript entry into it as the session
 *   runs and, given a session id to resume, loads it back from it. One JSONL
 *   file per session (`<id>.jsonl`, one entry per line, entries with a `uuid`
 *   deduplicated), so a session on disk is a plain file Matt can read or copy.
 * - the index (`index.json`): which session is current, and every session the
 *   work has had, oldest first. `pablo agent` resumes the current one; `--new`
 *   mints a fresh one and makes it current. The old session's file stays.
 *
 * The SDK still keeps its own copy under Claude's config directory (it needs it
 * to run); `.pablo/sessions/` is the copy that belongs to the work.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

export interface SessionRecord {
  readonly id: string;
  /** ISO timestamp the session was started. */
  readonly startedAt: string;
}

export interface SessionIndex {
  readonly current: string | undefined;
  readonly sessions: readonly SessionRecord[];
}

/** What a run needs: the id, and whether to resume it or start it under that id. */
export interface SessionChoice {
  readonly id: string;
  readonly resume: boolean;
  readonly store: SessionStore;
}

export function sessionsDir(workDir: string): string {
  return join(workDir, ".pablo", "sessions");
}

const INDEX_FILE = "index.json";

/** Ids are the SDK's UUIDs; refuse anything that could climb out of the directory. */
function safeSegment(segment: string): string {
  if (segment === "" || segment === "." || segment === ".." || /[\\/\0]/.test(segment)) {
    throw new Error(`unsafe session path segment: ${JSON.stringify(segment)}`);
  }
  return segment;
}

function transcriptPath(dir: string, key: { readonly sessionId: string; readonly subpath?: string | undefined }): string {
  const id = safeSegment(key.sessionId);
  if (key.subpath === undefined) return join(dir, `${id}.jsonl`);
  return join(dir, id, `${key.subpath.split("/").map(safeSegment).join("/")}.jsonl`);
}

function readLines(path: string): SessionStoreEntry[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as SessionStoreEntry);
}

/** The SDK's `SessionStore` over `<workDir>/.pablo/sessions/`. */
export function fileSessionStore(workDir: string): SessionStore {
  const dir = sessionsDir(workDir);
  return {
    async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
      if (entries.length === 0) return;
      const path = transcriptPath(dir, key);
      mkdirSync(join(path, ".."), { recursive: true });
      // A retried batch must not duplicate: entries with a uuid are idempotent.
      const seen = new Set<string>();
      if (existsSync(path)) {
        for (const entry of readLines(path)) if (entry.uuid !== undefined) seen.add(entry.uuid);
      }
      const fresh = entries.filter((entry) => {
        if (entry.uuid === undefined) return true;
        if (seen.has(entry.uuid)) return false;
        seen.add(entry.uuid);
        return true;
      });
      if (fresh.length > 0) appendFileSync(path, fresh.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    },
    async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
      const path = transcriptPath(dir, key);
      return existsSync(path) ? readLines(path) : null;
    },
    async listSessions(): Promise<Array<{ sessionId: string; mtime: number }>> {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => ({ sessionId: name.slice(0, -".jsonl".length), mtime: Math.floor(statSync(join(dir, name)).mtimeMs) }));
    },
    async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
      const sub = join(dir, safeSegment(key.sessionId));
      if (!existsSync(sub)) return [];
      const out: string[] = [];
      const walk = (path: string, prefix: string): void => {
        for (const name of readdirSync(path)) {
          const full = join(path, name);
          if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`);
          else if (name.endsWith(".jsonl")) out.push(`${prefix}${name.slice(0, -".jsonl".length)}`);
        }
      };
      walk(sub, "");
      return out;
    },
  };
}

export function readSessionIndex(workDir: string): SessionIndex {
  const path = join(sessionsDir(workDir), INDEX_FILE);
  if (!existsSync(path)) return { current: undefined, sessions: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { current?: unknown; sessions?: unknown };
    const sessions = Array.isArray(raw.sessions)
      ? raw.sessions.filter(
          (item): item is SessionRecord =>
            typeof item === "object" && item !== null && typeof (item as SessionRecord).id === "string" && typeof (item as SessionRecord).startedAt === "string",
        )
      : [];
    return { current: typeof raw.current === "string" ? raw.current : undefined, sessions };
  } catch {
    // An unreadable index is treated as none: the next open starts a session;
    // the transcripts beside it are untouched.
    return { current: undefined, sessions: [] };
  }
}

function writeSessionIndex(workDir: string, index: SessionIndex): void {
  const dir = sessionsDir(workDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, INDEX_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * The session this open should run: the work's current one (resumed once it has
 * a transcript on disk), or a fresh one when there is none or `fresh` is set.
 * A fresh session is recorded as current before it runs; the previous one stays
 * in the index and on disk.
 */
export function chooseSession(workDir: string, options: { readonly fresh: boolean }, now: () => Date = () => new Date()): SessionChoice {
  const store = fileSessionStore(workDir);
  const index = readSessionIndex(workDir);
  if (!options.fresh && index.current !== undefined) {
    const resume = existsSync(transcriptPath(sessionsDir(workDir), { sessionId: index.current }));
    return { id: index.current, resume, store };
  }
  const id = randomUUID();
  writeSessionIndex(workDir, { current: id, sessions: [...index.sessions, { id, startedAt: now().toISOString() }] });
  return { id, resume: false, store };
}
