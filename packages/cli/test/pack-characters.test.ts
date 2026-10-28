/**
 * AGT-2183 (D-7, D-15, D-22): every fiction drafting pack carries each character's own bible file beside the
 * family tree, and the premise (`bible/overview.md`); a fiction essay's act section carries that act's beat rows;
 * `write --dry-run` lists both slices. Everything runs on temp copies of the synthetic fixture vaults, no model.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";
import type { Pack } from "@openthink/pablo-core";
import { readMarker } from "../src/marker";
import type { Marker } from "../src/marker";
import { buildChapterPack } from "../src/novel/pack";
import { addOutput } from "../src/output-verbs";
import { actBeatsFor, buildEssayPack } from "../src/outputs/essay/pack";
import { buildRadioPack } from "../src/outputs/radio/pack";
import { buildScreenplayPack } from "../src/outputs/screenplay/pack";
import { buildStoryPack } from "../src/outputs/story/pack";
import { useLocalConfigHome } from "./local-config";

useLocalConfigHome();

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const CONFORMANCE = fileURLToPath(new URL("./fixtures/conformance", import.meta.url));
const NOW = () => new Date("2026-10-27T12:00:00Z");

const ODILE = "# Odile Nadeau\n\n- Keeps the scale-house books in green ink.\n- Left-handed; the ledger smudges.\n";
const AARON = "# Aaron Pike\n\n- The cutting foreman, missing two fingers on his right hand.\n";

const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop() ?? "", { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
}

function commitAll(vault: string): void {
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "pablo-test@example.com");
  git(vault, "config", "user.name", "Pablo Test");
  git(vault, "config", "commit.gpgsign", "false");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
}

/** The ice-house fixture with two characters' own files beside the family tree. */
function iceHouse(): { vault: string; work: string; marker: Marker } {
  const dir = mkdtempSync(join(tmpdir(), "pablo-pack-cast-"));
  temps.push(dir);
  const vault = join(dir, "vault");
  cpSync(VAULT, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  writeFileSync(join(work, "bible", "characters", "odile-nadeau.md"), ODILE);
  writeFileSync(join(work, "bible", "characters", "aaron-pike.md"), AARON);
  const m = readMarker(work);
  if (!m.ok) throw new Error(m.message);
  return { vault, work, marker: m.marker };
}

type Built = { ok: true; pack: Pack } | { ok: false; message: string };

function packOf(r: Built): Pack {
  if (!r.ok) throw new Error(r.message);
  return r.pack;
}

const BUILDERS: Record<string, (vault: string, work: string, marker: Marker) => Built> = {
  novel: (v, w, marker) => buildChapterPack(v, w, 2, { marker }),
  story: (v, w, marker) => buildStoryPack(v, w, 1, { marker, output: "story" }),
  screenplay: (v, w, marker) => buildScreenplayPack(v, w, 2, { marker, output: "screenplay" }),
  radio: (v, w, marker) => buildRadioPack(v, w, 2, { marker }),
};

const CAST_SOURCE = [
  "novels/ice-house/bible/characters/family-tree.md",
  "novels/ice-house/bible/characters/aaron-pike.md",
  "novels/ice-house/bible/characters/odile-nadeau.md",
].join(", ");

for (const [type, build] of Object.entries(BUILDERS)) {
  test(`AGT-2183: the ${type} pack carries every character file and the premise`, () => {
    const { vault, work, marker } = iceHouse();
    const pack = packOf(build(vault, work, marker));
    const cast = pack.slices.find((s) => s.name === "cast");
    expect(cast?.source).toBe(CAST_SOURCE);
    expect(cast?.text).toContain("# Family tree");
    expect(cast?.text).toContain("missing two fingers");
    expect(cast?.text).toContain("green ink");
    const premise = pack.slices.find((s) => s.name === "premise");
    expect(premise?.source).toBe("novels/ice-house/bible/overview.md");
    expect(premise?.text).toContain("A scale-house clerk in a Maine harbor town");
  });
}

test("AGT-2183: the cast's open questions are cut from every character file, not just the family tree", () => {
  const { vault, work, marker } = iceHouse();
  writeFileSync(join(work, "bible", "characters", "odile-nadeau.md"), `${ODILE}\n## Decisions for Matt\n\n- Does Odile leave town?\n`);
  const cast = packOf(buildChapterPack(vault, work, 2, { marker })).slices.find((s) => s.name === "cast");
  expect(cast?.text).toContain("green ink");
  expect(cast?.text).not.toContain("Does Odile leave town?");
});

test("AGT-2183: write --dry-run lists the premise and cast slices with their sources", () => {
  const { vault, work } = iceHouse();
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as Record<string, unknown>;
  delete marker["format"];
  writeFileSync(join(work, "pablo.json"), `${JSON.stringify({ ...marker, outputs: { novel: { dir: "chapters", added: "2026-09-01" } } }, null, 2)}\n`);
  const tree = join(work, "bible", "characters", "family-tree.md");
  writeFileSync(tree, readFileSync(tree, "utf8").replace("Mrs. Frayne [pick]", "Mrs. Frayne"));
  commitAll(vault);
  const env = { ...process.env, PABLO_VAULT: vault };
  const json = Bun.spawnSync(["bun", "run", CLI, "write", "--project", "ice-house", "--unit", "2", "--dry-run", "--json"], { env });
  expect(json.exitCode).toBe(0);
  const body = JSON.parse(json.stdout.toString()) as { slices: { name: string; source?: string; tokens: number }[] };
  const premise = body.slices.find((s) => s.name === "premise");
  const cast = body.slices.find((s) => s.name === "cast");
  expect(premise?.source).toBe("novels/ice-house/bible/overview.md");
  expect(premise?.tokens).toBeGreaterThan(0);
  expect(cast?.source).toBe(CAST_SOURCE);
  const text = Bun.spawnSync(["bun", "run", CLI, "write", "--project", "ice-house", "--unit", "2", "--dry-run"], { env });
  expect(text.exitCode).toBe(0);
  const table = text.stdout.toString();
  expect(table).toContain("premise");
  expect(table).toContain("novels/ice-house/bible/overview.md");
  expect(table).toContain("odile-nadeau.md");
});

// The fiction essay -------------------------------------------------------------------------------------------------

const ACTS_HEADED = `# Outline

## The acts

| Act | Years | What it accomplishes |
|---|---|---|
| I | 1930 | The letter comes. |
| II | 1930 | The light goes dark. |

## Act I

| # | Story date | Title (working) | Beat | POV | Status |
|---|---|---|---|---|---|
| 1 | October 1930 | The Letter | The board's letter arrives. Ines reads it to her father in the lamp room. | Ines | outline |
| 2 | November 1930 | The Engineer | An engineer measures the tower and asks Ines where the fuel is kept. | Ines | outline |
| 3 | December 1930 | The Storm | A storm takes the power line; Ines lights the lamp by hand. | Ines | outline |

## Act II

| # | Story date | Title (working) | Beat | POV | Status |
|---|---|---|---|---|---|
| 4 | December 1930 | The Last Watch | Ines climbs the ninety steps for the last time. | Ines | outline |
`;

/** Numeric acts with every beat under one heading, as `pablo story` writes them: the beats split over the acts. */
const ACTS_FLAT = `# Outline

## The acts

| Act | Years | What it accomplishes |
|---|---|---|
| 1 | Letter | The letter comes. |
| 2 | Dark | The light goes dark. |

## Act I

| # | Story date | Title (working) | Beat | POV | Status |
|---|---|---|---|---|---|
| 1 | October 1930 | The Letter | The board's letter arrives. | Ines | outline |
| 2 | November 1930 | The Engineer | An engineer measures the tower. | Ines | outline |
| 3 | December 1930 | The Storm | A storm takes the power line. | Ines | outline |
| 4 | December 1930 | The Last Watch | Ines climbs the ninety steps for the last time. | Ines | outline |
`;

/** The conformance fixture's fiction work with `beats`, a character file of its own and the essay output added. */
function fictionEssay(beats: string): { vault: string; work: string; marker: Marker } {
  const dir = mkdtempSync(join(tmpdir(), "pablo-pack-essay-"));
  temps.push(dir);
  const vault = join(dir, "vault");
  cpSync(CONFORMANCE, vault, { recursive: true });
  const work = join(vault, "novels", "four-beats");
  writeFileSync(join(work, "outline", "beats.md"), beats);
  writeFileSync(join(work, "bible", "characters", "ines-varga.md"), "# Ines Varga\n\n- Counts the ninety steps under her breath.\n");
  commitAll(vault);
  const added = addOutput(vault, work, "essay", { now: NOW, thesis: "Automation in the story is a kind of grief." });
  if (!added.ok) throw new Error(added.message);
  const m = readMarker(work);
  if (!m.ok) throw new Error(m.message);
  return { vault, work, marker: m.marker };
}

test("AGT-2183: a fiction essay's act section carries that act's beat rows, from the act headings", () => {
  const { vault, work, marker } = fictionEssay(ACTS_HEADED);
  // Sections: 1 The story, 2 The world it is drawn from, 3 Act I, 4 Act II, 5 What the story argues.
  const act1 = packOf(buildEssayPack(vault, work, 3, { marker, output: "essay" }));
  const beats1 = act1.slices.find((s) => s.name === "actBeats");
  expect(beats1?.source).toBe("novels/four-beats/outline/beats.md");
  expect(beats1?.text).toContain('- Beat 1 (October 1930, POV Ines), "The Letter": The board\'s letter arrives.');
  expect(beats1?.text).toContain("Beat 3");
  expect(beats1?.text).not.toContain("Beat 4");

  const act2 = packOf(buildEssayPack(vault, work, 4, { marker, output: "essay" }));
  const beats2 = act2.slices.find((s) => s.name === "actBeats")?.text ?? "";
  expect(beats2).toContain('"The Last Watch"');
  expect(beats2).not.toContain("Beat 1 ");

  // A section that is not an act's has no beat rows.
  const story = packOf(buildEssayPack(vault, work, 1, { marker, output: "essay" }));
  expect(story.slices.map((s) => s.name)).not.toContain("actBeats");

  // The essay carries the premise (as the story it is about) and every character file too.
  expect(act1.slices.find((s) => s.name === "cast")?.text).toContain("ninety steps under her breath");
  expect(act1.slices.find((s) => s.name === "subject")?.source ?? act1.slices.find((s) => s.name === "thesis")?.source).toBeDefined();
  expect(act1.prompt).toContain("A lighthouse keeper's daughter keeps the lamp lit");
});

test("AGT-2183: with every beat under one heading the beats split over the acts in order, and the acts table is never a beat", () => {
  const { vault, work, marker } = fictionEssay(ACTS_FLAT);
  const act1 = packOf(buildEssayPack(vault, work, 3, { marker, output: "essay" })).slices.find((s) => s.name === "actBeats")?.text ?? "";
  expect(act1).toContain('"The Letter"');
  expect(act1).toContain('"The Engineer"');
  expect(act1).not.toContain('"The Storm"');
  expect(act1).not.toContain("Letter |");
  const act2 = packOf(buildEssayPack(vault, work, 4, { marker, output: "essay" })).slices.find((s) => s.name === "actBeats")?.text ?? "";
  expect(act2).toContain('"The Storm"');
  expect(act2).toContain('"The Last Watch"');
  expect(act2).not.toContain('"The Letter"');
  expect(actBeatsFor(work, "fiction", { number: 9, title: "Coda", covers: "" }, "x")).toBeUndefined();
});
