import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readMarker } from "../src/marker";
import { buildChapterPack } from "../src/novel/pack";

/**
 * The same synthetic fixture `machine.test.ts` uses: `ice-house`, 4 beats, 1
 * written chapter. Chapter 2's beat (story date "Winter 1931") is ready —
 * chapter 1 is written, the timeline covers 1931, and no `[pick]` row names
 * it (the fixture's one `[pick]`, "Mrs. Frayne", is only in beat 3's text) —
 * so it is the chapter these tests build a pack for.
 */
const VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));

function tempVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-pack-test-"));
  const vault = join(dir, "vault");
  cpSync(VAULT, vault, { recursive: true });
  return vault;
}

function markerFor(workDir: string) {
  const result = readMarker(workDir);
  if (!result.ok) throw new Error(`fixture marker should be valid: ${result.message}`);
  return result.marker;
}

test("buildChapterPack assembles a pack for chapter 2 with the beat, style, and timeline slices", () => {
  const vault = tempVault();
  const workDir = join(vault, "novels", "ice-house");

  const result = buildChapterPack(vault, workDir, 2, { marker: markerFor(workDir) });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.pack.kind).toBe("drafting");
  expect(result.pack.slices.map((slice) => slice.name)).toContain("style");
  expect(result.pack.slices.map((slice) => slice.name)).toContain("timeline");
  expect(result.pack.totalTokens).toBeGreaterThan(0);
  expect(result.pack.hash).toMatch(/^[0-9a-f]{64}$/);

  rmSync(vault, { recursive: true, force: true });
});

test("the voice filter drops an agent-facing style section but keeps the prose rules", () => {
  const vault = tempVault();
  const workDir = join(vault, "novels", "ice-house");

  const result = buildChapterPack(vault, workDir, 2, { marker: markerFor(workDir) });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.pack.prompt).not.toContain("SENTINEL-SHOULD-NEVER-REACH-A-PACK");
  // A sentence from a kept prose section (`## Concrete over abstract`) survives.
  expect(result.pack.prompt).toContain("Name the thing.");

  rmSync(vault, { recursive: true, force: true });
});

test("a neverSend prefix that covers a slice's source is a refusal naming the slice and the prefix", () => {
  const vault = tempVault();
  const workDir = join(vault, "novels", "ice-house");
  const markerPath = join(workDir, "pablo.json");
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  // `bible/` covers the cast, places, and timeline slices this fixture's
  // chapter 2 pack draws on — an easy, real collision to plant.
  marker.neverSend = ["bible/"];
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");

  const result = buildChapterPack(vault, workDir, 2, { marker: markerFor(workDir) });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.code).toBe(2);
  expect(result.message).toContain("bible/");
  expect(result.message).toMatch(/slice "(cast|places|timeline)"/);

  rmSync(vault, { recursive: true, force: true });
});

test("the shared style/ files are never flagged by a neverSend prefix that only covers work-relative paths", () => {
  const vault = tempVault();
  const workDir = join(vault, "novels", "ice-house");
  const markerPath = join(workDir, "pablo.json");
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  // "style/" is work-relative (it would mean `<work>/style/`, which does not
  // exist); the shared `<vault>/style/` is outside the work dir entirely and
  // must not be caught by it.
  marker.neverSend = ["style/"];
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");

  const result = buildChapterPack(vault, workDir, 2, { marker: markerFor(workDir) });

  expect(result.ok).toBe(true);

  rmSync(vault, { recursive: true, force: true });
});

test("two builds from the same inputs produce the same prompt_hash", () => {
  const vault = tempVault();
  const workDir = join(vault, "novels", "ice-house");
  const marker = markerFor(workDir);

  const first = buildChapterPack(vault, workDir, 2, { marker });
  const second = buildChapterPack(vault, workDir, 2, { marker });

  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  if (!first.ok || !second.ok) throw new Error("unreachable");
  expect(first.pack.hash).toBe(second.pack.hash);
  expect(first.pack.prompt).toBe(second.pack.prompt);

  rmSync(vault, { recursive: true, force: true });
});

test("--words and --scenes pass through to the pack's word target and minimum scene count", () => {
  const vault = tempVault();
  const workDir = join(vault, "novels", "ice-house");
  const marker = markerFor(workDir);

  const result = buildChapterPack(vault, workDir, 2, { marker, words: 900, scenes: 5 });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.inputs.wordTarget).toBe(900);
  expect(result.inputs.minScenes).toBe(5);
  expect(result.pack.prompt).toContain("about 900 words");
  expect(result.pack.prompt).toContain("at least 5 scenes");

  rmSync(vault, { recursive: true, force: true });
});
