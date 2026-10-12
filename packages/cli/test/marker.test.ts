import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outputsLabel, readMarker, writeMarker } from "../src/marker";
import type { Marker } from "../src/marker";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pablo-marker-test-"));
}

test("readMarker on a directory with no pablo.json refuses, pointing at init --adopt", () => {
  const dir = tempDir();
  const result = readMarker(dir);

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(2);
    expect(result.message).toContain("no pablo.json");
    expect(result.message).toContain("pablo init --adopt --project");
    expect(result.tried).toEqual([join(dir, "pablo.json")]);
  }

  rmSync(dir, { recursive: true, force: true });
});

test("readMarker rejects an unknown format, naming it", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "pablo.json"), JSON.stringify({ format: "screenplay", title: "T", slug: "t" }));

  const result = readMarker(dir);

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(2);
    expect(result.message).toContain('"screenplay"');
  }

  rmSync(dir, { recursive: true, force: true });
});

test("readMarker rejects a missing required key, naming it", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "pablo.json"), JSON.stringify({ format: "novel", title: "T" })); // no slug

  const result = readMarker(dir);

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(2);
    expect(result.message).toContain('"slug"');
  }

  rmSync(dir, { recursive: true, force: true });
});

test("readMarker rejects invalid JSON", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "pablo.json"), "{ not json");

  const result = readMarker(dir);

  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe(2);

  rmSync(dir, { recursive: true, force: true });
});

test("readMarker fills in defaults for optional keys", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "pablo.json"), JSON.stringify({ format: "novel", title: "T", slug: "t" }));

  const result = readMarker(dir);

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.marker.author).toBe("author");
    expect(result.marker.voice).toEqual(["../../style", "QWEN.md"]);
    expect(result.marker.neverSend).toEqual(["research/", "notes/"]);
    expect(result.marker.publish).toEqual({});
  }

  rmSync(dir, { recursive: true, force: true });
});

test("readMarker respects explicit optional values over defaults", () => {
  const dir = tempDir();
  const marker: Marker = {
    outputs: { novel: { dir: "chapters", added: "2026-10-10" } },
    title: "T",
    slug: "t",
    author: "someone-else",
    voice: ["custom/voice"],
    neverSend: ["private/"],
    publish: { final: "artifact" },
  };
  writeMarker(dir, marker);

  const result = readMarker(dir);

  expect(result.ok).toBe(true);
  if (result.ok) expect(result.marker).toEqual(marker);

  rmSync(dir, { recursive: true, force: true });
});

test("writeMarker then readMarker round-trips", () => {
  const dir = tempDir();
  const marker: Marker = {
    outputs: { novel: { dir: "chapters", added: "2026-10-10" } },
    title: "Round Trip",
    slug: "round-trip",
    author: "matt",
    voice: ["../../style", "QWEN.md"],
    neverSend: ["research/", "notes/"],
    publish: {},
  };

  writeMarker(dir, marker);
  const result = readMarker(dir);

  expect(result.ok).toBe(true);
  if (result.ok) expect(result.marker).toEqual(marker);

  rmSync(dir, { recursive: true, force: true });
});

// --- AGT-1666: `outputs` replaces `format` ---------------------------------

function markerIn(data: unknown): string {
  const dir = tempDir();
  writeFileSync(join(dir, "pablo.json"), JSON.stringify(data));
  return dir;
}

test("an unmigrated format:novel marker reads as outputs.novel {dir: chapters}, with a notice naming pablo migrate outputs", () => {
  const dir = markerIn({ format: "novel", title: "T", slug: "t" });
  const result = readMarker(dir);

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.marker.outputs).toEqual({ novel: { dir: "chapters" } });
    expect(result.marker).not.toHaveProperty("format");
    expect(result.deprecated).toContain("pablo migrate outputs --project t");
    expect(result.deprecated).toContain('"format"');
  }
  rmSync(dir, { recursive: true, force: true });
});

test("a migrated marker reads its outputs, keeps an entry's own keys, and carries no notice", () => {
  const outputs = { novel: { dir: "chapters", added: "2026-09-01", note: "kept" } };
  const dir = markerIn({ title: "T", slug: "t", outputs });
  const result = readMarker(dir);

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.marker.outputs).toEqual(outputs);
    expect(result.deprecated).toBeUndefined();
  }
  rmSync(dir, { recursive: true, force: true });
});

test("a marker with neither format nor outputs is a core with nothing derived yet", () => {
  const dir = markerIn({ title: "T", slug: "t" });
  const result = readMarker(dir);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.marker.outputs).toEqual({});
    expect(outputsLabel(result.marker)).toBe("core");
  }
  rmSync(dir, { recursive: true, force: true });
});

test("outputsLabel names the work's outputs", () => {
  const dir = markerIn({ format: "novel", title: "T", slug: "t" });
  const result = readMarker(dir);
  if (result.ok) expect(outputsLabel(result.marker)).toBe("novel");
  rmSync(dir, { recursive: true, force: true });
});

test("a marker with both format and outputs is a refusal naming both keys", () => {
  const dir = markerIn({ format: "novel", title: "T", slug: "t", outputs: { novel: { dir: "chapters", added: "2026-10-10" } } });
  const result = readMarker(dir);

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(2);
    expect(result.message).toContain('"format"');
    expect(result.message).toContain('"outputs"');
  }
  rmSync(dir, { recursive: true, force: true });
});

test("an unknown output type is a refusal naming the key", () => {
  const dir = markerIn({ title: "T", slug: "t", outputs: { screenplay: { added: "2026-10-10" } } });
  const result = readMarker(dir);

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(2);
    expect(result.message).toContain('"screenplay"');
    expect(result.message).toContain('"outputs.screenplay"');
  }
  rmSync(dir, { recursive: true, force: true });
});

test("malformed outputs entries are refused by their exact key", () => {
  const cases: [unknown, string][] = [
    [["novel"], '"outputs"'],
    [{ novel: "chapters" }, '"outputs.novel"'],
    [{ novel: { dir: "chapters" } }, '"outputs.novel.added"'],
    [{ novel: { dir: "chapters", added: "yesterday" } }, '"outputs.novel.added"'],
    [{ novel: { dir: "manuscript", added: "2026-10-10" } }, '"outputs.novel.dir"'],
  ];
  for (const [outputs, key] of cases) {
    const dir = markerIn({ title: "T", slug: "t", outputs });
    const result = readMarker(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(2);
      expect(result.message).toContain(key);
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
