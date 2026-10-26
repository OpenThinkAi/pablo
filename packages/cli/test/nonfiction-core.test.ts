/**
 * The nonfiction core (AGT-2101, pm project `pablo-platform`, D-5): thesis ->
 * research -> claims (each citing a research note) -> outline, saved with
 * `pablo save --stage thesis|claims|outline`, reported by `status`/`resume`,
 * and gating `write`.
 */

import { afterEach, expect, spyOn, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { coreNext, coreStageIds, coreStages, NONFICTION_CORE_STAGE_IDS, readCoreState, trackGate } from "../src/core/machine";
import { parseClaims, parseSections } from "../src/core/nonfiction";
import { buildResume, formatResumeProse } from "../src/resume";
import { saveCore } from "../src/save";
import { TRACKS } from "../src/tracks/registry";
import { formatStatusProse, readWorkStatus } from "../src/work-state";
import { runWrite } from "../src/write";

const FIXTURE = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK = { env: { PATH: "/nonexistent-bin-for-nonfiction-test" } };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A temp copy of the fixture vault with the ice-house work switched to the nonfiction track and its fiction core removed. */
function nonfictionWork(): { vault: string; work: string } {
  const vault = mkdtempSync(join(tmpdir(), "pablo-nonfiction-test-"));
  roots.push(vault);
  cpSync(FIXTURE, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  const markerPath = join(work, "pablo.json");
  const data = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
  writeFileSync(markerPath, JSON.stringify({ ...data, track: "nonfiction" }));
  for (const dir of ["bible", "outline", "research"]) rmSync(join(work, dir), { recursive: true, force: true });
  return { vault, work };
}

function input(vault: string, text: string): string {
  const path = join(vault, `input-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(path, text);
  return path;
}

function addNote(work: string, id: string): void {
  mkdirSync(join(work, "research"), { recursive: true });
  writeFileSync(join(work, "research", `${id}.md`), `# ${id}\n\nRetrieved: 2026-10-26\n\nA note.\n\n## Sources\n\n- https://example.org/${id}\n`);
}

const CLAIMS = "| 1 | Ice was cut on the river each winter | ice-harvest |\n| 2 | Sawdust kept it through summer | ice-harvest, research/sawdust.md |\n";
const OUTLINE = "| # | Section | What it covers |\n|---|---|---|\n| 1 | The river | Where the ice came from |\n| 2 | The house | How it was kept |\n";

test("the nonfiction stages are the track registry's and coreStageIds'", () => {
  const ids = coreStages(readCoreState(nonfictionWork().work, "nonfiction")).map((s) => s.id);
  expect(ids).toEqual(["thesis", "research", "claims", "outline"]);
  expect(ids).toEqual([...NONFICTION_CORE_STAGE_IDS]);
  expect([...coreStageIds("nonfiction")]).toEqual(ids);
  expect([...TRACKS.nonfiction.coreStages] as string[]).toEqual(ids);
});

test("an empty nonfiction work is short at thesis, and no bible/acts/beats stage is reported", () => {
  const { work } = nonfictionWork();
  const status = readWorkStatus(work);
  expect(status.track).toBe("nonfiction");
  expect(status.core.stages.map((s) => s.id)).toEqual(["thesis", "research", "claims", "outline"]);
  expect(status.core.stages.every((s) => s.gate === true)).toBe(true);
  expect(status.next).toBe("core: save the thesis (pablo save --stage thesis)");
  const prose = formatStatusProse(status);
  expect(prose).toContain("  thesis: missing");
  expect(prose).toContain("  outline: 0 sections");
  expect(prose).not.toMatch(/\b(bible|acts|beats|premise):/);
});

test("save --stage thesis|claims|outline writes core/ files and status walks each stage", () => {
  const { vault, work } = nonfictionWork();

  const thesis = saveCore({ stage: "thesis", file: input(vault, "# Thesis\n\nThe ice house fed a town.\n") }, work);
  expect(thesis.body).toMatchObject({ ok: true, path: "core/thesis.md", stage: "thesis" });
  expect(readFileSync(join(work, "core", "thesis.md"), "utf8")).toContain("fed a town");
  expect(readWorkStatus(work).next).toBe("core: save sourced research notes (pablo research save)");

  addNote(work, "ice-harvest");
  expect(readWorkStatus(work).next).toBe("core: save the claims, each citing a research note (pablo save --stage claims)");

  const claims = saveCore({ stage: "claims", file: input(vault, CLAIMS) }, work);
  expect(claims.body).toMatchObject({ ok: true, path: "core/claims.md" });
  const claimsText = readFileSync(join(work, "core", "claims.md"), "utf8");
  expect(claimsText).toContain("| # | Claim | Sources |");
  expect(parseClaims(claimsText).map((c) => c.sources)).toEqual([["ice-harvest"], ["ice-harvest", "sawdust"]]);

  // `sawdust` is cited but not a note yet: the claims stage stays short, naming it.
  let status = readWorkStatus(work);
  const claimsStage = status.core.stages.find((s) => s.id === "claims");
  expect(claimsStage?.done).toBe(false);
  expect(claimsStage?.missing).toEqual(["claim 2 cites sawdust, which is not a note under research/"]);
  addNote(work, "sawdust");
  status = readWorkStatus(work);
  expect(status.core.stages.find((s) => s.id === "claims")).toMatchObject({ done: true, summary: "2 claims" });
  expect(status.next).toBe("core: save the outline sections (pablo save --stage outline)");

  const outline = saveCore({ stage: "outline", file: input(vault, OUTLINE) }, work);
  expect(outline.body).toMatchObject({ ok: true, path: "core/outline.md" });
  expect(parseSections(readFileSync(join(work, "core", "outline.md"), "utf8")).map((s) => s.section)).toEqual(["The river", "The house"]);

  status = readWorkStatus(work);
  expect(status.core.stages.every((s) => s.done)).toBe(true);
  expect(coreNext(readCoreState(work, "nonfiction"))).toBeUndefined();
  expect(trackGate(readCoreState(work, "nonfiction"))).toBeUndefined();
  expect(status.next).not.toStartWith("core:");

  // Saving again replaces the table and keeps the rest of the file.
  writeFileSync(join(work, "core", "outline.md"), `${readFileSync(join(work, "core", "outline.md"), "utf8")}\nA closing note.\n`);
  saveCore({ stage: "outline", file: input(vault, "| 1 | Only one | The lot |\n") }, work);
  const replaced = readFileSync(join(work, "core", "outline.md"), "utf8");
  expect(parseSections(replaced)).toHaveLength(1);
  expect(replaced).toContain("A closing note.");
});

test("save refuses a claim with no source, a bad row, an empty thesis and the other track's stages", () => {
  const { vault, work } = nonfictionWork();
  const unsourced = saveCore({ stage: "claims", file: input(vault, "| 1 | A bare claim |  |\n") }, work);
  expect(unsourced.exitCode).toBe(2);
  expect(unsourced.body).toMatchObject({ ok: false, message: expect.stringContaining("row 1, column 3: a claim must cite at least one research note id") });
  expect(existsSync(join(work, "core", "claims.md"))).toBe(false);

  const badOutline = saveCore({ stage: "outline", file: input(vault, "| x | Section | covers |\n") }, work);
  expect(badOutline.body).toMatchObject({ ok: false, message: expect.stringContaining("row 1, column 1") });

  const empty = saveCore({ stage: "thesis", file: input(vault, "  \n") }, work);
  expect(empty.exitCode).toBe(2);

  const acts = saveCore({ stage: "acts", file: input(vault, "| I | 1900 | x |\n") }, work);
  expect(acts.body).toMatchObject({ ok: false, message: expect.stringContaining("a nonfiction work's --stage is thesis|claims|outline") });

  // A fiction work refuses the nonfiction stages.
  const fiction = join(vault, "novels", "ice-house-fiction");
  cpSync(join(FIXTURE, "novels", "ice-house"), fiction, { recursive: true });
  const thesis = saveCore({ stage: "thesis", file: input(vault, "A thesis.\n") }, fiction);
  expect(thesis.body).toMatchObject({ ok: false, message: expect.stringContaining("--stage thesis is a nonfiction stage") });
});

test("resume reports the nonfiction core and its next action", async () => {
  const { vault, work } = nonfictionWork();
  saveCore({ stage: "thesis", file: input(vault, "The ice house fed a town.\n") }, work);
  const result = await buildResume(work, "ice-house", NO_THINK);
  expect(result.track).toBe("nonfiction");
  expect(result.core.stages.map((s) => s.id)).toEqual(["thesis", "research", "claims", "outline"]);
  expect(result.next).toBe("core: save sourced research notes (pablo research save)");
  const prose = formatResumeProse(result);
  expect(prose).toContain("  research: 0 sourced notes");
  expect(prose).not.toMatch(/\b(bible|acts|beats):/);
});

async function writeJson(vault: string, work: string): Promise<Record<string, unknown>> {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const code = await runWrite(
      { chapter: "1", words: undefined, scenes: undefined, dryRun: true, json: true, force: false },
      vault,
      work,
    );
    const body = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    return { ...body, exitCode: code };
  } finally {
    log.mockRestore();
  }
}

test("write on a nonfiction work refuses until the outline has a section, naming the short stage", async () => {
  const { vault, work } = nonfictionWork();
  saveCore({ stage: "thesis", file: input(vault, "The ice house fed a town.\n") }, work);
  addNote(work, "ice-harvest");
  addNote(work, "sawdust");
  saveCore({ stage: "claims", file: input(vault, CLAIMS) }, work);

  const refused = await writeJson(vault, work);
  expect(refused).toMatchObject({
    ok: false,
    exitCode: 2,
    message: "pablo: nonfiction: core/outline.md has no section rows",
    missing: ["core/outline.md has no section rows"],
  });

  saveCore({ stage: "outline", file: input(vault, OUTLINE) }, work);
  const after = await writeJson(vault, work);
  expect(String(after["message"] ?? "")).not.toContain("nonfiction:");
});

test("write names an earlier short stage first", async () => {
  const { vault, work } = nonfictionWork();
  const refused = await writeJson(vault, work);
  expect(refused).toMatchObject({ ok: false, exitCode: 2, message: "pablo: nonfiction: core/thesis.md has no text" });
});
