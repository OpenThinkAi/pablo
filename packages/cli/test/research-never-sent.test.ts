import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { readMarker } from "../src/marker";
import { buildChapterPack } from "../src/novel/pack";
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
