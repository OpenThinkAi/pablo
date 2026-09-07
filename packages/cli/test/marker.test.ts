import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMarker, writeMarker } from "../src/marker";
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
    expect(result.marker.author).toBe("matt");
    expect(result.marker.voice).toEqual(["../../style", "QWEN.md"]);
    expect(result.marker.neverSend).toEqual(["research/", "notes/"]);
    expect(result.marker.publish).toEqual({});
  }

  rmSync(dir, { recursive: true, force: true });
});

test("readMarker respects explicit optional values over defaults", () => {
  const dir = tempDir();
  const marker: Marker = {
    format: "novel",
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
    format: "novel",
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
