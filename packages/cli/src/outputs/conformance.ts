/**
 * The conformance check every row of `OUTPUTS` must pass (AGT-1668, pm
 * project `pablo-story-core`): every field present and of the right kind,
 * then the type run end to end over a work (a tiny fixture with four beats in
 * the test) with a fake writer standing in for the model:
 *
 *   1. `plan` maps at least one unit onto the beats;
 *   2. `plan`, `preconditions`, `pack` and `report` are pure: the work
 *      directory is byte-identical after them;
 *   3. for each planned unit in order: its preconditions are met, its pack
 *      assembles, the fake writer's text lands at `artifactDir/unitFileName`,
 *      `unitOfPath` reads the unit back, `report` counts it drafted, and the
 *      after-merge rituals return without a failed step;
 *      (a type whose units share one file, the essay, puts each unit into
 *      that file through `shared.put`, keeping the units before it);
 *   4. `branch` and `unitOfBranch` round-trip;
 *   5. the first publish target publishes every unit.
 *
 * A failure throws `ConformanceError` naming the type and the field or step,
 * so a half-wired type cannot land.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { readCoreState } from "../core/machine";
import type { Marker } from "../marker";
import type { Ritual } from "../novel/rituals";
import type { OutputDefinition } from "./types";

export class ConformanceError extends Error {
  constructor(
    readonly type: string,
    readonly field: string,
    detail: string,
  ) {
    super(`pablo: output type "${type}" fails conformance at "${field}": ${detail}`);
    this.name = "ConformanceError";
  }
}

type FieldKind = "string" | "function" | "strings";

/** Every field an output type declares, and what it must be. */
export const OUTPUT_FIELDS: Readonly<Record<string, FieldKind>> = {
  id: "string",
  noun: "string",
  plural: "string",
  artifactDir: "string",
  rulesTemplate: "string",
  stages: "strings",
  tracks: "strings",
  plan: "function",
  preconditions: "function",
  pack: "function",
  "rituals.afterMerge": "function",
  "rituals.afterRevision": "function",
  "publish.targets": "strings",
  "publish.run": "function",
  report: "function",
  unitFileName: "function",
  unitOfPath: "function",
  branch: "function",
  unitOfBranch: "function",
};

function fieldValue(def: unknown, path: string): unknown {
  let value: unknown = def;
  for (const key of path.split(".")) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** The fields `def` is missing or has the wrong kind of value for, in `OUTPUT_FIELDS` order. Pure. */
export function missingFields(def: unknown): string[] {
  const missing: string[] = [];
  for (const [path, kind] of Object.entries(OUTPUT_FIELDS)) {
    const value = fieldValue(def, path);
    const ok =
      kind === "string"
        ? typeof value === "string" && value !== ""
        : kind === "function"
          ? typeof value === "function"
          : Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && v !== "");
    if (!ok) missing.push(path);
  }
  return missing;
}

/** Turns a model prompt into a unit's text, as the local writer would. Tests pass a deterministic fake. */
export type FakeWriter = (prompt: string, unit: number) => string;

export interface ConformanceOptions {
  readonly vaultRoot: string;
  /** A marker-valid work inside `vaultRoot` with a bible and beats, no units yet, in a git repository (the rituals commit). */
  readonly workDir: string;
  readonly marker: Marker;
  readonly writer: FakeWriter;
  /** The environment the rituals run with; give it a PATH without `think`. */
  readonly env: Record<string, string | undefined>;
  readonly now?: () => Date;
}

export interface ConformanceReport {
  readonly type: string;
  readonly units: readonly number[];
  readonly rituals: readonly Ritual[];
  readonly published: string;
}

/** A content hash of every file under `dir` except `.git` and `.pablo` (machine state), for the purity checks. */
function snapshot(dir: string): string {
  const hash = createHash("sha256");
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      if (name === ".git" || name === ".pablo") continue;
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else hash.update(`${relative(dir, path)}\0`).update(readFileSync(path)).update("\0");
    }
  };
  walk(dir);
  return hash.digest("hex");
}

/** Runs `def` through the conformance steps over `opts.workDir`; throws `ConformanceError` on the first failure. */
export async function runConformance(def: unknown, opts: ConformanceOptions): Promise<ConformanceReport> {
  const id = typeof fieldValue(def, "id") === "string" ? (fieldValue(def, "id") as string) : "(no id)";
  const missing = missingFields(def);
  if (missing.length > 0) throw new ConformanceError(id, missing[0] as string, `missing or invalid field(s): ${missing.join(", ")}`);
  const type = def as OutputDefinition;
  const fail = (field: string, detail: string): never => {
    throw new ConformanceError(id, field, detail);
  };

  const before = snapshot(opts.workDir);
  const plan = type.plan(opts.workDir);
  if (plan.length === 0) fail("plan", "maps no unit onto the work's beats");
  for (const row of plan) {
    if (!Number.isInteger(row.unit) || row.unit < 1) fail("plan", `unit ${String(row.unit)} is not a positive integer`);
    if (row.beats.length === 0 && plan.length > 1) fail("plan", `unit ${row.unit} names no beat`);
  }
  const first = plan[0] as (typeof plan)[number];
  const ready = type.preconditions(opts.workDir, first.unit);
  if (!ready.ready) fail("preconditions", `unit ${first.unit} is not ready on a fresh work: ${ready.missing.join("; ")}`);
  const pack = type.pack(opts.vaultRoot, opts.workDir, first.unit, { marker: opts.marker, output: type.id });
  if (!pack.ok) fail("pack", pack.message);
  type.report(opts.workDir, readCoreState(opts.workDir));
  if (snapshot(opts.workDir) !== before) fail("plan", "plan, preconditions, pack or report wrote to the work directory");

  const rituals: Ritual[] = [];
  const units: number[] = [];
  for (const row of plan) {
    const pre = type.preconditions(opts.workDir, row.unit);
    if (!pre.ready) fail("preconditions", `unit ${row.unit} is not ready after the units before it: ${pre.missing.join("; ")}`);
    const packed = type.pack(opts.vaultRoot, opts.workDir, row.unit, { marker: opts.marker, output: type.id });
    if (!packed.ok) fail("pack", packed.message);
    if (!packed.ok) continue;
    if (packed.pack.prompt.trim() === "") fail("pack", `unit ${row.unit}'s prompt is empty`);

    const fileName = type.unitFileName(row.unit, row.title);
    const path = join(opts.workDir, type.artifactDir, fileName);
    const rel = relative(opts.workDir, path).split(sep).join("/");
    mkdirSync(join(opts.workDir, type.artifactDir), { recursive: true });
    const text = opts.writer(packed.pack.prompt, row.unit).trim();
    if (type.shared === undefined) {
      if (type.unitOfPath(rel) !== row.unit) fail("unitOfPath", `${rel} does not read back as unit ${row.unit}`);
      writeFileSync(path, `${text}\n`, "utf8");
    } else {
      // A section of a shared file (the essay): the file reads as one of the type's, and the unit lands in it beside the others.
      if (type.unitOfPath(rel) === undefined) fail("unitOfPath", `${rel} does not read back as a unit`);
      const before = existsSync(path) ? readFileSync(path, "utf8") : undefined;
      const after = type.shared.put(opts.workDir, before, row.unit, text, "---\nmodel: conformance-fake\nprompt_hash: conformance\n---");
      if (!type.shared.has(opts.workDir, after, row.unit)) fail("shared.put", `unit ${row.unit} is not in ${rel} after it was put there`);
      for (const done of units) if (!type.shared.has(opts.workDir, after, done)) fail("shared.put", `unit ${done} was lost from ${rel} when unit ${row.unit} was put there`);
      writeFileSync(path, after, "utf8");
    }

    const report = type.report(opts.workDir, readCoreState(opts.workDir));
    if (!report.units.some((u) => u.unit === row.unit && u.file !== undefined)) fail("report", `unit ${row.unit} is not reported drafted after it was written`);

    const ran = await type.rituals.afterMerge(opts.workDir, row.unit, path, {
      slug: opts.marker.slug,
      words: 0,
      model: "conformance-fake",
      receiptLine: "conformance",
      output: type.id,
      unitNoun: type.noun,
      env: opts.env,
      ...(opts.now ? { now: opts.now } : {}),
    });
    const failed = ran.filter((r) => r.status === "failed");
    if (failed.length > 0) fail("rituals.afterMerge", failed.map((r) => `${r.name}: ${r.detail}`).join("; "));
    rituals.push(...ran);
    units.push(row.unit);

    const branch = type.branch(row.unit);
    if (type.unitOfBranch(branch) !== row.unit) fail("unitOfBranch", `${branch} does not read back as unit ${row.unit}`);
  }

  const target = type.publish.targets[0] as string;
  const published = type.publish.run(opts.workDir, opts.marker.slug, opts.marker.title, target);
  if (!published.ok) fail("publish.run", published.message);
  if (published.ok && !existsSync(published.where)) fail("publish.run", `${published.where} was not written`);
  return { type: id, units, rituals, published: published.ok ? published.where : "" };
}
