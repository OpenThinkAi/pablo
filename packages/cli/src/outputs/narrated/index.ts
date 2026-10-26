/**
 * The `narrated` output type (AGT-2137, pm project `pablo-platform`, D-7,
 * text side): a straight audiobook-style reading of another output's prose.
 * `pablo output add narrated --from <novel|story|essay>` records the source
 * in `pablo.json` (`outputs.narrated.from`); the narrated units mirror the
 * source's units one for one, and `pablo write --output narrated --unit N`
 * turns the source unit's prose into a `lines` script (`./narrate.ts`) with
 * no model: a `CAST:` line, `NARRATOR:` lines, and with `--voices
 * characters` a speaker line per attributed quote. The words are the
 * source's, unchanged; `pablo check` flags a reading whose words differ from
 * its source unit's (`narration-drift`).
 *
 * The audio side (casting the narrator, perform, mix and the mixer) is W8;
 * this type stops at the script, published as one file by `--target script`.
 *
 * Allowed on every track (D-7). Only top-level `NARRATED` is evaluated at
 * import: the registry and marker are read inside functions, as the
 * registry itself asks of every row.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { estimateTokens, hashPrompt } from "@openthink/pablo-core";
import type { BeatRow, DraftingInputs, Pack } from "@openthink/pablo-core";
import { readCoreState } from "../../core/machine";
import type { CoreState } from "../../core/machine";
import { readMarker } from "../../marker";
import type { Ritual } from "../../novel/rituals";
import { stripFrontmatter } from "../../publish";
import { frontmatterField } from "../novel/plan";
import { outputDefinition } from "../registry";
import type {
  DeriveOutcome,
  OutputDefinition,
  OutputReport,
  OutputUnit,
  PlanRow,
  PublishOutcome,
  UnitPackOptions,
  UnitPackOutcome,
  UnitPreconditions,
} from "../types";
import { characterNames, narrateProse, narrationDrift } from "./narrate";
import type { Drift } from "./narrate";
import {
  isNarratedVoices,
  NARRATED_DIR,
  NARRATED_ID,
  NARRATED_PUBLISH_TARGETS,
  NARRATED_VOICES,
  narratedBranch,
  narratedUnitFileName,
  narratedUnitOfBranch,
  narratedUnitOfPath,
} from "./units";

/** `outputs/narrated/RULES.md`'s scaffold. Nothing sends it to a model: the reading is made from the source, not drafted. */
export const NARRATED_RULES_TEMPLATE = `# Narrated rules

Rules for the narrated output: a straight reading of another output's prose
(the source named by \`from\` in \`pablo.json\`'s \`outputs.narrated\`).

- A reading is made from its source unit by \`pablo write --output narrated
  --unit N\`, with no model: the words are the source's, unchanged.
- \`--voices narrator\` (the default): one narrator reads every line.
- \`--voices characters\`: quoted dialogue whose speaker the paragraph names
  (a character in \`bible/characters/\`) goes to that character's line; the
  rest stays the narrator's.
- To change a reading's words, change the source unit and write the reading
  again; \`pablo check --output narrated\` flags a reading that has drifted.
`;

/** Why the work's narrated output has no usable source, as `missing` items. */
type SourceLookup = { readonly ok: true; readonly source: OutputDefinition } | { readonly ok: false; readonly missing: readonly string[] };

/** Whether `def` can be read aloud: a prose output (stored as sentences), not a script, and not a reading itself. */
export function isNarratableSource(def: OutputDefinition): boolean {
  return def.id !== NARRATED_ID && def.derive === undefined && (def.manuscript ?? "sentences") === "sentences";
}

/** The output the work's narrated units are read from: `outputs.narrated.from`, which must be a declared prose output. */
export function narratedSource(workDir: string): SourceLookup {
  const marker = readMarker(workDir);
  if (!marker.ok) return { ok: false, missing: [marker.message] };
  const from = marker.marker.outputs[NARRATED_ID]?.["from"];
  if (typeof from !== "string" || from === "") {
    return { ok: false, missing: ["outputs.narrated.from in pablo.json: the output it reads (pablo output add narrated --from <output>)"] };
  }
  const def = outputDefinition(from);
  if (def === undefined || !isNarratableSource(def)) return { ok: false, missing: [`outputs.narrated.from names "${from}", which is not a prose output`] };
  if (marker.marker.outputs[from] === undefined) return { ok: false, missing: [`the ${from} output the narration reads (pablo output add ${from})`] };
  return { ok: true, source: def };
}

/** The source's plan, each unit's status the reading's own. */
function narratedPlan(workDir: string): PlanRow[] {
  const found = narratedSource(workDir);
  if (!found.ok) return [];
  const files = narratedFiles(workDir);
  return found.source.plan(workDir).map((row) => {
    const file = files.get(row.unit);
    return { unit: row.unit, title: row.title, beats: row.beats, status: file === undefined ? "beat" : (frontmatterField(readFileSync(file, "utf8"), "status") ?? "unknown") };
  });
}

/** The work's readings by unit number, absolute paths. */
export function narratedFiles(workDir: string): Map<number, string> {
  const dir = join(workDir, NARRATED_DIR);
  const files = new Map<number, string>();
  if (!existsSync(dir)) return files;
  for (const name of readdirSync(dir).sort()) {
    const unit = narratedUnitOfPath(`${NARRATED_DIR}/${name}`);
    if (unit !== undefined && statSync(join(dir, name)).isFile()) files.set(unit, join(dir, name));
  }
  return files;
}

/** The source unit a reading is made from: its report row (with its file, work-relative, when it is drafted). */
function sourceUnit(workDir: string, source: OutputDefinition, unit: number): OutputUnit | undefined {
  return source.report(workDir, readCoreState(workDir)).units.find((u) => u.unit === unit);
}

function narratedPreconditions(workDir: string, unit: number): UnitPreconditions {
  const found = narratedSource(workDir);
  if (!found.ok) return { ready: false, missing: found.missing };
  const { source } = found;
  const row = sourceUnit(workDir, source, unit);
  if (row === undefined) return { ready: false, missing: [`${source.noun} ${unit} of the ${source.id} output (it has no such unit)`] };
  if (row.file === undefined) return { ready: false, missing: [`${source.noun} ${unit} of the ${source.id} output is not written yet (pablo write --output ${source.id} --unit ${unit})`] };
  return { ready: true, missing: [] };
}

/** The bible's character files' text, for `--voices characters`. */
function characterTexts(workDir: string): string[] {
  const walk = (dir: string): string[] =>
    !existsSync(dir)
      ? []
      : readdirSync(dir).flatMap((name) => {
          const full = join(dir, name);
          return statSync(full).isDirectory() ? walk(full) : name.endsWith(".md") ? [readFileSync(full, "utf8")] : [];
        });
  return walk(join(workDir, "bible", "characters"));
}

/** The source unit's body (frontmatter stripped) and its file, or a refusal. */
function sourceBody(workDir: string, unit: number): { ok: true; body: string; file: string; source: OutputDefinition; row: OutputUnit } | { ok: false; code: 2; message: string } {
  const ready = narratedPreconditions(workDir, unit);
  if (!ready.ready) return { ok: false, code: 2, message: `pablo: reading ${unit} is not ready: ${ready.missing.join("; ")}` };
  const found = narratedSource(workDir) as { ok: true; source: OutputDefinition };
  const row = sourceUnit(workDir, found.source, unit) as OutputUnit;
  const file = row.file as string;
  return { ok: true, body: stripFrontmatter(readFileSync(join(workDir, file), "utf8")), file, source: found.source, row };
}

function deriveReading(workDir: string, unit: number, options: Pick<UnitPackOptions, "voices">): DeriveOutcome {
  const voices = options.voices ?? "narrator";
  if (!isNarratedVoices(voices)) return { ok: false, code: 2, message: `pablo: --voices must be ${NARRATED_VOICES.join(" or ")} (got "${voices}")` };
  const read = sourceBody(workDir, unit);
  if (!read.ok) return read;
  const names = voices === "characters" ? characterNames(characterTexts(workDir)) : new Set<string>();
  return { ok: true, text: narrateProse(read.body, voices, names), source: read.file };
}

/**
 * The "pack" of a reading: no model reads it, so it is the script itself as
 * one slice, sourced to the unit it was made from. `--dry-run` shows it; its
 * hash is the reading's `prompt_hash`.
 */
function narratedPack(_vaultRoot: string, workDir: string, unit: number, options: UnitPackOptions): UnitPackOutcome {
  const derived = deriveReading(workDir, unit, options);
  if (!derived.ok) return derived;
  const read = sourceBody(workDir, unit);
  if (!read.ok) return read;
  const core = readCoreState(workDir);
  const firstBeat = read.source.plan(workDir).find((r) => r.unit === unit)?.beats[0];
  const beatRow = core.beats.find((b) => b.chapter === firstBeat);
  const title = read.row.title ?? beatRow?.title ?? `${read.source.noun} ${unit}`;
  const beat: BeatRow = {
    chapter: unit,
    storyDate: read.row.storyDate ?? beatRow?.storyDate ?? "",
    title,
    beat: beatRow?.beat ?? "",
    pov: beatRow?.pov ?? "",
    status: beatRow?.status ?? "",
    source: read.file,
  };
  const tokens = estimateTokens(derived.text);
  const pack: Pack = {
    kind: "drafting",
    slices: [{ name: "source", heading: "", text: derived.text, tokens, source: derived.source }],
    totalTokens: tokens,
    budgetTokens: tokens,
    withinBudget: true,
    adjustments: [],
    context: derived.text,
    prompt: derived.text,
    hash: hashPrompt(derived.text),
    expectedOutputTokens: 0,
  };
  const words = derived.text.split(/\s+/).filter((w) => w !== "").length;
  const inputs: DraftingInputs = { work: { title: options.marker.title }, beat, unit, style: [], timeline: { exists: [], later: [], source: "" }, wordTarget: words };
  return { ok: true, pack, inputs };
}

/**
 * The narration check (AC3): each reading's words against its source unit's
 * prose. A reading whose source cannot be read is a drift too: it can no
 * longer be held to anything. `files` are absolute reading paths.
 */
export function narratedDrift(workDir: string, file: string): Drift | undefined {
  const unit = narratedUnitOfPath(file.split(sep).join("/"));
  if (unit === undefined) return undefined;
  const read = sourceBody(workDir, unit);
  if (!read.ok) return { line: 1, excerpt: "", detail: read.message.replace(/^pablo: /, "") };
  return narrationDrift(read.body, readFileSync(file, "utf8"));
}

function narratedReport(workDir: string, _core: CoreState): OutputReport {
  const plan = narratedPlan(workDir);
  const files = narratedFiles(workDir);
  const units: OutputUnit[] = plan.map((row) => {
    const file = files.get(row.unit);
    return {
      unit: row.unit,
      title: row.title,
      status: row.status,
      ...(file === undefined ? {} : { file: `${NARRATED_DIR}/${file.slice(file.lastIndexOf(sep) + 1)}` }),
    };
  });
  const drafted = units.filter((u) => u.file !== undefined).length;
  const next = units.find((u) => u.file === undefined);
  return {
    noun: "reading",
    plural: "readings",
    dir: NARRATED_DIR,
    units,
    drafted,
    total: units.length,
    ...(next === undefined ? {} : { next: `narrate unit ${next.unit} (pablo write --output narrated --unit ${next.unit})` }),
  };
}

/** After a reading merges: say whether its words still match the source. Never writes, never fails the merge. */
async function narratedAfterMerge(workDir: string, unit: number, unitPath: string): Promise<Ritual[]> {
  try {
    const drift = narratedDrift(workDir, unitPath);
    return [
      {
        name: "narration",
        status: "ran",
        detail: drift === undefined ? `reading ${unit} matches its source word for word` : `reading ${unit} differs from its source at line ${drift.line}: ${drift.detail} (pablo check --output narrated)`,
      },
    ];
  } catch (error) {
    return [{ name: "narration", status: "failed", detail: error instanceof Error ? error.message : String(error) }];
  }
}

/** `--target script`: every reading's script, in unit order, in one file under `.pablo/out/`. */
function publishNarrated(workDir: string, slug: string, title: string, target: string | undefined): PublishOutcome {
  const refuse = (message: string, tried: readonly string[] = []): PublishOutcome => ({ ok: false, code: 2, message, tried });
  if (target === undefined) return refuse(`pablo: publish requires --target (${NARRATED_PUBLISH_TARGETS.join("|")})`);
  if (!(NARRATED_PUBLISH_TARGETS as readonly string[]).includes(target)) return refuse(`pablo: publish: unknown --target "${target}" (expected ${NARRATED_PUBLISH_TARGETS.join("|")})`);
  const files = [...narratedFiles(workDir).entries()].sort((a, b) => a[0] - b[0]);
  if (files.length === 0) return refuse(`pablo: publish: no readings to compile (${NARRATED_DIR})`, [join(workDir, NARRATED_DIR)]);
  const parts = [`# ${title}: narrated`];
  for (const [unit, file] of files) {
    const text = readFileSync(file, "utf8");
    parts.push(`## Reading ${unit}${frontmatterField(text, "title") ? `: ${frontmatterField(text, "title")}` : ""}`, stripFrontmatter(text).trim());
  }
  const compiled = `${parts.join("\n\n")}\n`;
  const outDir = join(workDir, ".pablo", "out");
  const where = join(outDir, `${slug}-narrated-${target}.md`);
  if (!where.startsWith(outDir + sep)) return refuse(`pablo: publish: marker slug "${slug}" would write outside ${outDir}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(where, compiled, "utf8");
  return { ok: true, code: 0, target, where, chapters: files.length, words: compiled.split(/\s+/).filter((w) => w !== "").length };
}

export const NARRATED: OutputDefinition = {
  id: NARRATED_ID,
  noun: "reading",
  plural: "readings",
  artifactDir: NARRATED_DIR,
  rulesTemplate: NARRATED_RULES_TEMPLATE,
  tracks: ["fiction", "historical-fiction", "nonfiction"],
  // The text side. Casting, perform and mix join when the mixer narrates (W8).
  stages: ["narrate"],
  plan: narratedPlan,
  preconditions: narratedPreconditions,
  pack: narratedPack,
  rituals: { afterMerge: (workDir, unit, unitPath) => narratedAfterMerge(workDir, unit, unitPath), afterRevision: () => [] },
  publish: { targets: NARRATED_PUBLISH_TARGETS, run: publishNarrated },
  report: narratedReport,
  unitFileName: narratedUnitFileName,
  unitOfPath: narratedUnitOfPath,
  branch: narratedBranch,
  unitOfBranch: narratedUnitOfBranch,
  manuscript: "lines",
  derive: deriveReading,
};
