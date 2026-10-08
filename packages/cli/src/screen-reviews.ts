// The screen's live data (AGT-1640) and its Enter on a reader's review (AGT-1641). The tui cannot import this package,
// so cli.ts passes these in through runScreen's options, like `diffOf`.
//
// - `screenRefresh` reads the book's stages and waiting branches again: local files and git, a few milliseconds, so the
//   screen calls it every few seconds and work done outside it (a write, a pull, the agent, plain git) shows up.
// - `screenRounds` and `screenPuller` reach GitHub. `listRoundStatus` and `notesPull` run `gh` and `git` synchronously,
//   which would freeze the screen for seconds, so each runs as pablo's own verb in a child process
//   (`share --list --json`, `notes pull --json`) and the screen reads its JSON. Same code, same output, never blocking.

import { basename } from "node:path";
import type { BookSnapshot, PullResult, Round, RoundsResult } from "@openthink/pablo-tui";
import { bookStages } from "./book";
import { repoRoot, waitingBranches } from "./branch";
import { readNovelState } from "./novel/machine";

/** What a child pablo came to. */
export interface ExecResult { readonly code: number; readonly stdout: string; readonly stderr: string }
/** Runs pablo with `args` in `cwd`; resolves when it exits. Tests pass a fake. */
export type PabloExec = (args: readonly string[], cwd: string) => Promise<ExecResult>;

/** Runs pablo's `entry` script on this runtime with `env`. */
export function pabloExec(entry: string | undefined, env: Record<string, string | undefined> = process.env): PabloExec {
  return async (args, cwd) => {
    if (!entry) return { code: 1, stdout: "", stderr: "pablo: cannot find its own entry script" };
    const child = Bun.spawn([process.execPath, entry, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr };
  };
}

/** The pablo this process is: the same runtime and entry script, so the child is the installed version, never another. */
export const selfExec: PabloExec = pabloExec(Bun.main || process.argv[1]);

/** The book at `dir` read again: its stages (with chapters whose draft waits on a branch) and the branches waiting for review. */
export function screenRefresh(dir: string): () => BookSnapshot | undefined {
  return () => {
    const repo = repoRoot(dir);
    const waiting = repo === undefined ? { ok: true as const, branches: [] } : waitingBranches(repo);
    // A git that fails this once keeps what the screen has; the next tick tries again.
    if (!waiting.ok) return undefined;
    return { stages: bookStages(readNovelState(dir), waiting.branches), branches: waiting.branches };
  };
}

/** The last line of a child's stderr, for a message: what pablo said last is what went wrong. */
const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";

function parse(r: ExecResult): Record<string, unknown> | string {
  try {
    const body = JSON.parse(r.stdout) as unknown;
    if (body !== null && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // fall through to the message below
  }
  return lastLine(r.stderr) || `pablo exited ${r.code} without an answer`;
}

/** The work's rounds as the Reviews group shows them: those still with a reader and those with a review in; pulled ones are branches by now. */
export function screenRounds(dir: string, slug: string = basename(dir), exec: PabloExec = selfExec): () => Promise<RoundsResult> {
  return async () => {
    const body = parse(await exec(["share", "--list", "--project", slug, "--json"], dir));
    if (typeof body === "string") return { ok: false, message: body };
    if (!Array.isArray(body["rounds"])) return { ok: false, message: typeof body["message"] === "string" ? body["message"] : "no rounds in pablo's answer" };
    const rounds: Round[] = [];
    for (const r of body["rounds"] as Record<string, unknown>[]) {
      if (typeof r["id"] !== "string" || (r["status"] !== "open" && r["status"] !== "submitted")) continue;
      const chapters = Array.isArray(r["chapters"]) ? (r["chapters"] as unknown[]).filter((n): n is number => typeof n === "number") : [];
      rounds.push({ id: r["id"], reader: typeof r["reader"] === "string" ? r["reader"] : "a reader", chapters, status: r["status"] === "submitted" ? "submitted" : "reading" });
    }
    // A round GitHub could not be asked about is listed as still reading, with a notice: the footer says so.
    const notices = Array.isArray(body["notices"]) ? (body["notices"] as unknown[]).filter((n): n is string => typeof n === "string") : [];
    return { ok: true, rounds, ...(notices.length > 0 ? { note: notices[0]!.replace(/^pablo: share --list: /, "") } : {}) };
  };
}

interface PulledEntry { round?: unknown; branch?: unknown; commits?: unknown; comments?: unknown }
interface SkippedEntry { round?: unknown; reason?: unknown; message?: unknown }

/** Pulls the work's submitted reviews (`notes pull`) and answers for `round`: the `reader/` branch it is on, or why not. */
export function screenPuller(dir: string, slug: string = basename(dir), exec: PabloExec = selfExec): (round: string) => Promise<PullResult> {
  return async (round) => {
    const body = parse(await exec(["notes", "pull", "--project", slug, "--json"], dir));
    if (typeof body === "string") return { ok: false, message: body };
    const notices = Array.isArray(body["notices"]) ? (body["notices"] as unknown[]).filter((n): n is string => typeof n === "string") : [];
    const pulled = (Array.isArray(body["pulled"]) ? body["pulled"] : []) as PulledEntry[];
    const mine = pulled.find((p) => p.round === round);
    if (mine && typeof mine.branch === "string") {
      const suggestions = Array.isArray(mine.commits) ? mine.commits.length : 0;
      const comments = typeof mine.comments === "number" ? mine.comments : 0;
      const others = pulled.filter((p) => p !== mine && typeof p.branch === "string").map((p) => `also pulled ${String(p.round)} into ${String(p.branch)}`);
      return { ok: true, branch: mine.branch, lines: [`${suggestions} suggestion${suggestions === 1 ? "" : "s"}, ${comments} comment${comments === 1 ? "" : "s"}`, ...others, ...notices] };
    }
    const skipped = ((Array.isArray(body["skipped"]) ? body["skipped"] : []) as SkippedEntry[]).find((s) => s.round === round);
    // Pulled earlier (by `notes pull`, or a screen that has not polled since): its branch is there to review.
    if (skipped?.reason === "pulled") return { ok: true, branch: `reader/${round}`, lines: ["already pulled", ...notices] };
    if (skipped && typeof skipped.message === "string") return { ok: false, message: skipped.message };
    return { ok: false, message: typeof body["message"] === "string" ? body["message"] : `pablo found nothing to pull for ${round}` };
  };
}
