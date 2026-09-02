/**
 * Where receipts land: one JSON object per line at `<vault>/.pablo/receipts.jsonl`.
 *
 * Per vault, not per repo, because the vault is the thing a run belongs to and
 * `~/writing` is a git repository the author commits by hand. **`.pablo/` must be
 * gitignored in the vault** — the log is machine state, it grows without bound,
 * and it is not part of the manuscript. pablo never writes to the vault's
 * `.gitignore` itself; see the note in this repo's `CLAUDE.md`.
 *
 * JSONL because appends are atomic enough for a single-writer local tool, a
 * truncated last line costs one receipt rather than the file, and `jq` reads it.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Receipt, ReceiptSink } from "./receipts";

/** Path of the receipt log relative to the vault root. */
export const RECEIPTS_RELATIVE_PATH = join(".pablo", "receipts.jsonl");

export function receiptsPath(vaultRoot: string): string {
  return join(vaultRoot, RECEIPTS_RELATIVE_PATH);
}

/**
 * Appends one receipt, creating `<vault>/.pablo/` on first use. Deliberately not
 * exported: the only path a receipt is ever written to is the one
 * `receiptsPath` derives from a vault root the app chose, never a path that came
 * out of a model.
 */
function appendReceipt(path: string, receipt: Receipt): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(receipt)}\n`, "utf8");
}

/** The sink to hand `withReceipts` for a vault. */
export function fileReceiptSink(vaultRoot: string): ReceiptSink {
  const path = receiptsPath(vaultRoot);
  return (receipt: Receipt) => appendReceipt(path, receipt);
}
