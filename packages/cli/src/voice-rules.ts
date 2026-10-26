/**
 * Editable voice rules (AGT-2140, pablo-platform D-15): the layer targets
 * `voice rule --target global|vault|work|output:<type>` append to, the rule ids
 * `voice list` shows, and `voice edit` / `voice remove` / `voice use`.
 *
 * A rule is a `- <text>` bullet under a `## Rules` section (a work's `QWEN.md`
 * may keep it under `## Ground rules ...`), optionally followed by indented
 * lines (the `Flagged: "..."` example). Its id is the first six hex digits of
 * the sha1 of its text, so an id is stable while other rules come and go and
 * changes only when the rule itself is edited (`voice edit` returns the new one).
 * The same text in two files has the same id: those calls are refused until
 * `--target` says which.
 *
 * Layer files: global `<global voices>/default/voice.md`, vault `style/prose.md`,
 * work `QWEN.md`, output `outputs/<type>/RULES.md`; named voices keep theirs in
 * `voice.md` (target `voice:<name>`).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { outputRulesFile } from "@openthink/pablo-core";
import { gitCommit, SLUG_PATTERN } from "./init";
import { GLOBAL_DEFAULT_VOICE, WORK_RULES_FILE } from "./voice-layers";
import { findVault, resolveProject } from "./project";
import type { Refusal } from "./project";
import { markerPath, readMarker } from "./marker";
import { globalVoicesDir, resolveVoice } from "./voice";

function refuse(message: string, tried: readonly string[] = []): Refusal {
  return { ok: false, code: 2, message, tried };
}

type Env = Record<string, string | undefined>;

/** A layer a rule can be written to by `--target`; `output:<type>` carries the output id. */
export type LayerTarget = "global" | "vault" | "work" | `output:${string}`;

/** What `--target` accepts, for usage and error text. */
export const TARGET_USAGE = "global|vault|work|output:<type>";

/** Parses a `--target` value naming a layer; `undefined` for anything else (including the legacy `voice`). */
export function parseLayerTarget(raw: string | undefined): LayerTarget | undefined {
  if (raw === undefined) return undefined;
  if (raw === "global" || raw === "vault" || raw === "work") return raw;
  if (raw.startsWith("output:")) {
    const type = raw.slice("output:".length);
    if (/^[a-z][a-z0-9-]*$/.test(type)) return `output:${type}` as LayerTarget;
  }
  return undefined;
}

export interface RuleContext {
  readonly cwd: string;
  readonly env: Env;
  /** The work's directory, for `work` and `output:<type>` targets. */
  readonly projectPath?: string | undefined;
}

export interface RuleFile {
  readonly ok: true;
  readonly path: string;
  /** Whether a commit is meaningful: false for the global layer (no vault repo). */
  readonly commit: boolean;
}

/** The file a layer target writes to (nothing is created here). */
export function ruleFileFor(target: LayerTarget, ctx: RuleContext): RuleFile | Refusal {
  if (target === "global") return { ok: true, path: join(globalVoicesDir(ctx.env), GLOBAL_DEFAULT_VOICE, "voice.md"), commit: false };
  if (target === "vault") {
    const vault = findVault(ctx.cwd, ctx.env);
    if (!vault.ok) return vault;
    return { ok: true, path: join(vault.path, "style", "prose.md"), commit: true };
  }
  if (ctx.projectPath === undefined) return refuse(`pablo: voice: --target ${target} needs a project (--project <slug>)`);
  if (target === "work") {
    const path = join(ctx.projectPath, WORK_RULES_FILE);
    return existsSync(path) ? { ok: true, path, commit: true } : refuse(`pablo: voice rule: the work has no ${WORK_RULES_FILE} (${path})`, [path]);
  }
  return { ok: true, path: join(ctx.projectPath, outputRulesFile(target.slice("output:".length))), commit: true };
}

// ---------------------------------------------------------------------------
// Parsing

const RULES_SECTION = /^##\s+(rules|ground rules\b.*)\s*$/i;

export interface ParsedRule {
  readonly text: string;
  /** First line of the bullet, and one past its last continuation line. */
  readonly start: number;
  readonly end: number;
}

/** The bullets (with their indented continuation lines) under every rules section of `text`. */
export function parseRules(text: string): ParsedRule[] {
  const lines = text.split("\n");
  const rules: ParsedRule[] = [];
  let inRules = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^#{1,6}\s/.test(line)) {
      inRules = RULES_SECTION.test(line.trim());
      continue;
    }
    if (!inRules || !line.startsWith("- ")) continue;
    let end = i + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end] ?? "")) end += 1;
    rules.push({ text: line.slice(2).trim(), start: i, end });
    i = end - 1;
  }
  return rules;
}

/** A rule's stable id: six hex digits of the sha1 of its text. */
export function ruleId(text: string): string {
  return createHash("sha1").update(text.trim()).digest("hex").slice(0, 6);
}

export interface RuleEntry {
  readonly id: string;
  /** `global`, `vault`, `work`, `output:<type>` or `voice:<name>`. */
  readonly target: string;
  readonly path: string;
  readonly text: string;
}

function entriesOf(file: string, target: string): RuleEntry[] {
  if (!existsSync(file) || !statSync(file).isFile()) return [];
  return parseRules(readFileSync(file, "utf8")).map((r) => ({ id: ruleId(r.text), target, path: file, text: r.text }));
}

function subdirs(dir: string, scopeSkip: string | undefined): { name: string; path: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== scopeSkip)
    .map((e) => ({ name: e.name, path: join(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Every rule visible from `ctx`, layer by layer (global, vault, named voices, work, outputs). */
export function listRules(ctx: RuleContext): RuleEntry[] {
  const out: RuleEntry[] = [];
  const globalDir = globalVoicesDir(ctx.env);
  out.push(...entriesOf(join(globalDir, GLOBAL_DEFAULT_VOICE, "voice.md"), "global"));

  const vault = findVault(ctx.cwd, ctx.env);
  if (vault.ok) out.push(...entriesOf(join(vault.path, "style", "prose.md"), "vault"));
  if (vault.ok) for (const v of subdirs(join(vault.path, "voices"), undefined)) out.push(...entriesOf(join(v.path, "voice.md"), `voice:${v.name}`));
  for (const v of subdirs(globalDir, GLOBAL_DEFAULT_VOICE)) out.push(...entriesOf(join(v.path, "voice.md"), `voice:${v.name}`));

  if (ctx.projectPath !== undefined) {
    out.push(...entriesOf(join(ctx.projectPath, WORK_RULES_FILE), "work"));
    for (const o of subdirs(join(ctx.projectPath, "outputs"), undefined)) out.push(...entriesOf(join(ctx.projectPath, outputRulesFile(o.name)), `output:${o.name}`));
  }
  return out;
}

// ---------------------------------------------------------------------------
// edit / remove

export interface RuleChanged {
  readonly ok: true;
  readonly id: string;
  readonly target: string;
  readonly path: string;
  readonly committed: boolean;
  readonly notice?: string;
}

function flatten(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

function locate(id: string, ctx: RuleContext, target: string | undefined): RuleEntry | Refusal {
  const wanted = id.trim().toLowerCase();
  const all = listRules(ctx).filter((e) => e.id === wanted && (target === undefined || e.target === target));
  if (all.length === 0) {
    const hint = ctx.projectPath === undefined ? "; work and output rules need --project <slug>" : "";
    return refuse(`pablo: voice: no rule with id "${id}"${target ? ` in target ${target}` : ""} (see \`pablo voice list\`${hint})`);
  }
  const first = all[0] as RuleEntry;
  if (all.some((e) => e.path !== first.path)) {
    const where = all.map((e) => `${e.target} (${e.path})`).join(", ");
    return refuse(`pablo: voice: rule ${wanted} is in more than one file: ${where}; pass --target to choose`, all.map((e) => e.path));
  }
  return first;
}

function commitRule(path: string, target: string, message: string): { committed: boolean; notice?: string } {
  if (target === "global") return { committed: false };
  return gitCommit(dirname(path), message, [path]);
}

/** `pablo voice edit <id> "<text>"`: replaces one rule's text, keeping its example lines. */
export function editRule(id: string, text: string, ctx: RuleContext, opts: { readonly target?: string } = {}): RuleChanged | Refusal {
  const safe = flatten(text);
  if (safe === "") return refuse("pablo: voice edit: text must not be empty");
  const found = locate(id, ctx, opts.target);
  if ("code" in found) return found;
  const lines = readFileSync(found.path, "utf8").split("\n");
  const rule = parseRules(lines.join("\n")).find((r) => r.text === found.text);
  if (rule === undefined) return refuse(`pablo: voice edit: rule ${found.id} vanished from ${found.path}`);
  if (lines.includes(`- ${safe}`) && safe !== found.text) return refuse(`pablo: voice edit: already a rule in ${found.path}`);
  lines[rule.start] = `- ${safe}`;
  writeFileSync(found.path, lines.join("\n"), "utf8");
  const { committed, notice } = commitRule(found.path, found.target, `voice: edit a rule in ${basename(found.path)}`);
  return { ok: true, id: ruleId(safe), target: found.target, path: found.path, committed, ...(notice ? { notice } : {}) };
}

/** `pablo voice remove <id>`: deletes one rule (its bullet and example lines). */
export function removeRule(id: string, ctx: RuleContext, opts: { readonly target?: string } = {}): RuleChanged | Refusal {
  const found = locate(id, ctx, opts.target);
  if ("code" in found) return found;
  const lines = readFileSync(found.path, "utf8").split("\n");
  const rule = parseRules(lines.join("\n")).find((r) => r.text === found.text);
  if (rule === undefined) return refuse(`pablo: voice remove: rule ${found.id} vanished from ${found.path}`);
  lines.splice(rule.start, rule.end - rule.start);
  writeFileSync(found.path, lines.join("\n"), "utf8");
  const { committed, notice } = commitRule(found.path, found.target, `voice: remove a rule from ${basename(found.path)}`);
  return { ok: true, id: found.id, target: found.target, path: found.path, committed, ...(notice ? { notice } : {}) };
}

// ---------------------------------------------------------------------------
// use

export interface VoiceUsed {
  readonly ok: true;
  readonly voice: readonly string[];
  readonly added: boolean;
  readonly path: string;
  readonly committed: boolean;
  readonly notice?: string;
}

/**
 * `pablo voice use <name> --project <slug>`: adds a named voice to the work's
 * `pablo.json` `voice` list (the default list when the marker has none), unless
 * it is already there. Edits the JSON in place so every other key survives.
 */
export function useVoice(name: string, ctx: { cwd: string; env: Env }, projectPath: string): VoiceUsed | Refusal {
  const trimmed = name.trim();
  if (!SLUG_PATTERN.test(trimmed)) return refuse(`pablo: voice use: "${trimmed}" is not a voice name (lowercase letters, digits and dashes)`);
  const found = resolveVoice(trimmed, { cwd: ctx.cwd, env: ctx.env });
  if (!found.ok) return found;

  const path = markerPath(projectPath);
  const marker = readMarker(projectPath);
  if (!marker.ok) return marker;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return refuse(`pablo: voice use: ${path} is not readable JSON`, [path]);
  }
  const current = [...marker.marker.voice];
  if (current.includes(trimmed)) return { ok: true, voice: current, added: false, path, committed: false };
  const next = [...current, trimmed];
  writeFileSync(path, `${JSON.stringify({ ...data, voice: next }, null, 2)}\n`, "utf8");
  const { committed, notice } = gitCommit(dirname(path), `voice: use ${trimmed}`, [path]);
  return { ok: true, voice: next, added: true, path, committed, ...(notice ? { notice } : {}) };
}

/** The nearest ancestor of `cwd` (inclusive) holding a valid `pablo.json`, if any. */
export function workFromCwd(cwd: string): string | undefined {
  let dir = resolvePath(cwd);
  for (;;) {
    if (readMarker(dir).ok) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
