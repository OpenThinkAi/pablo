/**
 * `pablo output list|add|remove|plan` (AGT-1669, pm project
 * `pablo-story-core`, "Addressing an output"): the work's outputs, managed.
 *
 *   list            each declared output with its units drafted and next step,
 *                   and the registered types the work does not derive yet
 *   add <type>      adds `outputs.<type>` to `pablo.json` (`added`: today),
 *                   scaffolds `outputs/<type>/plan.md` (the type's default
 *                   plan) and `outputs/<type>/RULES.md` (its rules template),
 *                   and commits exactly those paths; refused when the story
 *                   core is not at `beats` (an output maps its units onto the
 *                   core's beats, so there is nothing to plan before them)
 *   remove <type>   drops `outputs.<type>` from `pablo.json`; nothing is
 *                   deleted: `outputs/<type>/` moves to
 *                   `outputs/_removed/<type>-<date>/` in the same commit (the
 *                   novel's chapters stay where they are)
 *   add essay --thesis "<text>"
 *                   on a fiction track (AGT-2135) the essay's thesis; with
 *                   the outline drawn from the core it is written as
 *                   `outputs/essay/thesis.md` and `outline.md` beside the
 *                   plan, and an essay added without one is refused
 *   add narrated --from <output>
 *                   a derived output (AGT-2137) records the prose output it
 *                   reads as `outputs.narrated.from`; its plan is that
 *                   output's units
 *   plan <type>     rewrites `outputs/<type>/plan.md` from the type's default
 *                   plan over the current beats and commits it
 *
 * An unknown type is refused by name (the registry's known types listed); a
 * type the work does not declare is refused by `remove` and `plan`, and one
 * it already declares by `add`. Like `migrate outputs`, every write is one
 * commit of exactly the paths it touches, refused up front when one of them
 * has uncommitted changes. `pablo.json` is rewritten key-for-key (only
 * `outputs` changes), and a marker still on the deprecated `format` key is
 * refused with a pointer at `pablo migrate outputs`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { BEATS_FILE, LEGACY_CONTINUITY_FILE, NOVEL_CONTINUITY_FILE, parsePlanRows } from "@openthink/pablo-core";
import type { PlanFileRow } from "@openthink/pablo-core";
import { coreNext, coreStages, readCoreState } from "./core/machine";
import { gitCommit } from "./init";
import { markerPath, readMarker, trackOf } from "./marker";
import type { Marker } from "./marker";
import { dirtyPaths } from "./migrate";
import { LEDGER_TEMPLATE } from "./novel/continuity";
import { renderNovelPlan } from "./outputs/novel/plan";
import { isNarratableSource } from "./outputs/narrated";
import { OUTPUTS, outputDefinition, outputIds, outputsOnTrack } from "./outputs/registry";
import type { OutputDefinition, PlanRow } from "./outputs/types";

/** Where every output but the novel keeps its plan, rules and units: `outputs/<type>/`. */
export const OUTPUTS_DIR = "outputs";

/** Where `output remove` archives an output's directory. */
export const REMOVED_DIR = "outputs/_removed";

export interface OutputListEntry {
  readonly type: string;
  readonly noun: string;
  readonly plural: string;
  /** Where the output's units land, work-relative. */
  readonly dir: string;
  readonly added?: string;
  readonly drafted: number;
  readonly total: number;
  readonly stages: readonly string[];
  readonly next?: string;
}

export interface OutputRefusal {
  readonly ok: false;
  readonly code: 2;
  readonly message: string;
  readonly missing?: readonly string[];
  /** The value the author can give to get past the refusal (`output add essay`'s thesis, AGT-2135), for a front end to ask for. */
  readonly ask?: "thesis";
}

export type OutputListResult = { readonly ok: true; readonly outputs: readonly OutputListEntry[]; readonly available: readonly string[] } | OutputRefusal;

export type OutputChangeResult =
  | {
      readonly ok: true;
      readonly type: string;
      readonly action: "add" | "remove";
      /** Work-relative paths the commit holds (both sides of a move), sorted. */
      readonly paths: readonly string[];
      readonly committed: boolean;
      /** `remove`: where `outputs/<type>/` went, work-relative, when it existed. */
      readonly archived?: string;
      readonly notice?: string;
    }
  | OutputRefusal;

export type OutputPlanResult =
  | {
      readonly ok: true;
      readonly type: string;
      readonly path: string;
      readonly rows: readonly PlanRow[];
      readonly changed: boolean;
      readonly dryRun: boolean;
      readonly committed: boolean;
      readonly notice?: string;
    }
  | OutputRefusal;

export interface OutputVerbOptions {
  /** The clock for `added` and the archive's date. */
  readonly now?: () => Date;
  /** `add <type> --from <output>` (AGT-2137): the output a derived type (narrated) reads; refused for any other type. */
  readonly from?: string | undefined;
  /** `add essay --thesis "<text>"` (AGT-2135): a fiction track's essay thesis; refused for a type with no scaffold. */
  readonly thesis?: string | undefined;
}

function refuse(sub: string, message: string, missing?: readonly string[]): OutputRefusal {
  return { ok: false, code: 2, message: `pablo: output ${sub}: ${message}`, ...(missing ? { missing } : {}) };
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** `outputs/<type>/plan.md`. */
export function planFile(type: string): string {
  return `${OUTPUTS_DIR}/${type}/plan.md`;
}

/** `outputs/<type>/RULES.md`. */
export function rulesFile(type: string): string {
  return `${OUTPUTS_DIR}/${type}/RULES.md`;
}

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/** `outputs/<type>/plan.md`'s text for `rows`: the novel's own form for the novel, the same table for any other type. */
export function renderPlan(def: OutputDefinition, rows: readonly PlanRow[]): string {
  if (def.id === OUTPUTS.novel.id) return renderNovelPlan(rows);
  return [
    `# Plan: ${def.id}`,
    "",
    def.planNote !== undefined
      ? `The ${def.id} output's units: ${def.planNote}.`
      : `The ${def.id} output's units (${def.plural}) mapped onto the core beats in \`${BEATS_FILE}\`.`,
    `A unit whose ${def.noun} exists carries its status.`,
    "",
    "| unit | title | beats | status |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.unit} | ${cell(r.title)} | ${r.beats.join(", ")} | ${cell(r.status)} |`),
    "",
  ].join("\n");
}

/** The marker, read; a refusal when it is unreadable. */
function marker(sub: string, workDir: string): { readonly ok: true; readonly marker: Marker } | OutputRefusal {
  const found = readMarker(workDir);
  if (!found.ok) return refuse(sub, found.message.replace(/^pablo: /, ""));
  return { ok: true, marker: found.marker };
}

/** A known type's definition, or the refusal naming every known type. */
function known(sub: string, type: string | undefined): { readonly ok: true; readonly def: OutputDefinition } | OutputRefusal {
  if (type === undefined || type === "") return refuse(sub, `name an output type (known: ${outputIds().join(", ")})`, [`<type>: ${outputIds().join(" | ")}`]);
  const def = outputDefinition(type);
  if (def === undefined) return refuse(sub, `unknown output type "${type}" (known: ${outputIds().join(", ")})`, [`<type>: ${outputIds().join(" | ")}`]);
  return { ok: true, def };
}

/** `pablo.json`'s raw object with `outputs` replaced by `next(outputs)`, every other key as written. */
function rewriteOutputs(workDir: string, next: (outputs: Record<string, unknown>) => Record<string, unknown>): string {
  const raw = JSON.parse(readFileSync(markerPath(workDir), "utf8")) as Record<string, unknown>;
  const current = typeof raw["outputs"] === "object" && raw["outputs"] !== null ? (raw["outputs"] as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...raw, outputs: next({ ...current }) };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** The deprecated `format` marker cannot be rewritten in place: it is migrated first. */
function legacyRefusal(sub: string, workDir: string, slug: string): OutputRefusal | undefined {
  const raw = JSON.parse(readFileSync(markerPath(workDir), "utf8")) as Record<string, unknown>;
  if (raw["format"] === undefined) return undefined;
  return refuse(sub, `pablo.json still uses the deprecated "format" key; run \`pablo migrate outputs --project ${slug}\` first`);
}

/** Refuses when any of `rels` (work-relative) has uncommitted changes, so the commit holds only this change. */
function dirtyRefusal(sub: string, vaultRoot: string, workDir: string, rels: readonly string[]): OutputRefusal | undefined {
  const present = rels.filter((rel) => existsSync(join(workDir, rel))).map((rel) => relative(vaultRoot, join(workDir, rel)));
  if (present.length === 0) return undefined;
  const dirty = dirtyPaths(vaultRoot, present);
  if (dirty.length === 0) return undefined;
  return refuse(sub, `uncommitted changes in ${dirty.join(", ")}; commit or discard them first`);
}

/** `pablo output list`: each declared output's units and next step, then the registered types not yet derived. */
export function listOutputs(workDir: string): OutputListResult {
  const found = marker("list", workDir);
  if (!found.ok) return found;
  const core = readCoreState(workDir);
  const outputs: OutputListEntry[] = [];
  for (const [type, entry] of Object.entries(found.marker.outputs)) {
    const def = outputDefinition(type);
    if (def === undefined) continue;
    const report = def.report(workDir, core);
    outputs.push({
      type,
      noun: def.noun,
      plural: def.plural,
      dir: report.dir,
      ...(entry.added !== undefined ? { added: entry.added } : {}),
      drafted: report.drafted,
      total: report.total,
      stages: def.stages,
      ...(report.next !== undefined ? { next: report.next } : {}),
    });
  }
  const declared = new Set(Object.keys(found.marker.outputs));
  return { ok: true, outputs, available: outputIds().filter((id) => !declared.has(id)) };
}

/** `pablo output add <type>`: declare, scaffold, plan and commit. */
export function addOutput(vaultRoot: string, workDir: string, type: string | undefined, opts: OutputVerbOptions = {}): OutputChangeResult {
  const def = known("add", type);
  if (!def.ok) return def;
  const id = def.def.id;
  const found = marker("add", workDir);
  if (!found.ok) return found;
  const legacy = legacyRefusal("add", workDir, found.marker.slug);
  if (legacy !== undefined) return legacy;
  if (found.marker.outputs[id] !== undefined) return refuse("add", `the work already has the ${id} output`);

  // D-7: an output declares the tracks it allows; a work on another track cannot add it.
  const track = trackOf(found.marker);
  if (!def.def.tracks.includes(track)) {
    const allowed = outputsOnTrack(track);
    return refuse("add", `the ${id} output is not allowed on the ${track} track (allowed: ${allowed.length === 0 ? "none" : allowed.join(", ")})`, [`<type>: ${allowed.join(" | ")}`]);
  }

  // A derived output (narrated, AGT-2137) reads another output's units: `--from` names it, and only it takes one.
  const from = opts.from?.trim() || undefined;
  if (def.def.derive === undefined && from !== undefined) return refuse("add", `--from is for a derived output (narrated); the ${id} output is drafted from the core`);
  if (def.def.derive !== undefined) {
    const prose = Object.keys(found.marker.outputs).filter((o) => {
      const d = outputDefinition(o);
      return d !== undefined && isNarratableSource(d);
    });
    if (from === undefined) return refuse("add", `the ${id} output reads another output; name it with --from (the work has: ${prose.length === 0 ? "no prose output" : prose.join(", ")})`, [`--from: ${prose.join(" | ")}`]);
    const source = outputDefinition(from);
    if (source === undefined || !isNarratableSource(source)) return refuse("add", `--from ${from} is not a prose output the ${id} output can read`, [`--from: ${prose.join(" | ")}`]);
    if (found.marker.outputs[from] === undefined) return refuse("add", `the work has no ${from} output to read; add it first (pablo output add ${from})`, [`output ${from} (pablo output add ${from})`]);
  }

  // An output maps its units onto the core's beats: the core must be at beats first.
  const core = readCoreState(workDir, trackOf(found.marker));
  const short = coreNext(core);
  if (short !== undefined) {
    const missing = coreStages(core)
      .filter((s) => !s.done && s.optional !== true && s.id !== "facts")
      .flatMap((s) => s.missing.map((m) => `core ${s.id}: ${m}`));
    return refuse("add", core.track === "nonfiction" ? `the core is not complete yet (${short})` : `the story core is not at beats yet (${short})`, missing);
  }

  // An output's own files (the fiction essay's thesis and outline, AGT-2135), written before the plan reads them.
  const thesis = opts.thesis?.trim() || undefined;
  if (thesis !== undefined && def.def.scaffold === undefined) return refuse("add", `--thesis is for the essay output; the ${id} output takes none`);
  const scaffold = def.def.scaffold?.(workDir, { thesis }) ?? { ok: true as const, files: [] };
  if (!scaffold.ok) {
    const refusal = refuse("add", scaffold.message, scaffold.missing.length === 0 ? undefined : scaffold.missing);
    return scaffold.ask === undefined ? refusal : { ...refusal, ask: scaffold.ask };
  }

  const plan = planFile(id);
  const rules = rulesFile(id);
  // The plan's content is read after pablo.json is rewritten: a derived output's plan is its source's (`outputs.<id>.from`).
  const writes: { rel: string; content: () => string }[] = [];
  for (const file of scaffold.files) if (!existsSync(join(workDir, file.rel))) writes.push({ rel: file.rel, content: () => file.content });
  if (!existsSync(join(workDir, plan))) writes.push({ rel: plan, content: () => renderPlan(def.def, def.def.plan(workDir)) });
  if (!existsSync(join(workDir, rules))) writes.push({ rel: rules, content: () => def.def.rulesTemplate });
  // The novel's ledger (AGT-1705): continuity extraction skips a work with none, so a novel added to a work gets one now.
  // A work that already has its ledger, at either name, keeps it.
  if (id === OUTPUTS.novel.id && !existsSync(join(workDir, NOVEL_CONTINUITY_FILE)) && !existsSync(join(workDir, LEGACY_CONTINUITY_FILE))) {
    writes.push({ rel: NOVEL_CONTINUITY_FILE, content: () => LEDGER_TEMPLATE });
  }
  const paths = ["pablo.json", ...writes.map((w) => w.rel)].sort();
  const dirty = dirtyRefusal("add", vaultRoot, workDir, ["pablo.json"]);
  if (dirty !== undefined) return dirty;

  const added = localDate((opts.now ?? (() => new Date()))());
  const entry = id === OUTPUTS.novel.id ? { dir: def.def.artifactDir, added } : from !== undefined ? { added, from } : { added };
  const markerText = rewriteOutputs(workDir, (outputs) => ({ ...outputs, [id]: entry }));
  // pablo.json first: a derived output's plan reads its source from the entry just written.
  writeFileSync(markerPath(workDir), markerText, "utf8");
  for (const w of writes) {
    mkdirSync(dirname(join(workDir, w.rel)), { recursive: true });
    writeFileSync(join(workDir, w.rel), w.content(), "utf8");
  }

  const { committed, notice } = gitCommit(vaultRoot, `${found.marker.slug}: add the ${id} output`, paths.map((rel) => join(workDir, rel)));
  return { ok: true, action: "add", type: id, paths, committed, ...(notice ? { notice } : {}) };
}

/** The first free `outputs/_removed/<type>-<date>[-K]`. */
function archiveDir(workDir: string, type: string, date: string): string {
  const base = `${REMOVED_DIR}/${type}-${date}`;
  if (!existsSync(join(workDir, base))) return base;
  for (let k = 2; ; k += 1) {
    if (!existsSync(join(workDir, `${base}-${k}`))) return `${base}-${k}`;
  }
}

/** `pablo output remove <type>`: undeclare and archive `outputs/<type>/`, in one commit. */
export function removeOutput(vaultRoot: string, workDir: string, type: string | undefined, opts: OutputVerbOptions = {}): OutputChangeResult {
  const def = known("remove", type);
  if (!def.ok) return def;
  const id = def.def.id;
  const found = marker("remove", workDir);
  if (!found.ok) return found;
  const legacy = legacyRefusal("remove", workDir, found.marker.slug);
  if (legacy !== undefined) return legacy;
  if (found.marker.outputs[id] === undefined) {
    const has = Object.keys(found.marker.outputs);
    return refuse("remove", `the work has no ${id} output (it has: ${has.length === 0 ? "none" : has.join(", ")})`);
  }

  // A narrated output reading this one (AGT-2137) would be left with nothing to read.
  const readers = Object.entries(found.marker.outputs).filter(([type, entry]) => type !== id && outputDefinition(type)?.derive !== undefined && entry["from"] === id).map(([type]) => type);
  if (readers.length > 0) return refuse("remove", `the ${readers.join(", ")} output reads the ${id} output; remove it first (pablo output remove ${readers[0]})`);

  const from = `${OUTPUTS_DIR}/${id}`;
  const moving = existsSync(join(workDir, from));
  const dirty = dirtyRefusal("remove", vaultRoot, workDir, ["pablo.json", ...(moving ? [from] : [])]);
  if (dirty !== undefined) return dirty;

  const to = moving ? archiveDir(workDir, id, localDate((opts.now ?? (() => new Date()))())) : undefined;
  const markerText = rewriteOutputs(workDir, (outputs) => {
    delete outputs[id];
    return outputs;
  });
  if (to !== undefined) {
    mkdirSync(dirname(join(workDir, to)), { recursive: true });
    renameSync(join(workDir, from), join(workDir, to));
  }
  writeFileSync(markerPath(workDir), markerText, "utf8");

  // Both sides of the move go in the pathspec: the old path stages as a removal, git records the rename.
  const paths = ["pablo.json", ...(to !== undefined ? [from, to] : [])].sort();
  const { committed, notice } = gitCommit(vaultRoot, `${found.marker.slug}: remove the ${id} output`, paths.map((rel) => join(workDir, rel)));
  return { ok: true, action: "remove", type: id, paths, committed, ...(to !== undefined ? { archived: to } : {}), ...(notice ? { notice } : {}) };
}

/**
 * The plan to write: the existing `plan.md`'s rows kept (the author edits the
 * mapping, so a unit's number, title and beats are never rewritten), their
 * status refreshed from the unit's file; a row whose unit has no file and
 * whose beats no longer all exist is dropped as stale; and a row appended for
 * every beat no kept row covers, from the type's default plan, numbered after
 * the last kept unit. With no existing plan this is the default
 * plan itself.
 */
export function mergePlan(def: OutputDefinition, workDir: string, existing: readonly PlanFileRow[]): PlanRow[] {
  const defaults = def.plan(workDir);
  if (existing.length === 0) return [...defaults];
  const units = new Map(def.report(workDir, readCoreState(workDir)).units.map((u) => [u.unit, u]));
  const beats = new Set(defaults.flatMap((r) => r.beats));
  const byUnit = new Map(defaults.map((r) => [r.unit, r]));
  const kept: PlanRow[] = [];
  for (const row of existing) {
    const unit = units.get(row.unit);
    // The type's own account of the unit wins (the default plan's status, the same one a first run wrote), else its file's.
    const status = byUnit.get(row.unit)?.status ?? (unit !== undefined && unit.file !== undefined ? unit.status : "beat");
    const drafted = status !== "beat" || (unit !== undefined && unit.file !== undefined);
    if (!drafted && row.beats.some((b) => !beats.has(b))) continue;
    kept.push({ unit: row.unit, title: row.title, beats: row.beats, status });
  }
  if (def.soleUnit !== undefined) return soleUnitPlan(def.soleUnit, kept, defaults);
  const covered = new Set(kept.flatMap((r) => r.beats));
  let next = Math.max(0, ...kept.map((r) => r.unit)) + 1;
  for (const d of defaults) {
    if (d.beats.length === 0 || d.beats.every((b) => covered.has(b))) continue;
    const unit = next;
    next += 1;
    for (const b of d.beats) covered.add(b);
    kept.push({ ...d, unit });
  }
  return kept.sort((a, b) => a.unit - b.unit);
}

/**
 * An output with one unit (the story, AGT-1705) never has a second row: every
 * kept row folds into the unit's. A beat added after the row was written
 * extends the row when it comes after the row's last beat (the story told so
 * far grows with the outline, "so far" meaning the row runs from the first
 * beat without a gap); a row that starts later or skips a beat is a chosen act
 * and is kept as the author wrote it. Rows an earlier plan appended for a
 * second unit are folded back into the first.
 */
function soleUnitPlan(sole: number, kept: readonly PlanRow[], defaults: readonly PlanRow[]): PlanRow[] {
  const base = kept.find((r) => r.unit === sole) ?? kept[0];
  if (base === undefined) return defaults.slice(0, 1).map((d) => ({ ...d, unit: sole }));
  const beats = new Set(kept.flatMap((r) => r.beats));
  const all = defaults.flatMap((r) => r.beats).sort((a, b) => a - b);
  const last = Math.max(0, ...beats);
  // The story so far: the row runs from the outline's first beat without a gap. Only that row grows with the outline.
  const sofar = all.filter((b) => b <= last).every((b) => beats.has(b)) && all[0] !== undefined && beats.has(all[0]);
  if (sofar) for (const b of all) if (b > last) beats.add(b);
  const status = kept.find((r) => r.status !== "beat")?.status ?? base.status;
  return [{ unit: sole, title: base.title, beats: [...beats].sort((a, b) => a - b), status }];
}

/** `pablo output plan <type>`: rewrite `outputs/<type>/plan.md` from the type's default plan and commit it. */
export function planOutput(vaultRoot: string, workDir: string, type: string | undefined, opts: { readonly dryRun?: boolean } = {}): OutputPlanResult {
  const def = known("plan", type);
  if (!def.ok) return def;
  const id = def.def.id;
  const found = marker("plan", workDir);
  if (!found.ok) return found;
  if (found.marker.outputs[id] === undefined) return refuse("plan", `the work has no ${id} output; add it with \`pablo output add ${id}\``);

  const rel = planFile(id);
  const abs = join(workDir, rel);
  const existing = existsSync(abs) ? parsePlanRows(readFileSync(abs, "utf8")) : [];
  const rows = mergePlan(def.def, workDir, existing);
  const text = renderPlan(def.def, rows);
  const changed = !existsSync(abs) || readFileSync(abs, "utf8") !== text;
  const dryRun = opts.dryRun === true;
  if (dryRun || !changed) return { ok: true, type: id, path: rel, rows, changed, dryRun, committed: false };

  const dirty = dirtyRefusal("plan", vaultRoot, workDir, [rel]);
  if (dirty !== undefined) return dirty;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, "utf8");
  const { committed, notice } = gitCommit(vaultRoot, `${found.marker.slug}: ${id} plan`, [abs]);
  return { ok: true, type: id, path: rel, rows, changed, dryRun, committed, ...(notice ? { notice } : {}) };
}
