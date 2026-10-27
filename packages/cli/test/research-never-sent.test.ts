import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { renderPeriodFacts } from "../src/distill";
import { readMarker } from "../src/marker";
import type { Marker } from "../src/marker";
import { buildChapterPack } from "../src/novel/pack";
import { buildRadioPack } from "../src/outputs/radio/pack";
import { buildScreenplayPack } from "../src/outputs/screenplay/pack";
import { buildStoryPack } from "../src/outputs/story/pack";
import { assembleRevise } from "../src/revise";

/**
 * AGT-1559: nothing under `research/` ever enters a Gemma pack. Every pack
 * kind reads through the same style / work-rules / beat / chapter readers;
 * this plants a canary in `research/` and asserts no slice names that path
 * and no prompt carries the canary, even with `neverSend` emptied (so the
 * guarantee is that the readers never look there, not only the refusal).
 */
const VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const CANARY = "RESEARCH-CANARY-REAL-NAME-Halvorsen";

function plantedVault() {
  const dir = mkdtempSync(join(tmpdir(), "pablo-research-never-"));
  const vault = join(dir, "vault");
  cpSync(VAULT, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  mkdirSync(join(work, "research"), { recursive: true });
  writeFileSync(join(work, "research", "people.md"), `${CANARY}\n`);
  writeFileSync(join(vault, "research-note.md"), "unrelated\n");
  return { dir, vault, work };
}

function underResearch(source: string | undefined): boolean {
  return source !== undefined && source.split(", ").some((p) => /(^|\/)research\//.test(p));
}

test("drafting pack never includes a research/ path or its text", () => {
  const { dir, vault, work } = plantedVault();
  const m = readMarker(work);
  if (!m.ok) throw new Error(m.message);
  for (const neverSend of [m.marker.neverSend, []]) {
    const r = buildChapterPack(vault, work, 2, { marker: { ...m.marker, neverSend } });
    if (!r.ok) throw new Error(r.message);
    expect(r.pack.slices.some((s) => underResearch(s.source))).toBe(false);
    expect(r.pack.prompt).not.toContain(CANARY);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("AGT-1700: the radio writer's pack never includes a research/ path or its text", () => {
  const { dir, vault, work } = plantedVault();
  const m = readMarker(work);
  if (!m.ok) throw new Error(m.message);
  for (const neverSend of [m.marker.neverSend, []]) {
    const r = buildRadioPack(vault, work, 2, { marker: { ...m.marker, neverSend } });
    if (!r.ok) throw new Error(r.message);
    expect(r.pack.slices.some((s) => underResearch(s.source))).toBe(false);
    expect(r.pack.prompt).not.toContain(CANARY);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("revise pack never includes a research/ path or its text", () => {
  const { dir, vault, work } = plantedVault();
  writeFileSync(join(work, "03-test.md"), "First paragraph here.\n\nSecond paragraph here.\n");
  const r = assembleRevise(vault, work, { file: "03-test.md", span: { start: 0, end: 21 }, instruction: "tighten" });
  if (!r.ok) throw new Error(JSON.stringify(r));
  const { pack } = r;
  expect(pack.slices.some((s) => underResearch(s.source))).toBe(false);
  expect(pack.prompt).not.toContain(CANARY);
  rmSync(dir, { recursive: true, force: true });
});

test("AGT-2110: the story and screenplay packs never include a research/ path or its text", () => {
  const { dir, vault, work } = plantedVault();
  const m = readMarker(work);
  if (!m.ok) throw new Error(m.message);
  for (const neverSend of [m.marker.neverSend, []]) {
    const marker = { ...m.marker, neverSend };
    for (const r of [
      buildStoryPack(vault, work, 1, { marker, output: "story" }),
      buildScreenplayPack(vault, work, 2, { marker, output: "screenplay" }),
    ]) {
      if (!r.ok) throw new Error(r.message);
      expect(r.pack.slices.some((s) => underResearch(s.source))).toBe(false);
      expect(r.pack.prompt).not.toContain(CANARY);
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

/**
 * AGT-2110 (D-10): on a `realNames: false` work the research name never reaches any drafting pack, even when a
 * hand-edited `facts/period.md` row carries it: the pack swaps it for the bible's name `research/names.md` maps it
 * to, and a research name anywhere else in the pack is a refusal.
 */
function namedVault() {
  const planted = plantedVault();
  writeFileSync(join(planted.work, "research", "names.md"), `| Research name | Bible name |\n| --- | --- |\n| ${CANARY} | Ezra Sprague |\n`);
  mkdirSync(join(planted.work, "facts"), { recursive: true });
  writeFileSync(
    join(planted.work, "facts", "period.md"),
    renderPeriodFacts([{ fact: `${CANARY} bought the cannery's ice by the ton.`, source: "people", date: "1929" }]),
  );
  const m = readMarker(planted.work);
  if (!m.ok) throw new Error(m.message);
  return { ...planted, marker: { ...m.marker, realNames: false } };
}

function everyDraftPack(vault: string, work: string, marker: Marker) {
  return [
    buildChapterPack(vault, work, 2, { marker }),
    buildRadioPack(vault, work, 2, { marker }),
    buildStoryPack(vault, work, 1, { marker, output: "story" }),
    buildScreenplayPack(vault, work, 2, { marker, output: "screenplay" }),
  ];
}

test("AGT-2110: on a realNames: false work the canary research name never appears in any pack", () => {
  const { dir, vault, work, marker } = namedVault();
  for (const r of everyDraftPack(vault, work, marker)) {
    if (!r.ok) throw new Error(r.message);
    expect(r.pack.prompt).not.toContain(CANARY);
    expect(r.pack.prompt).toContain("Ezra Sprague bought the cannery's ice by the ton.");
    expect(r.pack.periodFacts).toBe(1);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("AGT-2110: a research name elsewhere in a realNames: false pack is a refusal, never sent", () => {
  const { dir, vault, work, marker } = namedVault();
  writeFileSync(join(work, "bible", "places.md"), `# Places\n\n## The wharf\n\nOwned by ${CANARY}.\n`);
  for (const r of everyDraftPack(vault, work, marker)) {
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("realNames: false");
  }
  // A work that allows real names drafts as before.
  for (const r of everyDraftPack(vault, work, { ...marker, realNames: true })) expect(r.ok).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});
