// `a w` on the screen (AGT-1542): runs `write` for a chapter and hands the screen plain data back. The tui cannot import
// this package, so cli.ts passes the function in through runScreen's options (like `diffOf`). It is `runWrite` with its
// JSON body captured and its progress lines routed to the screen instead of the terminal the screen is drawing on.

import { captureConsoleLog, withWriteLock } from "./verbs";
import { runWrite } from "./write";
import type { RunWriteDeps } from "./write";

/** What the screen gets back: the new branch and the receipt lines, or the refusal with its missing reasons. */
export type ScreenWriteResult =
  | { readonly ok: true; readonly branch: string; readonly lines: readonly string[] }
  | { readonly ok: false; readonly message: string; readonly missing: readonly string[] };

export type ScreenWriter = (chapter: number, progress: (line: string) => void) => Promise<ScreenWriteResult>;

interface Body {
  ok?: boolean;
  message?: string;
  missing?: unknown;
  path?: string;
  branch?: string;
  receipt?: { words: number; tokensRead: number; tokensWritten: number; timeToFirstTokenMs: number; wallMs: number; temperature?: number; seed?: number };
  check?: readonly { path: string; line: number; rule: string; excerpt: string }[];
}

const seconds = (ms: number) => (Math.max(ms, 0) / 1000).toFixed(1);

/** The receipt as the CLI prints it, minus the rituals (they run at merge, not at write). */
function receiptLines(body: Body): string[] {
  const r = body.receipt;
  if (!r) return [];
  const lines = [
    `wrote ${body.path} (${r.words} words) on branch ${body.branch}`,
    `read ${r.tokensRead} tokens in ${seconds(r.timeToFirstTokenMs)}s, wrote ${r.tokensWritten} in ${seconds(r.wallMs - r.timeToFirstTokenMs)}s`,
  ];
  if (r.temperature !== undefined) lines.push(`sampled at temperature ${r.temperature}${r.seed === undefined ? "" : `, seed ${r.seed}`}`);
  for (const hit of body.check ?? []) lines.push(`${hit.path}:${hit.line} ${hit.rule} — ${hit.excerpt}`);
  return lines;
}

export function screenWriter(vaultRoot: string, projectPath: string, deps: Pick<RunWriteDeps, "adapter" | "env" | "now"> = {}): ScreenWriter {
  return async (chapter, progress) => {
    const stderr = { write: (text: string) => { for (const line of text.split("\n")) if (line.trim() !== "") progress(line); } };
    const args = { chapter: String(chapter), words: undefined, scenes: undefined, dryRun: false, json: true, force: false };
    let exitCode: number;
    let text: string;
    try {
      ({ exitCode, text } = await withWriteLock(() => captureConsoleLog(() => runWrite(args, vaultRoot, projectPath, { ...deps, stderr }))));
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), missing: [] };
    }
    let body: Body = {};
    try {
      body = text === "" ? {} : (JSON.parse(text) as Body);
    } catch {
      return { ok: false, message: text, missing: [] };
    }
    if (exitCode === 0 && body.ok && body.branch) return { ok: true, branch: body.branch, lines: receiptLines(body) };
    const missing = Array.isArray(body.missing) ? body.missing.filter((m): m is string => typeof m === "string") : [];
    return { ok: false, message: body.message ?? `pablo: write failed (exit ${exitCode})`, missing };
  };
}
