/**
 * The `claim-support` check for nonfiction (AGT-2114, pm project `pablo-platform`, D-5, D-10): each factual claim in
 * a unit traces to a `core/claims.md` row or a research note, and a claim that traces carries its citation. Claim
 * detection is driven through the `isClaim` seam with a fake; no model is involved.
 */

import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWork } from "../src/check";
import { checkClaimSupport, citationsIn, looksFactual, sentencesOf } from "../src/claim-support";
import type { ClaimSources, ClaimSupportSeam } from "../src/claim-support";
import { parseClaims } from "../src/core/nonfiction";

const FIXTURE = fileURLToPath(new URL("./fixtures/vault", import.meta.url));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CLAIMS_MD =
  "| # | Claim | Sources |\n|---|---|---|\n" +
  "| 1 | Ice was cut on the river each winter | ice-harvest |\n" +
  "| 2 | Sawdust kept the ice through summer | ice-harvest, research/sawdust.md |\n";

const NOTE_ICE = "# Ice harvest\n\nRetrieved: 2026-10-26\n\nCrews sawed blocks from the frozen river in January and hauled them by sledge.\n\n## Sources\n\n- https://example.org/ice\n";
const NOTE_SAWDUST = "# Sawdust\n\nRetrieved: 2026-10-26\n\nMill sawdust packed between blocks insulated the stack.\n\n## Sources\n\n- https://example.org/sawdust\n";

const SOURCES: ClaimSources = {
  claims: parseClaims(CLAIMS_MD),
  notes: [
    { id: "ice-harvest", text: NOTE_ICE },
    { id: "sawdust", text: NOTE_SAWDUST },
  ],
};

/** The fake seam: a sentence is a claim exactly when it is listed. */
function fakeSeam(claims: readonly string[]): ClaimSupportSeam & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    isClaim: (sentence) => {
      asked.push(sentence);
      return claims.includes(sentence);
    },
  };
}

test("a cited claim that resolves to a claims row or a research note is supported: no hit", () => {
  const unit = "---\ntitle: one\n---\n\nIce was cut on the river each winter [#1].\nCrews sawed blocks from the frozen river [@ice-harvest].\n";
  const seam = fakeSeam([]);
  expect(checkClaimSupport(unit, "chapters/01.md", SOURCES, seam)).toEqual([]);
  // A sentence with a citation is checked without asking the seam.
  expect(seam.asked).toEqual([]);
});

test("an unsupported claim is flagged with its sentence and the nearest candidate source", () => {
  const sentence = "River ice grew thick by early December.";
  const hits = checkClaimSupport(`${sentence}\n`, "chapters/01.md", SOURCES, fakeSeam([sentence]));
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({ path: "chapters/01.md", line: 1, rule: "claim-unsupported", excerpt: sentence });
  expect(hits[0]?.detail).toBe('nearest source: core/claims.md #1 "Ice was cut on the river each winter"');
});

test("an unsupported claim with nothing near it says so", () => {
  const sentence = "Telegraph operators earned twelve dollars weekly.";
  const hits = checkClaimSupport(sentence, "u.md", SOURCES, fakeSeam([sentence]));
  expect(hits).toEqual([{ path: "u.md", line: 1, rule: "claim-unsupported", excerpt: sentence, detail: "no candidate source" }]);
});

test("a claim that traces to a source but carries no citation is flagged uncited, naming the citation to add", () => {
  const row = "Sawdust kept the ice through summer.";
  const note = "Mill sawdust insulated the stacked blocks.";
  const hits = checkClaimSupport(`Intro line.\n${row} ${note}\n`, "u.md", SOURCES, fakeSeam([row, note]));
  expect(hits).toEqual([
    {
      path: "u.md",
      line: 2,
      rule: "claim-uncited",
      excerpt: row,
      detail: 'traces to core/claims.md #2 "Sawdust kept the ice through summer"; cite [#2] or [@ice-harvest] or [@sawdust]',
    },
    { path: "u.md", line: 2, rule: "claim-uncited", excerpt: note, detail: "traces to research/sawdust.md; cite [@sawdust]" },
  ]);
});

test("a sentence the seam says is no claim is never a hit, however unsourced", () => {
  expect(checkClaimSupport("The cold felt endless.\n", "u.md", SOURCES, fakeSeam([]))).toEqual([]);
});

test("a citation that resolves to nothing is checked as uncited and the dangling target is named", () => {
  const sentence = "Sawdust kept the ice through summer [@no-such-note].";
  const hits = checkClaimSupport(sentence, "u.md", SOURCES, fakeSeam([]));
  expect(hits).toHaveLength(1);
  expect(hits[0]?.rule).toBe("claim-uncited");
  expect(hits[0]?.detail).toContain("cites [@no-such-note], which is no research note or claims row");
});

test("frontmatter, headings and fenced code are not read as claims", () => {
  const unit = "---\nmodel: x\n---\n# Founded in 1850\n\n```\nBuilt in 1901.\n```\n";
  expect(checkClaimSupport(unit, "u.md", SOURCES, { isClaim: () => true })).toEqual([]);
});

test("citationsIn reads @note and #row tokens and ignores ordinary brackets", () => {
  expect(citationsIn("A [@research/ice-harvest.md; #2] b [an aside] c [#x]")).toEqual([
    { kind: "note", id: "ice-harvest" },
    { kind: "row", number: 2 },
  ]);
});

test("sentencesOf splits after a citation and a closing quote", () => {
  expect(sentencesOf('It froze [@ice-harvest]. "Then it thawed." Done.')).toEqual(["It froze [@ice-harvest].", '"Then it thawed."', "Done."]);
});

test("the default detector: numbers, mid-sentence names and reporting cues are claims; questions and plain feeling are not", () => {
  expect(looksFactual("The house held 400 tons.")).toBe(true);
  expect(looksFactual("Crews came up from Albany each year.")).toBe(true);
  expect(looksFactual("It was the largest ice house on the river.")).toBe(true);
  expect(looksFactual("How much ice did they cut?")).toBe(false);
  expect(looksFactual("The cold felt endless.")).toBe(false);
  expect(looksFactual("I think it mattered.")).toBe(false);
});

/** A temp copy of the fixture vault's ice-house work on the given track, with a claims table, notes and one unit. */
function work(track: string, unit: string): { vault: string; work: string } {
  const vault = mkdtempSync(join(tmpdir(), "pablo-claim-support-test-"));
  roots.push(vault);
  cpSync(FIXTURE, vault, { recursive: true });
  const dir = join(vault, "novels", "ice-house");
  const markerPath = join(dir, "pablo.json");
  const data = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
  writeFileSync(markerPath, JSON.stringify({ ...data, track }));
  rmSync(join(dir, "research"), { recursive: true, force: true });
  mkdirSync(join(dir, "research"), { recursive: true });
  mkdirSync(join(dir, "core"), { recursive: true });
  writeFileSync(join(dir, "core", "claims.md"), CLAIMS_MD);
  writeFileSync(join(dir, "research", "ice-harvest.md"), NOTE_ICE);
  writeFileSync(join(dir, "research", "sawdust.md"), NOTE_SAWDUST);
  rmSync(join(dir, "chapters"), { recursive: true, force: true });
  mkdirSync(join(dir, "chapters"), { recursive: true });
  writeFileSync(join(dir, "chapters", "01-river.md"), unit);
  return { vault, work: dir };
}

const UNIT =
  "---\ntitle: The river\n---\n\n" +
  "Ice was cut on the river each winter [#1].\n" +
  "Sawdust from the Hudson mills kept the ice through summer.\n" +
  "The company shipped 9000 tons to Boston in 1871.\n";

test("checkWork on a nonfiction work puts claim-support hits in hits[]", () => {
  const { vault, work: dir } = work("nonfiction", UNIT);
  const outcome = checkWork(vault, dir);
  if (!outcome.ok) throw new Error(outcome.message);
  const claims = outcome.hits.filter((hit) => hit.rule.startsWith("claim-"));
  expect(claims.map((hit) => [hit.line, hit.rule])).toEqual([
    [6, "claim-uncited"],
    [7, "claim-unsupported"],
  ]);
  expect(claims[0]?.path).toBe(join("chapters", "01-river.md"));
});

test("checkWork on a fiction work runs no claim-support check", () => {
  const { vault, work: dir } = work("fiction", UNIT);
  const outcome = checkWork(vault, dir);
  if (!outcome.ok) throw new Error(outcome.message);
  expect(outcome.hits.filter((hit) => hit.rule.startsWith("claim-"))).toEqual([]);
});
