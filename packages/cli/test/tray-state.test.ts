import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toTrayPieces, writeTrayState } from "../src/tray/state";
import type { TrayState } from "../src/tray/state";
import type { PieceRecord } from "../src/review";

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function useTempDir(): string {
  dir = mkdtempSync(join(tmpdir(), "pablo-tray-state-"));
  return dir;
}

function record(overrides: Partial<PieceRecord> = {}): PieceRecord {
  return {
    id: "20260907-hello-abcd",
    at: "2026-09-07T10:00:00.000Z",
    kind: "chapter",
    title: "Hello",
    path: "/tmp/hello.md",
    vault: "/tmp/vault",
    project: "my-novel",
    words: 500,
    prompt_hash: "deadbeef",
    ...overrides,
  };
}

describe("toTrayPieces", () => {
  test("drops every field but id, kind, title, words, at", () => {
    const pieces = toTrayPieces([record()]);
    expect(pieces).toEqual([
      {
        id: "20260907-hello-abcd",
        kind: "chapter",
        title: "Hello",
        words: 500,
        at: "2026-09-07T10:00:00.000Z",
      },
    ]);
    // Nothing beyond that field set leaks through.
    expect(Object.keys(pieces[0]!).sort()).toEqual(["at", "id", "kind", "title", "words"]);
  });

  test("orders newest `at` first", () => {
    const oldest = record({ id: "a", at: "2026-09-01T00:00:00.000Z" });
    const newest = record({ id: "b", at: "2026-09-07T00:00:00.000Z" });
    const middle = record({ id: "c", at: "2026-09-04T00:00:00.000Z" });

    const pieces = toTrayPieces([oldest, newest, middle]);

    expect(pieces.map((piece) => piece.id)).toEqual(["b", "c", "a"]);
  });

  test("does not mutate the input array", () => {
    const records = [record({ id: "a", at: "2026-09-01T00:00:00.000Z" }), record({ id: "b", at: "2026-09-07T00:00:00.000Z" })];
    const copy = [...records];
    toTrayPieces(records);
    expect(records).toEqual(copy);
  });

  test("empty input yields empty output", () => {
    expect(toTrayPieces([])).toEqual([]);
  });
});

describe("writeTrayState", () => {
  function state(overrides: Partial<TrayState> = {}): TrayState {
    return {
      daemonPid: 4242,
      version: "0.1.0",
      pending: [],
      ...overrides,
    };
  }

  test("produces valid JSON matching the given state, with no leftover temp file", () => {
    const base = useTempDir();
    const path = join(base, "tray-state.json");

    writeTrayState(path, state({ pending: [{ id: "a", kind: "prose", title: "Hi", words: 12, at: "2026-09-07T00:00:00.000Z" }] }));

    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed).toEqual({
      daemonPid: 4242,
      version: "0.1.0",
      pending: [{ id: "a", kind: "prose", title: "Hi", words: 12, at: "2026-09-07T00:00:00.000Z" }],
    });

    const leftovers = readdirSync(base).filter((name) => name.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  test("creates the directory when missing", () => {
    const base = useTempDir();
    const path = join(base, "nested", "deeper", "tray-state.json");

    writeTrayState(path, state());

    expect(existsSync(path)).toBe(true);
  });

  test("a rewrite replaces the content rather than merging it", () => {
    const base = useTempDir();
    const path = join(base, "tray-state.json");

    writeTrayState(path, state({ lastError: "boom" }));
    writeTrayState(path, state({ version: "0.2.0" }));

    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed).toEqual({ daemonPid: 4242, version: "0.2.0", pending: [] });
    expect(parsed.lastError).toBeUndefined();

    const leftovers = readdirSync(base).filter((name) => name.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
