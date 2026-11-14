/**
 * `pablo flag` (AGT-2305): flag performed lines for `pablo fix` from the command line, the way the review
 * player and the mixer's punch list do (their `flag` mutation, `review-host.ts`), so re-recording a line never needs a
 * window or a hand-edited `flags.json`. Pure over the work directory: it reads the newest manifest to know which
 * lines exist, appends to the output's `flags.json`, and loads no model.
 *
 * `--line` is `I`, `I,J,...` or `all` (0-based, as `fix --line` and the manifest's `i`). The reason is free text; `fix`
 * recognises the player's vocabulary (clipped, wrong voice, flat, rushed, other) and records any other as written.
 * Flagging a line again replaces the listener's earlier flag on it; the performer's own (`by: "auto"`) stays.
 */

import { readFileSync } from "node:fs";
import { readFlagsFile, writeFlagsFile } from "./review-host";
import { unitNoun } from "./outputs/audio";
import type { AudioOutput } from "./outputs/audio";
import { renderVersions } from "./outputs/radio/state";

export interface FlagRun {
  readonly work: string;
  readonly output: AudioOutput;
  readonly unit: number;
  /** `I`, `I,J,...` or `all`. */
  readonly line: string;
  readonly reason: string;
  readonly now?: Date;
}

export type FlagOutcome =
  | { readonly ok: true; readonly version: number; readonly lines: readonly number[]; readonly flags: readonly string[]; readonly message: string }
  | { readonly ok: false; readonly message: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The `i` of every line of the unit's newest performed version, or undefined when it is not performed. */
function performedLines(work: string, unit: number, output: AudioOutput): { version: number; lines: number[] } | undefined {
  const latest = renderVersions(work, unit, output).at(-1);
  if (latest === undefined) return undefined;
  try {
    const body: unknown = JSON.parse(readFileSync(latest.manifest, "utf8"));
    const lines = isRecord(body) && Array.isArray(body["lines"]) ? body["lines"] : [];
    return { version: latest.version, lines: lines.filter(isRecord).map((l) => l["i"]).filter((i): i is number => Number.isInteger(i)) };
  } catch {
    return undefined;
  }
}

/** `I[,J|all]` as line numbers within `known`, or the refusal. */
export function parseLines(spec: string, known: readonly number[]): { readonly lines: number[] } | { readonly error: string } {
  const text = spec.trim().toLowerCase();
  if (text === "all") return { lines: [...known] };
  const parts = text.split(",").map((p) => p.trim());
  const lines: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return { error: `--line must be a line number, a comma-separated list or all (got "${spec}")` };
    const n = Number(part);
    if (!known.includes(n)) return { error: `there is no line ${n} (lines 0-${known.length - 1})` };
    if (!lines.includes(n)) lines.push(n);
  }
  return { lines: lines.sort((a, b) => a - b) };
}

export function flagLines(run: FlagRun): FlagOutcome {
  const { work, output, unit } = run;
  const noun = `${output} ${unitNoun(output)} ${unit}`;
  const reason = run.reason.trim();
  if (reason === "") return { ok: false, message: `pablo flag needs a reason: pablo flag --line ${run.line} "<reason>"` };
  const performed = performedLines(work, unit, output);
  if (performed === undefined) return { ok: false, message: `${noun} is not performed, so there is no line to flag (pablo perform first)` };
  const parsed = parseLines(run.line, performed.lines);
  if ("error" in parsed) return { ok: false, message: `${noun} v${performed.version}: ${parsed.error}` };
  const file = readFlagsFile(work, output);
  const at = (run.now ?? new Date()).toISOString();
  const stamp = at.replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const flagged = new Set(parsed.lines);
  const isHumanHere = (f: Record<string, unknown>): boolean => f["episode"] === unit && flagged.has(f["line"] as number) && f["source"] !== "auto" && f["by"] !== "auto";
  const kept = file.flags.filter((f) => !isHumanHere(f));
  const ids = parsed.lines.map((line) => `f-${stamp}-ep${String(unit).padStart(2, "0")}-${line}`);
  parsed.lines.forEach((line, k) => kept.push({ id: ids[k], episode: unit, line, reason, source: "human", by: "cli", at }));
  writeFlagsFile(work, file, kept, output);
  const which = parsed.lines.length === 1 ? `line ${parsed.lines[0]}` : `lines ${parsed.lines.join(", ")}`;
  return { ok: true, version: performed.version, lines: parsed.lines, flags: ids, message: `flagged ${which} of ${noun} v${performed.version}: ${reason}; re-record with pablo fix` };
}
