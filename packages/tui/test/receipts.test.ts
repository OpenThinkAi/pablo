import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { receiptsPath, type Receipt } from "@openthink/pablo-core";
import { NO_RECEIPT, openReceiptLog, receiptView } from "../src/receipts";

/**
 * Reading `<vault>/.pablo/receipts.jsonl` back for the review queue (AC5).
 *
 * The log is append-only machine state written by another process's crash-prone
 * moment, so the interesting cases are all the malformed ones: a truncated last
 * line, a log that is not there, a vault that is not there.
 */

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop() ?? "", { recursive: true, force: true });
});

const MANUSCRIPT = "/tmp/vault/novels/x/chapters/01.md";

function receipt(over: Partial<Receipt> = {}): Receipt {
  return {
    at: "2026-09-02T04:00:00.000Z",
    intent: "tighten",
    pack_kind: "spanEdit",
    prompt_hash: "3f9a1c2ed4b5a6f7",
    slices: [],
    provider: "local",
    model: "gemma-4-31b",
    params: {},
    tokens_read: 4900,
    tokens_written: 1500,
    ttft_ms: 19_000,
    gen_tok_s: 30.4,
    wall_ms: 69_000,
    measurement: "stream",
    proposal: { path: MANUSCRIPT, start: 100, end: 140, variants: 1 },
    error: null,
    ...over,
  };
}

function vault(): { root: string; append(value: string): void } {
  const root = mkdtempSync(join(tmpdir(), "pablo-receipts-"));
  directories.push(root);
  mkdirSync(join(root, ".pablo"), { recursive: true });
  return {
    root,
    append: (value: string) => appendFileSync(receiptsPath(root), value, "utf8"),
  };
}

test("the newest receipt whose proposal covers the mark wins (AC5)", () => {
  const space = vault();
  space.append(`${JSON.stringify(receipt({ model: "older" }))}\n`);
  space.append(`${JSON.stringify(receipt({ model: "newer" }))}\n`);

  const log = openReceiptLog(space.root);
  expect(log.find(MANUSCRIPT, { start: 110, end: 120 })?.model).toBe("newer");
  // Touching at an edge counts: a zero-width insertion grew into the mark.
  expect(log.find(MANUSCRIPT, { start: 140, end: 180 })?.model).toBe("newer");
  // A span nowhere near it does not.
  expect(log.find(MANUSCRIPT, { start: 400, end: 420 })).toBeUndefined();
  // Nor does the same span in another file.
  expect(log.find("/tmp/vault/novels/x/chapters/02.md", { start: 110, end: 120 })).toBeUndefined();
});

test("a receipt with no proposal is never matched to a mark (AC5)", () => {
  const space = vault();
  space.append(`${JSON.stringify(receipt({ proposal: null }))}\n`);
  expect(openReceiptLog(space.root).find(MANUSCRIPT, { start: 100, end: 140 })).toBeUndefined();
});

test("a truncated last line costs one receipt, not the log (AC5)", () => {
  const space = vault();
  space.append(`${JSON.stringify(receipt({ model: "intact" }))}\n`);
  space.append('{"at":"2026-09-02T04:01:00.000Z","inte');

  expect(openReceiptLog(space.root).find(MANUSCRIPT, { start: 100, end: 140 })?.model).toBe("intact");
});

test("no log, and no vault, are 'no receipt' rather than errors (AC5)", () => {
  const empty = mkdtempSync(join(tmpdir(), "pablo-receipts-none-"));
  directories.push(empty);

  expect(openReceiptLog(empty).find(MANUSCRIPT, { start: 0, end: 10 })).toBeUndefined();
  expect(openReceiptLog(empty).view(MANUSCRIPT, { start: 0, end: 10 })).toBeUndefined();
  // A file opened outside any writing vault has nowhere to look, and says so
  // the same way rather than throwing.
  expect(openReceiptLog(undefined).find(MANUSCRIPT, { start: 0, end: 10 })).toBeUndefined();
});

test("the log is re-read when it grows, and not before (AC5)", () => {
  const space = vault();
  space.append(`${JSON.stringify(receipt({ model: "first" }))}\n`);

  const log = openReceiptLog(space.root);
  expect(log.find(MANUSCRIPT, { start: 100, end: 140 })?.model).toBe("first");

  space.append(`${JSON.stringify(receipt({ model: "second" }))}\n`);
  expect(log.find(MANUSCRIPT, { start: 100, end: 140 })?.model).toBe("second");

  // A log that vanished under the reader is empty, not stale and not fatal.
  writeFileSync(receiptsPath(space.root), "", "utf8");
  rmSync(receiptsPath(space.root));
  expect(log.find(MANUSCRIPT, { start: 100, end: 140 })).toBeUndefined();
});

test("the receipt line says what was measured and omits what was not (AC5)", () => {
  const full = receiptView(receipt());
  expect(full.line).toContain("tighten");
  expect(full.line).toContain("local");
  expect(full.line).toContain("gemma-4-31b");
  expect(full.line).toContain("prompt 3f9a1c2e");
  expect(full.line).toContain("read 4,900");
  expect(full.line).toContain("wrote 1,500");
  expect(full.line).toContain("30 tok/s");
  expect(full.intent).toBe("tighten");
  expect(full.promptHash).toBe("3f9a1c2ed4b5a6f7");

  // A `measurement: "wall"` receipt has no rate and no time to first token, and
  // must not read as one that measured them at zero.
  const wall = receiptView(
    receipt({ measurement: "wall", ttft_ms: null, gen_tok_s: null, tokens_written: null }),
  );
  expect(wall.line).not.toContain("tok/s");
  expect(wall.line).not.toContain("first token");
  expect(wall.line).not.toContain("wrote");
  expect(wall.line).toContain("read 4,900");

  expect(NO_RECEIPT).toContain("no receipt");
});
