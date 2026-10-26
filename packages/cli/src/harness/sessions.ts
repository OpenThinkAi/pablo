/**
 * Saved harness sessions (AGT-1565, provider-neutral since AGT-2122, decision
 * D-14): a book is planned over weeks, so the conversation with pablo survives
 * quitting. It lives under the work's own `.pablo/sessions/` (machine state,
 * gitignored with the rest of `.pablo/`) and is resumed the next time the work
 * is opened.
 *
 * - One JSONL file per session, `<id>.jsonl`: a header line
 *   (`{"pablo":"session","version":1,"id","startedAt"}`) then one line per
 *   message of the conversation, `{"message": <ChatMessage>}`, exactly the
 *   neutral history `runLoop` takes and returns. Nothing in it is vendor
 *   specific, so a session started on the local model resumes on Claude and
 *   back; it is a plain file the author can read or copy.
 * - The index (`index.json`): which session is current, and every session the
 *   work has had, oldest first. `pablo agent` resumes the current one; `--new`
 *   mints a fresh one and makes it current. The old session's file stays.
 * - A `<id>.jsonl` from before AGT-2122 is in the Agent SDK's own format (D-14:
 *   not migrated). It has no pablo header, so it is reported as legacy, left
 *   untouched, and the open starts a new session instead.
 *
 * Anthropic thinking blocks are not in the neutral history (the adapter keeps
 * them in memory), so a resumed Claude session rebuilds its earlier tool turns
 * without thinking; the adapter does that by design (`anthropic.ts`).
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "@openthink/pablo-core";

export interface SessionRecord {
  readonly id: string;
  /** ISO timestamp the session was started. */
  readonly startedAt: string;
}

export interface SessionIndex {
  readonly current: string | undefined;
  readonly sessions: readonly SessionRecord[];
}

/** What a run needs: the id, the history to resume (empty for a new session), and a legacy file it skipped. */
export interface SessionChoice {
  readonly id: string;
  readonly history: readonly ChatMessage[];
  /** True when this open resumed an existing transcript. */
  readonly resumed: boolean;
  /** The id of a current session found in the SDK's format: not resumable, left untouched. */
  readonly legacy?: string;
}

export function sessionsDir(workDir: string): string {
  return join(workDir, ".pablo", "sessions");
}

const INDEX_FILE = "index.json";
const FORMAT_VERSION = 1;

/** Ids are UUIDs; refuse anything that could climb out of the directory. */
function safeSegment(segment: string): string {
  if (segment === "" || segment === "." || segment === ".." || /[\\/\0]/.test(segment)) {
    throw new Error(`unsafe session path segment: ${JSON.stringify(segment)}`);
  }
  return segment;
}

export function transcriptPath(workDir: string, id: string): string {
  return join(sessionsDir(workDir), `${safeSegment(id)}.jsonl`);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function isMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value)) return false;
  switch (value["role"]) {
    case "user":
      return typeof value["content"] === "string";
    case "assistant":
      return typeof value["content"] === "string" && (value["toolCalls"] === undefined || Array.isArray(value["toolCalls"]));
    case "tool":
      return typeof value["toolCallId"] === "string" && typeof value["content"] === "string";
    default:
      return false;
  }
}

export type LoadedSession =
  | { readonly kind: "ok"; readonly history: readonly ChatMessage[] }
  | { readonly kind: "legacy" }
  | { readonly kind: "damaged"; readonly reason: string };

/** Reads a session file: its history, or why it cannot be resumed. A torn last line (a write cut short) is dropped. */
export function loadSession(workDir: string, id: string): LoadedSession {
  const lines = readFileSync(transcriptPath(workDir, id), "utf8").split("\n").filter((line) => line.trim() !== "");
  let header: unknown;
  try {
    header = lines.length === 0 ? undefined : JSON.parse(lines[0]!);
  } catch {
    return { kind: "legacy" };
  }
  if (!isRecord(header) || header["pablo"] !== "session") return { kind: "legacy" };
  if (header["version"] !== FORMAT_VERSION) return { kind: "damaged", reason: `it is format version ${String(header["version"])}, and this pablo reads version ${FORMAT_VERSION}` };
  const history: ChatMessage[] = [];
  for (const [i, line] of lines.slice(1).entries()) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      if (i === lines.length - 2) break; // torn final line
      return { kind: "damaged", reason: `line ${i + 2} is not JSON` };
    }
    if (!isRecord(entry) || !isMessage(entry["message"])) return { kind: "damaged", reason: `line ${i + 2} is not a message` };
    history.push(entry["message"]);
  }
  return { kind: "ok", history };
}

/** Appends messages to a session's file, creating it (with its header) the first time. */
export function appendMessages(workDir: string, id: string, messages: readonly ChatMessage[], now: () => Date = () => new Date()): void {
  if (messages.length === 0) return;
  const path = transcriptPath(workDir, id);
  mkdirSync(sessionsDir(workDir), { recursive: true });
  let out = "";
  if (existsSync(path)) {
    // A torn final line (a write cut short) was dropped on load; cut it from the file too, so this append starts on a clean line.
    const text = readFileSync(path, "utf8");
    if (text !== "" && !text.endsWith("\n")) truncateSync(path, Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1)));
  } else {
    out += `${JSON.stringify({ pablo: "session", version: FORMAT_VERSION, id, startedAt: now().toISOString() })}\n`;
  }
  out += messages.map((message) => `${JSON.stringify({ message })}\n`).join("");
  appendFileSync(path, out);
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
 * The session this open should run: the work's current one, resumed from its
 * file, or a fresh one when there is none, `fresh` is set, or the current file
 * is a legacy SDK transcript (reported in `legacy`, left untouched). A fresh
 * session is recorded as current before it runs; the previous one stays in the
 * index and on disk. A damaged current file throws, naming it: it is never
 * overwritten.
 */
export function chooseSession(workDir: string, options: { readonly fresh: boolean }, now: () => Date = () => new Date()): SessionChoice {
  const index = readSessionIndex(workDir);
  let legacy: string | undefined;
  if (!options.fresh && index.current !== undefined) {
    const path = transcriptPath(workDir, index.current);
    if (!existsSync(path)) return { id: index.current, history: [], resumed: false };
    const loaded = loadSession(workDir, index.current);
    if (loaded.kind === "ok") return { id: index.current, history: loaded.history, resumed: true };
    if (loaded.kind === "damaged") {
      throw new Error(`the saved session ${index.current} cannot be resumed (${loaded.reason}); its file is untouched at ${path}. Start a new one with --new`);
    }
    legacy = index.current;
  }
  const id = randomUUID();
  writeSessionIndex(workDir, { current: id, sessions: [...index.sessions, { id, startedAt: now().toISOString() }] });
  return { id, history: [], resumed: false, ...(legacy === undefined ? {} : { legacy }) };
}
