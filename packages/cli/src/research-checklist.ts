/**
 * `research plan`, `research waive` and `research link` (AGT-2111, pm project `pablo-platform`, D-9): guided
 * research. `plan` asks the research agent (the `research` intent, as `research distill` does; tests inject a fake
 * adapter) to derive the checklist from the period brief (historical-fiction: people, places, technology, language,
 * daily life, politics, dates) or the thesis (nonfiction: the claims to support), checks every proposed item, and
 * writes `research/checklist.md` on a `plan/` branch for the author to review. `waive` closes an item with a reason;
 * `link` (and `research save --item N`) closes one with a research note. The file's shape and the status rules are
 * `core/checklist.ts`'s; the gate that reads it is `core/machine.ts`'s.
 *
 * The brief and the thesis go to the research agent, never to the drafting model; the checklist lives under
 * `research/`, which no drafting pack reads.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Adapter, createProviders, EndpointHung, loadConfig, ProviderConfigError, ProviderResponseError } from "@openthink/pablo-core";
import {
  CHECKLIST_FILE,
  type ChecklistOrigin,
  type ChecklistItem,
  type ChecklistRow,
  checklistItems,
  defaultChecklistMax,
  MAX_CHECKLIST_ITEMS,
  MAX_ITEM_CHARS,
  mergeChecklist,
  noteHasSources,
  parseItemSpec,
  PERIOD_CATEGORIES,
  type ProposedItem,
  parseChecklist,
  renderChecklist,
  THESIS_CATEGORIES,
} from "./core/checklist";
import { PERIOD_BRIEF_FILE, readCoreState } from "./core/machine";
import { CLAIMS_FILE, hasProse, researchNoteId, THESIS_FILE } from "./core/nonfiction";
import { completeText, RESEARCH_INTENT } from "./distill";
import { fileAt, listBranches } from "./branch";
import { readMarker, trackOf } from "./marker";
import { type PlanSession, planWrite } from "./plan";
import type { TrackId } from "./tracks/registry";
import type { VerbResult } from "./verbs";

const REFUSED = 2;

function refuse(message: string, extra: Record<string, unknown> = {}): VerbResult {
  return { body: { ok: false, code: REFUSED, message, ...extra }, exitCode: REFUSED };
}

function fail(message: string): VerbResult {
  return { body: { ok: false, code: 1, message }, exitCode: 1 };
}

function readIfPresent(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** What a track's checklist is derived from: nonfiction plans from the thesis, every other track from the period brief. */
export function checklistOrigin(track: TrackId): ChecklistOrigin {
  return track === "nonfiction" ? "thesis" : "period";
}

function categoriesFor(origin: ChecklistOrigin): readonly string[] {
  return origin === "thesis" ? THESIS_CATEGORIES : PERIOD_CATEGORIES;
}

/** The prompt the research agent answers. Pure. */
export function planPrompt(origin: ChecklistOrigin, source: string, opts: { claims?: string; existing?: readonly ChecklistRow[]; limit?: number } = {}): string {
  const ask =
    origin === "thesis"
      ? [
          "You are planning the research for a work of nonfiction from its thesis.",
          'List every claim the thesis depends on that a source has to support: one checkable claim per item, category "claim".',
        ]
      : [
          "You are planning the research for a historical novel from its period brief.",
          `List what the writer has to look up before drafting, one specific, checkable question or subject per item, under these categories: ${PERIOD_CATEGORIES.join(", ")}.`,
          "people: who lived through it and who ran things; places: the streets, buildings and landscapes; technology: the tools, machines and trades; language: the words, slang and forms of address; daily-life: food, prices, clothing, work, the weather of a season; politics: the laws, parties and events in the air; dates: when things happened.",
          "Cover every category the brief touches; where the brief says nothing about one, give the one thing a scene would most likely get wrong.",
        ];
  const existing = opts.existing ?? [];
  return [
    ...ask,
    `Keep each item under 200 characters. ${existing.length > 0 ? "The checklist already has the items listed below; do not repeat them." : ""}`.trim(),
    ...(opts.limit !== undefined ? [`Size the list to the work: give at most ${opts.limit} items in all, the ones a scene would most likely get wrong first; do not pad a short work.`] : []),
    'Answer with JSON only, no prose and no code fence: {"items": [{"category": "...", "item": "..."}]}',
    "",
    origin === "thesis" ? "## Thesis" : "## Period brief",
    "",
    source.trim(),
    ...(opts.claims ? ["", "## Claims so far", "", opts.claims.trim()] : []),
    ...(existing.length > 0 ? ["", "## Already on the checklist", "", ...existing.map((r) => `- ${r.category}: ${r.item}`)] : []),
    "",
  ].join("\n");
}

/** The model's answer as proposed items; `undefined` when it is not the JSON asked for. Tolerates a code fence and a bare array. */
export function parsePlanAnswer(text: string): ProposedItem[] | undefined {
  const stripped = text.replace(/```(?:json)?/g, "").trim();
  const start = stripped.search(/[[{]/);
  if (start < 0) return undefined;
  const close = stripped[start] === "[" ? "]" : "}";
  const end = stripped.lastIndexOf(close);
  if (end < start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { items?: unknown } | null)?.items;
  if (!Array.isArray(list)) return undefined;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return list.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return { category: str(r["category"]), item: str(r["item"]) };
  });
}

/** The ids of the work's sourced notes (a `## Sources` entry), as the gate counts them. */
function sourcedNoteIds(projectPath: string, track: TrackId): Set<string> {
  return new Set(readCoreState(projectPath, track).sourcedResearch.map((rel) => researchNoteId(rel.split("\\").join("/"))));
}

/** The plan session and the work's directory relative to the repo root, or a refusal (`research-verbs.ts`'s). */
export type PlanSessionFor = (projectPath: string) => { ok: true; session: PlanSession; dir: string } | { ok: false; result: VerbResult };

/** What `planChecklistInProject` needs beyond the project: the research agent, injected in tests. */
export interface PlanDeps {
  readonly researcher?: Adapter | undefined;
  readonly stderr?: { write(text: string): unknown } | undefined;
  /** `--max N` (AGT-2186): the most items the checklist may hold in all; default sized to the work (`defaultChecklistMax`). */
  readonly max?: number | undefined;
}

/**
 * `research plan`: the research agent derives checklist items from the brief or thesis; pablo keeps every existing
 * row, appends the new items that pass its checks (a known category, short, not a repeat), gives any category left
 * empty a placeholder to source or waive, and writes `research/checklist.md` on a new `plan/` branch.
 */
export async function planChecklistInProject(
  projectPath: string,
  env: NodeJS.ProcessEnv,
  planSessionFor: PlanSessionFor,
  deps: PlanDeps = {},
): Promise<VerbResult> {
  const marker = readMarker(projectPath);
  if (!marker.ok) return refuse(marker.message);
  const track = trackOf(marker.marker);
  const origin = checklistOrigin(track);
  const sourceFile = origin === "thesis" ? THESIS_FILE : PERIOD_BRIEF_FILE;
  const sourceText = (readIfPresent(join(projectPath, sourceFile)) ?? "").replace(/^---\n[\s\S]*?\n---\n?/, "");
  if (!hasProse(sourceText)) {
    const what = origin === "thesis" ? "the thesis (pablo save --stage thesis)" : "the period brief";
    return refuse(`pablo: research plan: ${sourceFile} has no text; write ${what} first, the checklist is derived from it`, { missing: [sourceFile] });
  }
  const existing = parseChecklist(readIfPresent(join(projectPath, CHECKLIST_FILE)) ?? "");
  if (deps.max !== undefined && (!Number.isInteger(deps.max) || deps.max < 1 || deps.max > MAX_CHECKLIST_ITEMS)) {
    return refuse(`pablo: research plan: --max is a whole number from 1 to ${MAX_CHECKLIST_ITEMS}, got ${String(deps.max)}`);
  }
  const words = sourceText.split(/\s+/).filter(Boolean).length;
  const max = deps.max ?? defaultChecklistMax(words, Object.keys(marker.marker.outputs).length);
  if (existing.length >= max) {
    return refuse(`pablo: research plan: the checklist already has ${existing.length} items, at its cap of ${max}; nothing written (raise it with --max N)`, { max });
  }
  const claims = origin === "thesis" ? readIfPresent(join(projectPath, CLAIMS_FILE)) : undefined;

  let adapter: Adapter;
  try {
    adapter = deps.researcher ?? createProviders(loadConfig({ env, projectDir: projectPath })).adapterFor(RESEARCH_INTENT);
  } catch (error) {
    if (error instanceof ProviderConfigError) return refuse(error.message);
    throw error;
  }
  deps.stderr?.write(`pablo: research plan: asking ${adapter.id} (${adapter.model}) for the checklist from ${sourceFile}\n`);
  let answer: string;
  try {
    answer = await completeText(adapter, planPrompt(origin, sourceText, { ...(claims ? { claims } : {}), existing, limit: max - existing.length }));
  } catch (error) {
    if (error instanceof EndpointHung || error instanceof ProviderResponseError) return fail(error.message);
    if (error instanceof ProviderConfigError) return refuse(error.message);
    throw error;
  }
  const proposed = parsePlanAnswer(answer);
  if (proposed === undefined) {
    return fail(`pablo: research plan: the research agent (${adapter.id}) did not answer with the checklist JSON asked for; run it again, or route the research intent to another provider`);
  }

  const merged = mergeChecklist(existing, proposed, categoriesFor(origin), max);
  if (merged.added === 0) {
    return refuse("pablo: research plan: nothing new for the checklist; nothing written", { rejected: merged.rejected });
  }
  const items = checklistItems(merged.rows, sourcedNoteIds(projectPath, track));
  const planned = planSessionFor(projectPath);
  if (!planned.ok) return planned.result;
  const path = `${planned.dir ? `${planned.dir}/` : ""}${CHECKLIST_FILE}`;
  const written = planWrite(planned.session, {
    path,
    content: renderChecklist(items, origin),
    message: `research: plan ${merged.added} checklist item${merged.added === 1 ? "" : "s"}`,
  });
  if (!written.ok) return fail(written.notice);
  return {
    body: {
      ok: true,
      path,
      branch: planned.session.branch,
      ...(written.sha ? { sha: written.sha } : {}),
      added: merged.added,
      max,
      items: items.map((i) => ({ number: i.number, category: i.category, item: i.item, status: i.status })),
      rejected: merged.rejected,
      from: sourceFile,
      provider: adapter.id,
      model: adapter.model,
    },
    exitCode: 0,
  };
}

/** `3`, `#3` -> 3; anything else -> undefined. */
export function parseItemNumber(raw: string | number | undefined): number | undefined {
  const text = String(raw ?? "").trim().replace(/^#/, "");
  return /^\d+$/.test(text) && Number(text) > 0 ? Number(text) : undefined;
}

/** The work's checklist rows and track, or a refusal naming `research plan`. */
function readChecklistFor(
  projectPath: string,
  verb: string,
  planSessionFor?: PlanSessionFor,
): { ok: true; rows: ChecklistRow[]; track: TrackId } | { ok: false; result: VerbResult } {
  const marker = readMarker(projectPath);
  if (!marker.ok) return { ok: false, result: refuse(marker.message) };
  const text = readIfPresent(join(projectPath, CHECKLIST_FILE));
  if (text === undefined) {
    const planned = planSessionFor?.(projectPath);
    const listed = planned?.ok ? listBranches(planned.session.repo) : undefined;
    const path = planned?.ok ? `${planned.dir ? `${planned.dir}/` : ""}${CHECKLIST_FILE}` : CHECKLIST_FILE;
    const holding = planned?.ok && listed?.ok ? listed.branches.plan.filter((b) => fileAt(planned.session.repo, b, path) !== undefined) : [];
    const where = holding.length > 0 ? `accept ${holding.join(", ")} first (it holds the planned checklist)` : "run `pablo research plan` and merge its branch first";
    return { ok: false, result: refuse(`pablo: research ${verb}: ${CHECKLIST_FILE} does not exist; ${where}`, holding.length > 0 ? { acceptFirst: holding } : {}) };
  }
  return { ok: true, rows: parseChecklist(text), track: trackOf(marker.marker) };
}

/** Every number in `wanted` that names no row, as a refusal; `undefined` when each exists. */
function unknownItems(rows: readonly ChecklistRow[], wanted: readonly number[], verb: string): VerbResult | undefined {
  const unknown = wanted.filter((n) => !rows.some((r) => r.number === n));
  if (unknown.length === 0) return undefined;
  return refuse(`pablo: research ${verb}: ${CHECKLIST_FILE} has no item ${unknown.map((n) => `#${n}`).join(", ")} (items: ${rows.map((r) => `#${r.number}`).join(", ") || "none"})`);
}

/** Writes `rows` back as the checklist on `session`, with statuses worked out against `sourced`. */
function writeRows(session: PlanSession, dir: string, rows: readonly ChecklistRow[], track: TrackId, sourced: ReadonlySet<string>, message: string) {
  const items = checklistItems(rows, sourced);
  const path = `${dir ? `${dir}/` : ""}${CHECKLIST_FILE}`;
  return { path, items, written: planWrite(session, { path, content: renderChecklist(items, checklistOrigin(track)), message }) };
}

/** What `waive`/`link` take to name items: `3`, `#3`, `1,3,5-8`, or an array of those (MCP). */
export type ItemSelector = string | number | readonly (string | number)[] | undefined;

/** The item numbers `item` names, or a refusal for `verb` (`usage` shows the call's shape). */
function selectItems(item: ItemSelector, verb: string, usage: string): { ok: true; numbers: number[] } | { ok: false; result: VerbResult } {
  const spec = parseItemSpec(item);
  if (spec.ok) return spec;
  return { ok: false, result: refuse(`pablo: research ${verb}: name the items by number (${usage}): ${spec.message}`) };
}

/** `#1, #3`: items named in a commit message. */
function numbersLabel(numbers: readonly number[]): string {
  return numbers.map((n) => `#${n}`).join(", ");
}

/**
 * `research waive <#,#,a-b> "<reason>"`: every named item is waived with the reason, on one new `plan/` branch
 * (AGT-2186: closing a batch is one branch, not one per item).
 */
export function waiveItemInProject(projectPath: string, item: ItemSelector, reason: string | undefined, planSessionFor: PlanSessionFor): VerbResult {
  const selected = selectItems(item, "waive", 'pablo research waive <#,#,a-b> "<reason>"');
  if (!selected.ok) return selected.result;
  const numbers = selected.numbers;
  const why = (reason ?? "").replace(/\s+/g, " ").trim();
  if (why === "") return refuse(`pablo: research waive: a waived item needs a reason (pablo research waive ${numbers.join(",")} "<reason>")`);
  if (why.length > MAX_ITEM_CHARS) return refuse(`pablo: research waive: keep the reason under ${MAX_ITEM_CHARS} characters`);
  const read = readChecklistFor(projectPath, "waive", planSessionFor);
  if (!read.ok) return read.result;
  const unknown = unknownItems(read.rows, numbers, "waive");
  if (unknown) return unknown;
  const rows = read.rows.map((r) => (numbers.includes(r.number) ? { ...r, waived: why } : r));
  const planned = planSessionFor(projectPath);
  if (!planned.ok) return planned.result;
  const out = writeRows(planned.session, planned.dir, rows, read.track, sourcedNoteIds(projectPath, read.track), `research: waive checklist item${numbers.length === 1 ? "" : "s"} ${numbersLabel(numbers)}`);
  if (!out.written.ok) return fail(out.written.notice);
  const waived = out.items.filter((i) => numbers.includes(i.number));
  return {
    body: {
      ok: true,
      path: out.path,
      branch: planned.session.branch,
      ...(out.written.sha ? { sha: out.written.sha } : {}),
      ...(waived.length === 1 ? { item: waived[0] } : {}),
      items: waived,
      open: out.items.filter((i) => i.status === "open").length,
    },
    exitCode: 0,
  };
}

/** A research note not on main yet, found on a `plan/` branch. */
export interface PendingNote {
  readonly note: string;
  readonly branch: string;
}

/** The `plan/` branches whose copy of `research/<id>.md` has a `## Sources` entry, as the repo holds them (none outside a repo). */
function pendingNoteBranches(planSessionFor: PlanSessionFor, projectPath: string, id: string): string[] {
  const planned = planSessionFor(projectPath);
  if (!planned.ok) return [];
  const listed = listBranches(planned.session.repo);
  if (!listed.ok) return [];
  const path = `${planned.dir ? `${planned.dir}/` : ""}research/${id}.md`;
  return listed.branches.plan.filter((branch) => {
    const text = fileAt(planned.session.repo, branch, path);
    return text !== undefined && noteHasSources(text);
  });
}

/**
 * `research link <#,#,a-b> <note>`: the sourced note joins each named item's Sources, on one new `plan/` branch. A
 * note that is still on an unmerged `plan/` branch (`research save` without `--item`, not accepted yet) links all
 * the same, and the result names the branch to accept with it (AGT-2186).
 */
export function linkItemInProject(projectPath: string, item: ItemSelector, note: string | undefined, planSessionFor: PlanSessionFor): VerbResult {
  const selected = selectItems(item, "link", "pablo research link <#,#,a-b> <note>");
  if (!selected.ok) return selected.result;
  const numbers = selected.numbers;
  const id = researchNoteId(note ?? "");
  if (id !== "" && !/^[\w.-]+(\/[\w.-]+)*$/.test(id)) return refuse("pablo: research link: a note id is a path under research/ without .md, e.g. ice-harvest or trade/ice-prices");
  if (id === "") return refuse(`pablo: research link: name the research note (its id, the path under research/ without .md): pablo research link ${numbers.join(",")} <note>`);
  const read = readChecklistFor(projectPath, "link", planSessionFor);
  if (!read.ok) return read.result;
  const unknown = unknownItems(read.rows, numbers, "link");
  if (unknown) return unknown;
  const sourced = sourcedNoteIds(projectPath, read.track);
  let pending: PendingNote[] = [];
  if (!sourced.has(id)) {
    const exists = existsSync(join(projectPath, "research", `${id}.md`));
    if (exists) return refuse(`pablo: research link: research/${id}.md has no ## Sources entry, so it cannot source an item`);
    const branches = pendingNoteBranches(planSessionFor, projectPath, id);
    if (branches.length === 0) {
      return refuse(`pablo: research link: research/${id}.md does not exist (keep the finding with \`pablo research save --item ${numbers.join(",")}\`)`);
    }
    pending = branches.map((branch) => ({ note: id, branch }));
    sourced.add(id);
  }
  const rows = read.rows.map((r) => (numbers.includes(r.number) && !r.sources.includes(id) ? { ...r, sources: [...r.sources, id] } : r));
  const planned = planSessionFor(projectPath);
  if (!planned.ok) return planned.result;
  const out = writeRows(planned.session, planned.dir, rows, read.track, sourced, `research: link ${id} to checklist item${numbers.length === 1 ? "" : "s"} ${numbersLabel(numbers)}`);
  if (!out.written.ok) return fail(out.written.notice);
  const linked = out.items.filter((i) => numbers.includes(i.number));
  return {
    body: {
      ok: true,
      path: out.path,
      branch: planned.session.branch,
      ...(out.written.sha ? { sha: out.written.sha } : {}),
      ...(linked.length === 1 ? { item: linked[0] } : {}),
      items: linked,
      open: out.items.filter((i) => i.status === "open").length,
      ...(pending.length > 0 ? { pending } : {}),
    },
    exitCode: 0,
  };
}

/** `research save --item N`: the item numbers, checked against the checklist before anything is written. */
export function checkSaveItems(projectPath: string, items: readonly (string | number)[]): { ok: true; numbers: number[] } | { ok: false; result: VerbResult } {
  if (items.length === 0) return { ok: true, numbers: [] };
  const numbers: number[] = [];
  for (const raw of items) {
    const n = parseItemNumber(raw);
    if (n === undefined) return { ok: false, result: refuse(`pablo: research save: --item names a checklist item by its number, got "${String(raw)}"`) };
    if (!numbers.includes(n)) numbers.push(n);
  }
  const read = readChecklistFor(projectPath, "save");
  if (!read.ok) return read;
  const unknown = unknownItems(read.rows, numbers, "save");
  return unknown ? { ok: false, result: unknown } : { ok: true, numbers };
}

/**
 * After `research save --item N` wrote `notePath` on `session`: the note's id joins each item's Sources in the same
 * branch, so the note and the items it closes are reviewed together. The note is sourced (save requires a source),
 * so it counts as such before it reaches main.
 */
export type LinkSavedNoteResult =
  | { readonly ok: true; readonly id: string; readonly items: readonly ChecklistItem[]; readonly open: number }
  | { readonly ok: false; readonly notice: string };

export function linkSavedNote(projectPath: string, session: PlanSession, dir: string, notePath: string, numbers: readonly number[]): LinkSavedNoteResult {
  const read = readChecklistFor(projectPath, "save");
  if (!read.ok) return { ok: false as const, notice: String((read.result.body as { message?: unknown }).message) };
  const rel = dir && notePath.startsWith(`${dir}/`) ? notePath.slice(dir.length + 1) : notePath;
  const id = researchNoteId(rel);
  const rows = read.rows.map((r) => (numbers.includes(r.number) && !r.sources.includes(id) ? { ...r, sources: [...r.sources, id] } : r));
  const sourced = sourcedNoteIds(projectPath, read.track);
  sourced.add(id);
  const out = writeRows(session, dir, rows, read.track, sourced, `research: ${id} sources checklist item${numbers.length === 1 ? "" : "s"} ${numbers.map((n) => `#${n}`).join(", ")}`);
  if (!out.written.ok) return { ok: false as const, notice: out.written.notice };
  return { ok: true as const, id, items: out.items.filter((i) => numbers.includes(i.number)), open: out.items.filter((i) => i.status === "open").length };
}
