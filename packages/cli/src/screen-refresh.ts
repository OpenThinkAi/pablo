// The screen's live data (AGT-1640). The tui cannot import this package, so cli.ts passes it in through runScreen's
// options, like `diffOf`.
//
// - `screenRefresh` reads the book's stages and waiting branches again: local files and git, a few milliseconds, so the
//   screen calls it every few seconds and work done outside it (a write, the agent, plain git) shows up.

import type { BookSnapshot } from "@openthink/pablo-tui";
import { workBookStages } from "./book";
import { repoRoot, waitingBranches } from "./branch";

/** The book at `dir` read again: its stages (with chapters whose draft waits on a branch) and the branches waiting for review. */
export function screenRefresh(dir: string): () => BookSnapshot | undefined {
  return () => {
    const repo = repoRoot(dir);
    const waiting = repo === undefined ? { ok: true as const, branches: [] } : waitingBranches(repo, dir);
    // A git that fails this once keeps what the screen has; the next tick tries again.
    if (!waiting.ok) return undefined;
    return { stages: workBookStages(dir, waiting.branches), branches: waiting.branches };
  };
}
