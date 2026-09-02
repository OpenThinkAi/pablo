/**
 * Reading receipts back out of the log, so a proposal under review can say what
 * it cost (AGT-1205 AC5).
 *
 * `packages/core/src/pack/receipt-log.ts` writes `<vault>/.pablo/receipts.jsonl`,
 * one JSON object per line, appended. This is the other end of it: the review
 * queue asks "which run produced this mark", and the answer is the newest
 * receipt whose `proposal.path` is this file and whose `proposal` span overlaps
 * the mark.
 *
 * Three properties it has on purpose:
 *
 * - **Lazy.** Nothing is read until a mark is actually under review, and the
 *   parse is cached until the log's size or mtime moves. A read-through that
 *   never opens review never touches the file.
 * - **Forgiving.** A truncated last line — the cost of an interrupted append —
 *   is skipped, not fatal. So is a missing log, a missing `.pablo/`, and a file
 *   opened outside any vault: all of them are "no receipt", which is a true
 *   statement and not an error.
 * - **Read-only.** Nothing in this module writes anywhere, ever. It is on the
 *   review path, and the review path's whole job is deciding what the *app*
 *   writes to the manuscript.
 */

import { statSync, readFileSync } from "node:fs";
import { duration, receiptsPath, thousands, type Receipt, type Span } from "@openthink/pablo-core";

/** What review shows about the run that produced a mark. */
export interface ReceiptView {
  readonly intent: string;
  readonly provider: string;
  readonly model: string;
  readonly promptHash: string;
  /** The one row the review panel prints. */
  readonly line: string;
}

/** Said when there is nothing to show, which is a fact and not a failure. */
export const NO_RECEIPT = "no receipt for this proposal";

export interface ReceiptLog {
  /** The newest receipt whose proposal covers `span` in `path`, if there is one. */
  find(path: string, span: Span): Receipt | undefined;
  /** The same, rendered for the review panel. Never `undefined`; see `NO_RECEIPT`. */
  view(path: string, span: Span): ReceiptView | undefined;
}

function overlaps(a: Span, b: Span): boolean {
  // A zero-width proposal span (an insertion at a boundary) touches the mark
  // that grew out of it, so containment counts as overlap at both ends.
  return a.start <= b.end && b.start <= a.end;
}

function parseLine(line: string): Receipt | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== "object" || value === null) return undefined;
    return value as Receipt;
  } catch {
    // A half-written last line costs one receipt, not the log.
    return undefined;
  }
}

/**
 * Render a receipt as the row the review panel shows: what was asked, who
 * answered, and what it cost. Numbers the log recorded as `null` are simply
 * absent rather than printed as zero — a receipt that measured nothing must not
 * read like one that measured nothing happening.
 */
export function receiptView(receipt: Receipt): ReceiptView {
  const parts: string[] = [receipt.intent, receipt.provider, receipt.model];
  if (receipt.prompt_hash !== "") parts.push(`prompt ${receipt.prompt_hash.slice(0, 8)}`);
  if (receipt.tokens_read !== null) parts.push(`read ${thousands(receipt.tokens_read)}`);
  if (receipt.tokens_written !== null) parts.push(`wrote ${thousands(receipt.tokens_written)}`);
  if (receipt.ttft_ms !== null) parts.push(`first token ${duration(receipt.ttft_ms)}`);
  if (receipt.gen_tok_s !== null) parts.push(`${Math.round(receipt.gen_tok_s)} tok/s`);
  parts.push(duration(receipt.wall_ms));

  return {
    intent: receipt.intent,
    provider: receipt.provider,
    model: receipt.model,
    promptHash: receipt.prompt_hash,
    line: parts.join("  ·  "),
  };
}

/**
 * The receipt log for a vault, read on demand.
 *
 * A vault root of `undefined` — a file opened outside any writing vault — is a
 * log that is always empty, which is the same answer the app gives about style
 * rules for such a file, and for the same reason.
 */
export function openReceiptLog(vaultRoot: string | undefined): ReceiptLog {
  const path = vaultRoot === undefined ? undefined : receiptsPath(vaultRoot);
  let stamp = "";
  let receipts: Receipt[] = [];

  const load = (): readonly Receipt[] => {
    if (path === undefined) return [];
    let key: string;
    try {
      const info = statSync(path);
      key = `${info.size}:${info.mtimeMs}`;
    } catch {
      // No log yet is the normal state of a vault nobody has prompted in.
      stamp = "";
      receipts = [];
      return receipts;
    }
    if (key === stamp) return receipts;

    try {
      receipts = readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line) => {
          const receipt = parseLine(line);
          return receipt === undefined ? [] : [receipt];
        });
      stamp = key;
    } catch {
      receipts = [];
      stamp = "";
    }
    return receipts;
  };

  const find = (file: string, span: Span): Receipt | undefined => {
    const all = load();
    // Appended in order, so the last match is the newest one.
    for (let index = all.length - 1; index >= 0; index -= 1) {
      const receipt = all[index];
      const proposal = receipt?.proposal;
      if (receipt === undefined || proposal === null || proposal === undefined) continue;
      if (proposal.path !== file) continue;
      if (!overlaps({ start: proposal.start, end: proposal.end }, span)) continue;
      return receipt;
    }
    return undefined;
  };

  return {
    find,
    view: (file, span) => {
      const receipt = find(file, span);
      return receipt === undefined ? undefined : receiptView(receipt);
    },
  };
}
