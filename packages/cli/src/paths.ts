/**
 * Where pablo's own machine state lives when there is no vault to put it in.
 *
 * Documents always live in the vault and receipts for a vault run land in
 * `<vault>/.pablo/receipts.jsonl` (core's `fileReceiptSink`). But `pablo
 * prose` (AGT-1242) deliberately runs with no vault at all — an email drafted
 * from a random directory — and that call still has to leave a receipt. The
 * design doc's answer (`~/saltline-digital-vault/projects/ai-terminal/prose.md`)
 * is `~/.local/state/pablo/receipts.jsonl`: the XDG state directory, the same
 * shape core's `configDir` already gives `$XDG_CONFIG_HOME/pablo`.
 *
 * This module is the CLI's, not core's, for the same reason `voice.ts` is:
 * core stays dependency-free and pablo's *layout* on the author's machine is a
 * CLI concern.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Receipt, ReceiptSink } from "@openthink/pablo-core";

/**
 * pablo's state directory: `$XDG_STATE_HOME/pablo`, else `~/.local/state/pablo`.
 * `env` is always passed explicitly by callers that have one (every verb has
 * `ctx.env`), so a test pointing `XDG_STATE_HOME` at a temp directory is never
 * bypassed and no test can append to the author's real receipts log.
 */
export function stateDir(env: Record<string, string | undefined> = process.env): string {
  const base = env["XDG_STATE_HOME"];
  return base ? join(base, "pablo") : join(homedir(), ".local", "state", "pablo");
}

/** `<stateDir>/receipts.jsonl` — the no-vault receipts log. */
export function stateReceiptsPath(env: Record<string, string | undefined> = process.env): string {
  return join(stateDir(env), "receipts.jsonl");
}

/**
 * `<stateDir>/review.jsonl` — the review queue. The append-only JSONL module
 * itself is `review.ts` (AGT-1255); the `pablo review` verbs are AGT-1261,
 * `pablo status`'s per-chapter lookup is AGT-1263, and AGT-1262's `write` /
 * `prose` hooks append the `queued` events. Global, not per-vault, per the
 * design doc's "one path for the tray to watch": a piece from any vault or
 * none lands in the one file the tray, CLI and MCP all watch. Same
 * `env`-default rule as `stateReceiptsPath` above.
 */
export function stateReviewPath(env: Record<string, string | undefined> = process.env): string {
  return join(stateDir(env), "review.jsonl");
}

/**
 * `<stateDir>/drafts` (AGT-1262) — where an `--out`-less `pablo prose` piece
 * is also written (frontmatter as `--out` would write) so the review queue's
 * `path` for it always names a file the editor can open.
 */
export function stateDraftsDir(env: Record<string, string | undefined> = process.env): string {
  return join(stateDir(env), "drafts");
}

/**
 * A `ReceiptSink` appending to an absolute JSONL path, creating its directory
 * on first use — the state-directory counterpart to core's `fileReceiptSink`.
 * Not a generalisation of that function: core's takes a *vault root* and
 * derives `.pablo/receipts.jsonl` under it, which is the wrong layout for a
 * directory that is already pablo's own (`~/.local/state/pablo/` would become
 * `~/.local/state/pablo/.pablo/`).
 *
 * The path is always derived from `stateReceiptsPath`, never from anything a
 * model supplied — the same rule core's `receipt-log.ts` documents.
 */
export function jsonlReceiptSink(path: string): ReceiptSink {
  return (receipt: Receipt) => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(receipt)}\n`, "utf8");
  };
}
