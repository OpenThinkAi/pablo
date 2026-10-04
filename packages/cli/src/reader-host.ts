/**
 * The reader's window, host side (AGT-1586, `pm project show ai-terminal --doc readers`): opens the
 * ui-leaf view `views/reader.tsx` on a fetched round, answers its two mutations, and nothing more.
 *
 * The split is the design's: the view displays paragraphs and collects marks; this file is the only thing
 * that touches the round's files and GitHub, through code that already exists and is tested:
 *  - `read.ts` — `fetchRound` / `readCachedRound` / `cachedRoundDir` get the chapters and the pinned commit;
 *  - core `review-map` — `readingChapter` turns a stored chapter into the paragraphs the view shows, and
 *    `resolveReview` checks that every mark the window posts lands on real lines of a real chapter;
 *  - `submit.ts` — `submitReview` posts one GitHub review; the marks are saved to `marksPath` first.
 *
 * Wire contract (`views/reader-protocol.ts`): `data` is a `ReaderData`; the view may call exactly
 * `saveDraft({draft})` (written to `<id>.marks.json`, the file Submit also writes, so a closed window comes
 * back with its marks) and `submit({draft})`. Both answer a `HostAnswer`; a failure is plain words, never a
 * thrown error. Once `<id>.sent.json` exists the round is read-only: `saveDraft` and `submit` refuse.
 *
 * Every `gh` call goes through the injected `Runner`; the window itself is `deps.mount` (ui-leaf's `mount`),
 * so tests drive the protocol against a fake and never open a browser.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readingChapter, resolveReview } from "@openthink/pablo-core";
import type { ReviewDraft } from "@openthink/pablo-core";
import { mount } from "@openthink/ui-leaf";
import type { MountOptions, MutationHandler, View } from "@openthink/ui-leaf";
import { parseDraft } from "../views/reader-protocol";
import type { HostAnswer, ReaderData, ViewChapter } from "../views/reader-protocol";
import { markReaderActive } from "./tray/activity";
import { cachedRoundDir, fetchRound, readCachedRound } from "./read";
import type { CachedRound, RoundRef } from "./read";
import { CHAPTER_PATH, realRunner } from "./share";
import type { Runner } from "./share";
import { marksPath, readSent, submitReview } from "./submit";

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// The host: data + the two mutations
// ---------------------------------------------------------------------------

export interface ReaderHostOptions {
  readonly round: CachedRound;
  /** `cachedRoundDir(ref)`: the chapters, `round.json`, and Submit's files. */
  readonly dir: string;
  readonly run: Runner;
  readonly now?: () => Date;
}

export interface ReaderHost {
  /** What the view is mounted with. Read fresh each call: the sent state and the saved marks are the files'. */
  data(): ReaderData;
  saveDraft(args: unknown): HostAnswer;
  submit(args: unknown): HostAnswer;
}

/** `title:` from a chapter's frontmatter, unquoted; "" when there is none. */
function frontmatterTitle(stored: string): string {
  const lines = stored.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return "";
  for (let i = 1; i < lines.length && lines[i]?.trim() !== "---"; i++) {
    const match = /^title:\s*(.*?)\s*$/.exec(lines[i] as string);
    if (match) return (match[1] as string).replace(/^(["'])(.*)\1$/, "$2");
  }
  return "";
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

/** The round's chapters as stored, by path. Only paths matching the chapter pattern, and only inside `dir`. */
function readChapters(round: CachedRound, dir: string): Record<string, string> {
  const stored: Record<string, string> = {};
  for (const chapter of round.chapters) {
    const file = resolve(dir, chapter.path);
    if (!CHAPTER_PATH.test(chapter.path) || !file.startsWith(`${resolve(dir)}/`)) throw new Error(`pablo: read: ${chapter.path} is not a chapter path`);
    stored[chapter.path] = readFileSync(file, "utf8");
  }
  return stored;
}

function emptyDraft(): ReviewDraft {
  return { summary: "", marks: [] };
}

/** The saved marks, or an empty draft when there are none or the file is unreadable (it is never trusted). */
function savedDraft(dir: string, id: string): ReviewDraft {
  try {
    return parseDraft(JSON.parse(readFileSync(marksPath(dir, id), "utf8")));
  } catch {
    return emptyDraft();
  }
}

export function createReaderHost(options: ReaderHostOptions): ReaderHost {
  const { round, dir, run } = options;
  const stored = readChapters(round, dir);

  const chapters = (): ViewChapter[] =>
    round.chapters.map((c) => ({
      path: c.path,
      number: c.number,
      title: frontmatterTitle(stored[c.path] as string),
      paragraphs: readingChapter(stored[c.path] as string).paragraphs.map((p) => ({ text: p.text, prose: p.prose })),
    }));

  /** The window's marks, checked: the shape, then that every one lands on a chapter of this round. */
  function checked(args: unknown): { ok: true; draft: ReviewDraft } | { ok: false; message: string } {
    try {
      const draft = parseDraft((args as { draft?: unknown } | null)?.draft);
      resolveReview(stored, draft);
      return { ok: true, draft };
    } catch (error) {
      return { ok: false, message: `Your marks could not be placed on the chapters (${(error as Error).message.replace(/^pablo: /, "")}).` };
    }
  }

  const alreadySent = (): HostAnswer | undefined =>
    readSent(dir, round.id) === undefined ? undefined : { ok: false, message: "This round was already sent; one round is one review." };

  return {
    data(): ReaderData {
      const sent = readSent(dir, round.id);
      return {
        round: { ref: `${round.repo}#${round.pr}`, title: round.title, sender: round.sender, id: round.id },
        chapters: chapters(),
        draft: savedDraft(dir, round.id),
        ...(sent === undefined ? {} : { sent: { reviewUrl: sent.reviewUrl, sentAt: sent.sentAt } }),
      };
    },

    saveDraft(args): HostAnswer {
      const refused = alreadySent();
      if (refused !== undefined) return refused;
      const result = checked(args);
      if (!result.ok) return result;
      try {
        writeAtomic(marksPath(dir, round.id), `${JSON.stringify(result.draft, null, 2)}\n`);
      } catch (error) {
        return { ok: false, message: `Could not save your marks on this Mac (${(error as Error).message}).` };
      }
      return { ok: true };
    },

    submit(args): HostAnswer {
      const refused = alreadySent();
      if (refused !== undefined) return refused;
      const result = checked(args);
      if (!result.ok) return result;
      const outcome = submitReview({
        round: { id: round.id, repo: round.repo, pr: round.pr, commit: round.commit },
        chapters: stored,
        draft: result.draft,
        dir,
        run,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      if (!outcome.ok) return { ok: false, message: outcome.message.replace(/^pablo: submit: /, "") };
      return { ok: true, sent: { reviewUrl: outcome.sent.reviewUrl, sentAt: outcome.sent.sentAt } };
    },
  };
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

/** The mutations the window may call, and nothing else: ui-leaf answers 404 for any other name. */
export function readerMutations(host: ReaderHost): Record<string, MutationHandler> {
  return {
    saveDraft: async (args) => host.saveDraft(args),
    submit: async (args) => host.submit(args),
  };
}

/** Where the view files ship (`packages/cli/views`, in the package's `files`). */
export const VIEWS_ROOT = resolve(import.meta.dir, "..", "views");

/** macOS Chromium-family bundle paths ui-leaf's own probe uses; the reader view needs one of them. */
export const CHROMIUM_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
] as const;

export const NO_CHROME_MESSAGE =
  "pablo: the reader window opens in Google Chrome, and I could not find it on this Mac. Install Chrome (https://www.google.com/chrome) and run this again; nothing was changed.";

function executable(path: string): boolean {
  try {
    return (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function findChrome(exists: (path: string) => boolean = executable): string | undefined {
  return CHROMIUM_PATHS.find((path) => exists(path));
}

/** ui-leaf's own `ui-leaf-bin` beside the installed package, when it is there; undefined lets ui-leaf look. */
export function resolveUiLeafBinary(): string | undefined {
  try {
    const entry = Bun.resolveSync("@openthink/ui-leaf", import.meta.dir);
    const bin = join(dirname(entry), "..", "bin", process.platform === "win32" ? "ui-leaf-bin.exe" : "ui-leaf-bin");
    return existsSync(bin) ? resolve(bin) : undefined;
  } catch {
    return undefined;
  }
}

/** After the window disconnects and does not come back, close its server. */
const DISCONNECT_CLOSE_DELAY_MS = 5000;

export interface OpenReaderDeps {
  readonly run: Runner;
  readonly env: Env;
  readonly mount: (options: MountOptions) => Promise<View>;
  readonly existsExecutable: (path: string) => boolean;
  readonly binaryPath: () => string | undefined;
  readonly now?: () => Date;
}

export type OpenOutcome =
  | { readonly ok: true; readonly view: View; readonly closed: Promise<void> }
  | { readonly ok: false; readonly code: 1 | 2; readonly message: string };

/**
 * Fetches the round (or reuses the cache at the same head commit), then mounts the reader view on it.
 * Refuses, before any fetch, when Google Chrome is not installed: ui-leaf's app shell would otherwise fall
 * back to a plain tab. The returned `closed` resolves when the window is gone.
 */
export async function openReader(ref: RoundRef, signal?: AbortSignal, overrides: Partial<OpenReaderDeps> = {}): Promise<OpenOutcome> {
  const deps: OpenReaderDeps = {
    run: realRunner,
    env: process.env,
    mount,
    existsExecutable: executable,
    binaryPath: resolveUiLeafBinary,
    ...overrides,
  };
  if (findChrome(deps.existsExecutable) === undefined) return { ok: false, code: 2, message: NO_CHROME_MESSAGE };

  const fetched = fetchRound({ run: deps.run, env: deps.env, ref });
  if (!fetched.ok) return fetched;
  const round = readCachedRound(ref, deps.env) ?? fetched.round;
  let host: ReaderHost;
  try {
    host = createReaderHost({ round, dir: cachedRoundDir(ref, deps.env), run: deps.run, ...(deps.now === undefined ? {} : { now: deps.now }) });
  } catch (error) {
    return { ok: false, code: 1, message: (error as Error).message };
  }

  // ui-leaf reads this from its inherited environment and, on its own, suppresses the window under ssh;
  // this is a window meant to open. An explicit UI_LEAF_NO_OPEN is still honoured.
  if (process.env["UI_LEAF_NO_OPEN"] === undefined) process.env["UI_LEAF_NO_OPEN"] = "0";

  const binaryPath = deps.binaryPath();
  const data = host.data();
  let view: View;
  // While this window is open the tray's self-updater must not replace pablo's files (AGT-1598).
  const release = markReaderActive(deps.env);
  try {
    view = await deps.mount({
      view: "reader",
      viewsRoot: VIEWS_ROOT,
      data,
      title: `${data.round.title} — pablo`,
      mutations: readerMutations(host),
      shell: "app",
      port: 0,
      silent: true,
      // A reading window is one you leave while you do something else; the default 15 s heartbeat reports a
      // disconnect once Chrome throttles a minimised window's timers.
      heartbeatTimeoutMs: 70_000,
      ...(binaryPath === undefined ? {} : { binaryPath }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    release();
    return { ok: false, code: 1, message: `pablo: read: could not open the reader window (${(error as Error).message})` };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  view.onDisconnect(() => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => void view.close(), DISCONNECT_CLOSE_DELAY_MS);
  });
  view.onReconnect(() => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  });
  const closed = view.closed.then(() => {
    release();
    if (timer !== undefined) clearTimeout(timer);
  });
  return { ok: true, view, closed };
}
