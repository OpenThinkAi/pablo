/**
 * The `screenplay` output type (AGT-2132, pm project `pablo-platform`, D-7).
 *
 * AC1: registered for fiction and historical-fiction; units are scenes in
 *      `outputs/screenplay/scenes/NN-*.fountain`, one per core beat.
 * AC2: the `screenplay` storage mode: `write` keeps the Fountain line for line.
 * AC3: the pack carries the screenplay RULES (valid Fountain); the Fountain
 *      lint flags malformed scenes, in `pablo check` too.
 * AC4: the conformance run passes (also run for every row by outputs.test.ts).
 *
 * Everything runs on a temp git copy of the synthetic fixture vault; never `~/writing`.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, CompletionEvent } from "@openthink/pablo-core";
import { checkWork } from "../src/check";
import { readMarker } from "../src/marker";
import { migrateOutputs } from "../src/migrate-outputs";
import { addOutput } from "../src/output-verbs";
import { runConformance } from "../src/outputs/conformance";
import { OUTPUTS } from "../src/outputs/registry";
import { fountainElements, lintFountain } from "../src/outputs/screenplay/fountain";
import { buildScreenplayPack, previousSceneSummary, screenplayDefaultPlan, screenplayPreconditions } from "../src/outputs/screenplay/pack";
import { compileScreenplay, publishScreenplay, titleMetaOf } from "../src/outputs/screenplay/publish";
import { buildScreenplayPdf, layoutScreenplay } from "../src/screenplay-pdf";
import { TRACKS } from "../src/tracks/registry";
import { runWrite } from "../src/write";
import type { WriteArgs } from "../src/write";
import { useLocalConfigHome } from "./local-config";

useLocalConfigHome();

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const CONFORMANCE = fileURLToPath(new URL("./fixtures/conformance", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");
const STATE_HOME = mkdtempSync(join(tmpdir(), "pablo-screenplay-state-"));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => rmSync(STATE_HOME, { recursive: true, force: true }));

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  return result.stdout.toString("utf8").trim();
}

function repo(source: string): string {
  const vault = join(temp("pablo-screenplay-"), "vault");
  cpSync(source, vault, { recursive: true });
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "pablo-test@example.com");
  git(vault, "config", "user.name", "Pablo Test");
  git(vault, "config", "commit.gpgsign", "false");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  return vault;
}

/** ice-house migrated to outputs, with the screenplay added beside its novel. */
function screenplayVault(): { vault: string; work: string; home: string } {
  const vault = repo(FIXTURE_VAULT);
  const work = join(vault, "novels", "ice-house");
  const migrated = migrateOutputs(vault, work, { dryRun: false, now: () => new Date("2026-10-11T12:00:00Z") });
  if (!migrated.ok) throw new Error(`migrate failed: ${JSON.stringify(migrated)}`);
  const added = addOutput(vault, work, "screenplay", { now: () => new Date("2026-10-12T12:00:00Z") });
  if (!added.ok) throw new Error(`output add failed: ${JSON.stringify(added)}`);
  return { vault, work, home: join(dirname(vault), "pablo-home") };
}

const SCENE = [
  "INT. ICE HOUSE - NIGHT",
  "",
  "Sawdust to the rafters. CORA (40s) lifts a lantern.",
  "",
  "CORA",
  "(quietly)",
  "It held. Mr. Hale said it would not.",
  "",
  "NED (O.S.)",
  "Fine.",
  "",
  "CUT TO:",
].join("\n");

const scene = (n: number, body = SCENE): string => `---\nscene: ${n}\ntitle: Invented ${n}\nstatus: draft\n---\n\n${body}\n`;

function writeScene(work: string, n: number, body = SCENE): string {
  const dir = join(work, "outputs", "screenplay", "scenes");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${String(n).padStart(2, "0")}-invented-${n}.fountain`);
  writeFileSync(path, scene(n, body));
  return path;
}

// AC1 ------------------------------------------------------------------------

test("AC1: screenplay is a registered output on fiction and historical-fiction, scenes as NN-*.fountain units", () => {
  const def = OUTPUTS.screenplay;
  expect(def.tracks).toEqual(["fiction", "historical-fiction"]);
  expect(TRACKS.fiction.outputs).toContain("screenplay");
  expect(TRACKS["historical-fiction"].outputs).toContain("screenplay");
  expect(TRACKS.nonfiction.outputs).not.toContain("screenplay");
  expect(def.artifactDir).toBe("outputs/screenplay/scenes");
  expect(def.noun).toBe("scene");
  expect(def.unitFileName(3, "The Last Full Cut")).toBe("03-the-last-full-cut.fountain");
  expect(def.unitOfPath("novels/x/outputs/screenplay/scenes/03-the-last-full-cut.fountain")).toBe(3);
  expect(def.unitOfPath("outputs/screenplay/scenes/03-x.md")).toBeUndefined();
  expect(def.unitOfPath("outputs/radio/episodes/03-x.fountain")).toBeUndefined();
  expect(def.branch(3)).toBe("draft/screenplay-sc03");
  expect(def.unitOfBranch("draft/screenplay-sc03-v2")).toBe(3);
  expect(def.unitOfBranch("draft/radio-ep03")).toBeUndefined();
});

test("AC1: output add screenplay plans one scene per core beat; a scene needs the one before it", () => {
  const { work } = screenplayVault();
  expect(existsSync(join(work, "outputs", "screenplay", "RULES.md"))).toBe(true);
  expect(existsSync(join(work, "outputs", "screenplay", "plan.md"))).toBe(true);
  const plan = screenplayDefaultPlan(work);
  expect(plan.length).toBeGreaterThan(1);
  for (const row of plan) expect(row.beats).toEqual([row.unit]);
  expect(screenplayPreconditions(work, 2).missing).toContain("scene 1 is not written");
  writeScene(work, 1);
  expect(screenplayPreconditions(work, 2).missing).not.toContain("scene 1 is not written");
});

// AC2 ------------------------------------------------------------------------

function fakeFountainWriter(): Adapter {
  return {
    id: "local",
    model: "test-writer-model",
    preferredOutput: "text",
    async *complete(): AsyncIterable<CompletionEvent> {
      yield { type: "token", text: "INT. ICE HOUSE - NIGHT\n\nSawdust. CORA (40s) lifts a lantern. It sways.\n\n" };
      yield { type: "token", text: "CORA\n(quietly)\nIt held. Mr. Hale said it would not. He was wrong.\n\nNED\nFine." };
      yield { type: "done", stats: { timeToFirstTokenMs: 10, elapsedMs: 20, tokensRead: 100, tokensWritten: 30, tokensPerSecond: 600 } };
    },
    async proposeEdit(): Promise<never> {
      throw new Error("not used");
    },
    async extractFacts(): Promise<never> {
      throw new Error("not used");
    },
  };
}

test("AC2: write --output screenplay stores the Fountain line for line: no sentence splitting, blank lines between elements kept", async () => {
  const { vault, home } = screenplayVault();
  const work = join(vault, "novels", "ice-house");
  const lines: string[] = [];
  const log = console.log;
  console.log = (text: unknown) => void lines.push(String(text));
  let code: number;
  try {
    code = await runWrite(
      { chapter: undefined, output: "screenplay", unit: "1", words: undefined, scenes: undefined, dryRun: false, json: true, force: false } as WriteArgs,
      vault,
      work,
      { adapter: fakeFountainWriter(), env: { PATH: NO_THINK_PATH, XDG_STATE_HOME: STATE_HOME, PABLO_HOME: home }, stderr: { write: () => {} }, now: () => new Date("2026-10-12T12:00:00Z") },
    );
  } finally {
    console.log = log;
  }
  expect(code).toBe(0);
  const body = JSON.parse(lines.join("\n"));
  expect(body).toMatchObject({ ok: true, branch: "draft/screenplay-sc01" });
  expect(body.path).toMatch(/^outputs\/screenplay\/scenes\/01-.*\.fountain$/);
  const text = git(vault, "show", `draft/screenplay-sc01:novels/ice-house/${body.path}`);
  expect(text).toContain(
    "\nINT. ICE HOUSE - NIGHT\n\nSawdust. CORA (40s) lifts a lantern. It sways.\n\nCORA\n(quietly)\nIt held. Mr. Hale said it would not. He was wrong.\n\nNED\nFine.",
  );
  expect(lintFountain(text, body.path)).toEqual([]);
});

// AC3 ------------------------------------------------------------------------

test("AC3: the scene's pack carries the screenplay rules (Fountain) and the previous scene as a summary, never a joined tail", () => {
  const { vault, work } = screenplayVault();
  writeScene(work, 1);
  const marker = readMarker(work);
  if (!marker.ok) throw new Error(marker.message);
  const packed = buildScreenplayPack(vault, work, 2, { marker: marker.marker, output: "screenplay" });
  if (!packed.ok) throw new Error(packed.message);
  expect(packed.pack.prompt).toContain("# Screenplay rules");
  expect(packed.pack.prompt).toContain("Fountain");
  expect(packed.pack.prompt).toContain("scene 2 of a screenplay");
  expect(packed.pack.prompt).toContain("CORA: It held. Mr. Hale said it would not.");
  expect(packed.pack.prompt).toContain("INT. ICE HOUSE - NIGHT");
  const summary = previousSceneSummary(vault, work, 2);
  expect(summary?.text).toContain("NED: Fine.");
});

test("AC3: a well-formed scene lints clean", () => {
  expect(lintFountain(scene(1), "s.fountain")).toEqual([]);
  // A lone line in capitals is action to Fountain, not a cue gone wrong.
  expect(lintFountain(scene(1, `${SCENE}\n\nSILENCE\n\nCORA\nGood.`), "s.fountain")).toEqual([]);
  // Notes, sections and the boneyard are not printed.
  expect(lintFountain(scene(1, `# Act one\n\n[[a note]]\n\n/* cut\nCORA: old */\n\n${SCENE}`), "s.fountain")).toEqual([]);
});

test("AC3: the Fountain lint flags malformed scenes, on the file's own line numbers", () => {
  const bad = scene(
    1,
    [
      "Sawdust to the rafters.", // 7: no heading first
      "",
      "INT. ICE HOUSE - NIGHT", // 9: no blank line after
      "CORA lifts a lantern.",
      "",
      "(quietly)", // 12: stray parenthetical
      "",
      "CORA: It held.", // 14: colon dialogue
      "",
      "NED (O.S.)", // 16: cue with no dialogue
      "",
      "```", // 18: markdown
      "",
      "/* never closed", // 20
      "CORA",
    ].join("\n"),
  );
  expect(lintFountain(bad, "s.fountain").map((h) => [h.line, h.rule])).toEqual([
    [7, "fountain-no-heading"],
    [9, "fountain-heading-spacing"],
    [12, "fountain-stray-parenthetical"],
    [14, "fountain-colon-dialogue"],
    [16, "fountain-cue-no-dialogue"],
    [18, "fountain-markdown"],
    [20, "fountain-unclosed-boneyard"],
  ]);
});

test("AC3: pablo check --output screenplay reads the .fountain scenes and reports the lint", () => {
  const { vault, work } = screenplayVault();
  writeScene(work, 1);
  writeScene(work, 2, "CORA: It held.");
  const outcome = checkWork(vault, work, undefined, "screenplay");
  if (!outcome.ok) throw new Error(outcome.message);
  const rules = outcome.hits.map((h) => `${h.path}:${h.rule}`);
  expect(rules).toContain("outputs/screenplay/scenes/02-invented-2.fountain:fountain-no-heading");
  expect(rules).toContain("outputs/screenplay/scenes/02-invented-2.fountain:fountain-colon-dialogue");
  expect(rules.some((r) => r.startsWith("outputs/screenplay/scenes/01-"))).toBe(false);
  expect(outcome.unprovenanced).toContain("outputs/screenplay/scenes/01-invented-1.fountain");
});

test("fountainElements reads headings, speeches and action; parentheticals stay out", () => {
  expect(fountainElements(scene(1))).toEqual([
    { kind: "heading", text: "INT. ICE HOUSE - NIGHT" },
    { kind: "action", text: "Sawdust to the rafters. CORA (40s) lifts a lantern." },
    { kind: "dialogue", speaker: "CORA", text: "It held. Mr. Hale said it would not." },
    { kind: "dialogue", speaker: "NED", text: "Fine." },
    { kind: "transition", text: "CUT TO:" },
  ]);
});

test("publish --target fountain compiles every scene in order under a title page, frontmatter stripped", () => {
  const { work } = screenplayVault();
  writeScene(work, 2, "EXT. POND - DAY\n\nIce.");
  writeScene(work, 1);
  const out = publishScreenplay(work, "ice-house", "The Ice House", "fountain");
  if (!out.ok) throw new Error(out.message);
  expect(out.chapters).toBe(2);
  const text = readFileSync(out.where, "utf8");
  expect(text).toBe(compileScreenplay("The Ice House", [scene(1), scene(2, "EXT. POND - DAY\n\nIce.")], titleMetaOf(work)));
  expect(text.startsWith(`Title: The Ice House\nCredit: Written by\nAuthor: ${titleMetaOf(work).author}\n\nINT. ICE HOUSE - NIGHT\n`)).toBe(true);
  expect(text).toContain("CUT TO:\n\nEXT. POND - DAY\n\nIce.\n");
  expect(text).not.toContain("status: draft");
  expect(publishScreenplay(work, "ice-house", "T", "pdf")).toMatchObject({ ok: false, code: 2 });
});

// AGT-2133 -------------------------------------------------------------------

test("publish --target draft|final writes the compiled .fountain and a PDF", () => {
  const { work } = screenplayVault();
  writeScene(work, 2, "EXT. POND - DAY\n\nIce.");
  writeScene(work, 1);
  for (const target of ["draft", "final"]) {
    const out = publishScreenplay(work, "ice-house", "The Ice House", target);
    if (!out.ok) throw new Error(out.message);
    expect(out.files).toEqual(["ice-house-screenplay.fountain", "ice-house-screenplay.pdf"]);
    expect(readFileSync(out.where, "utf8")).toBe(compileScreenplay("The Ice House", [scene(1), scene(2, "EXT. POND - DAY\n\nIce.")], titleMetaOf(work)));
    const pdf = readFileSync(join(dirname(out.where), "ice-house-screenplay.pdf"), "latin1");
    expect(pdf.startsWith("%PDF-1.4\n")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(pdf).toContain("/BaseFont /Courier");
    expect(pdf).toContain("(THE ICE HOUSE) Tj");
    expect(pdf).toContain("(INT. ICE HOUSE - NIGHT) Tj");
  }
  // The fountain target stays Fountain-only.
  const only = publishScreenplay(work, "ice-house", "The Ice House", "fountain");
  expect(only).toMatchObject({ ok: true, files: ["ice-house-screenplay.fountain"] });
});

test("the PDF is standard format: Courier 12, Letter, margins, dialogue indents, page numbers", () => {
  const text = compileScreenplay("The Ice House", [scene(1)]);
  const { pages, titled } = layoutScreenplay(text);
  expect(titled).toBe(true);
  const script = pages[1] ?? [];
  const at = (needle: string) => script.find((l) => l.text.startsWith(needle));
  expect(at("INT. ICE HOUSE")).toMatchObject({ x: 108, bold: true });
  expect(at("CORA")).toMatchObject({ x: 266.4 });
  expect(at("It held.")).toMatchObject({ x: 180 });
  const cut = script.find((l) => l.text === "CUT TO:");
  expect((cut?.x ?? 0) + 7.2 * 7).toBeCloseTo(540, 5);
  // Action wraps at 60 columns; no line is over its width.
  expect(script.filter((l) => l.x === 108).every((l) => l.text.length <= 60)).toBe(true);

  const long = Array.from({ length: 40 }, (_, i) => `A CHAIR ${i}\n\nCORA\nLine ${i}.`).join("\n\n");
  const big = layoutScreenplay(compileScreenplay("Long", [`INT. ROOM - DAY\n\n${long}`]));
  expect(big.pages.length).toBeGreaterThan(3);
  expect(big.pages.every((p) => p.length <= 54)).toBe(true);
  const bytes = buildScreenplayPdf(compileScreenplay("Long", [`INT. ROOM - DAY\n\n${long}`]), "Long");
  const pdf = Buffer.from(bytes).toString("latin1");
  expect(pdf).toContain(`/Count ${big.pages.length}`);
  expect(pdf).toContain("(2.) Tj");
  expect(pdf).toContain("(3.) Tj");
  expect(pdf).toContain("/MediaBox [0 0 612 792]");
  expect(pdf).toContain("12 Tf");
  // The xref offsets point at their objects.
  const xref = Number(/startxref\n(\d+)/.exec(pdf)?.[1]);
  const rows = pdf.slice(xref).split("\n").slice(3).filter((r) => r.endsWith(" n "));
  rows.forEach((row, i) => expect(pdf.slice(Number(row.slice(0, 10))).startsWith(`${i + 1} 0 obj`)).toBe(true));
  // Deterministic.
  expect(Buffer.from(buildScreenplayPdf(compileScreenplay("Long", [`INT. ROOM - DAY\n\n${long}`]), "Long")).equals(Buffer.from(bytes))).toBe(true);
});

test("AGT-2194: the title block and PDF title page carry the author, draft date and contact", () => {
  const meta = { author: "Ada Lovelace", draftDate: "2026-10-27", contact: "ada@example.com" };
  const text = compileScreenplay("The Ice House", [scene(1)], meta);
  expect(text.startsWith("Title: The Ice House\nCredit: Written by\nAuthor: Ada Lovelace\nDraft date: 2026-10-27\nContact: ada@example.com\n\nINT.")).toBe(true);
  const title = (layoutScreenplay(text).pages[0] ?? []).map((l) => l.text);
  expect(title).toContain("Written by");
  expect(title).toContain("Ada Lovelace");
  expect(title).toContain("ada@example.com");
  expect(compileScreenplay("T", [scene(1)])).toMatch(/^Title: T\n\nINT\./);
});

test("AGT-2194: action never breaks a page with fewer than two lines on either side", () => {
  let splits = 0;
  for (const fill of [0, 1, 2, 3, 20, 50, 51, 52, 53]) {
    for (const size of [2, 3, 4, 5, 9]) {
      const filler = Array.from({ length: fill }, (_, i) => `Filler ${i}.`).join("\n\n");
      const action = Array.from({ length: size }, (_, i) => `word${i} `.repeat(11).trim()).join(" ");
      const text = compileScreenplay("T", [`INT. ROOM - DAY\n\n${filler}\n\n${action}\n\nThe end.`]);
      const { pages } = layoutScreenplay(text);
      for (const page of pages) expect(page.length).toBeLessThanOrEqual(54);
      const flat = pages.slice(1).map((p) => p.filter((l) => l.text !== "").map((l) => l.text));
      flat.forEach((lines, i) => {
        const tail = lines.filter((t) => t.startsWith("word"));
        if (tail.length === 0) return;
        // A page that ends in action holds a block fragment: it and the next page's start are each 2+ lines.
        const next = flat[i + 1]?.filter((t) => t.startsWith("word")) ?? [];
        const lastIsAction = lines[lines.length - 1]?.startsWith("word") === true;
        const nextStartsAction = flat[i + 1]?.[0]?.startsWith("word") === true;
        if (lastIsAction && nextStartsAction) {
          splits += 1;
          expect(tail.length).toBeGreaterThanOrEqual(2);
          expect(next.length).toBeGreaterThanOrEqual(2);
        }
      });
    }
  }
  expect(splits).toBeGreaterThan(0);
});

// AC4 ------------------------------------------------------------------------

test("AC4: the screenplay passes the conformance run over the four-beat fixture", async () => {
  const vault = repo(CONFORMANCE);
  const work = join(vault, "novels", "four-beats");
  const marker = readMarker(work);
  if (!marker.ok) throw new Error(marker.message);
  const report = await runConformance(OUTPUTS.screenplay, {
    vaultRoot: vault,
    workDir: work,
    marker: marker.marker,
    writer: (_prompt, unit) => `INT. ROOM ${unit} - DAY\n\nA chair.`,
    env: { PATH: "/usr/bin:/bin" },
    now: () => new Date("2026-10-10T12:00:00Z"),
  });
  expect(report.units).toEqual([1, 2, 3, 4]);
  expect(report.published.endsWith(".fountain")).toBe(true);
});
