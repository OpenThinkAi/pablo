/**
 * Consistency between tellings (AGT-1671; pm project `pablo-story-core`, "Per-output continuity, and consistency
 * between outputs"). Each output keeps its own ledger (`outputs/<type>/continuity.md`, the novel's through the
 * migration shim) and a unit's pack never carries another output's; so two tellings can drift apart, and this is
 * where that is found and settled:
 *
 * - `checkAcross` (`pablo check --across`) reads every declared output's ledger and asks the critic for facts from
 *   different ledgers that cannot both be true. Each candidate goes through the critic's refute step (`applyRefute`,
 *   the same rule as `critique`: a withdrawal must cite a ledger line it was shown) and only survivors are reported,
 *   with both sources and one `promote` action per side that has a unit. The findings are saved under
 *   `<work>/.pablo/across.json` (machine state, gitignored) so a promote can name one by id.
 * - `promoteFinding` (`pablo promote --finding <id> --keep <type>`, the finding's `promote` action) writes the kept
 *   side's fact to `facts.md` with `established-by: <type>/<unit>` through `record_fact --promote`, on a `plan/`
 *   branch, and puts a comment on each contradicting unit's line in that branch's comment store, so review mode shows
 *   it as a note beside the line when the author opens the branch.
 *
 * The model is the critic's (the planner role), injected as an `Ask`; tests pass a fake and no test calls a model.
 * Nothing under `research/` or `notes/` is ever put in a prompt: only the ledgers are.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { continuityFile, parseFactLine } from "@openthink/pablo-core";
import { repoRoot } from "./branch";
import { addComment, type StoredComment } from "./comments";
import { type Ask, applyRefute, DATA_RULE, fence, jsonIn } from "./critique";
import { readMarker } from "./marker";
import { outputDefinition } from "./outputs/registry";
import { type PlanSession, startPlanSession } from "./plan";
import { recordFact } from "./record-fact";

/** One fact of one output's ledger. */
export interface LedgerFact {
  readonly output: string;
  /** The ledger, work-relative. */
  readonly ledger: string;
  /** 1-based line of the fact's bullet in the ledger. */
  readonly line: number;
  /** The fact without its bullet and bracket tags. */
  readonly fact: string;
  /** The unit tag the ledger filed it under (`ch03`, `ep05`), when it has one. */
  readonly tag?: string;
  readonly unit?: number;
}

export interface Ledger {
  readonly output: string;
  readonly path: string;
  readonly facts: readonly LedgerFact[];
}

/** One side of a finding: a ledger fact and, when it has a unit, the `established-by` it would be promoted with. */
export interface AcrossSource extends LedgerFact {
  readonly establishedBy?: string;
}

/** A finding's action: write this side's fact to `facts.md`. */
export interface PromoteAction {
  readonly action: "promote";
  readonly keep: string;
  readonly establishedBy: string;
  readonly fact: string;
  /** The CLI spelling of the action. */
  readonly command: string;
}

export interface AcrossFinding {
  /** Stable for the same two facts: `x` and eight hex digits. */
  readonly id: string;
  readonly claim: string;
  /** What the refute step said when it upheld the finding. */
  readonly reason: string;
  readonly sources: readonly AcrossSource[];
  readonly actions: readonly PromoteAction[];
}

export type AcrossResult =
  | {
      readonly ok: true;
      readonly findings: readonly AcrossFinding[];
      readonly ledgers: readonly { readonly output: string; readonly path: string; readonly facts: number }[];
      readonly raised: number;
      readonly withdrawn: number;
      /** Why nothing was compared (fewer than two ledgers with facts). */
      readonly note?: string;
    }
  | { readonly ok: false; readonly kind: "refused" | "error"; readonly notice: string };

const STOP = new Set(
  "the a an and or but of to in on at by for with from as is was are were be been it its this that these those his her their our your my he she they we you i not no".split(" "),
);

function readOr(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The outputs a work declares, the novel for a work that declares none (as every verb reads it). */
function declaredOutputs(workDir: string): string[] {
  const marker = readMarker(workDir);
  const ids = Object.keys(marker.ok ? marker.marker.outputs : {});
  return ids.length === 0 ? ["novel"] : ids;
}

/**
 * Every declared output's ledger, its fact bullets read with their unit tags. A wrapped bullet (indented continuation
 * lines) is one fact. Bracket groups at the end of a bullet are tags, not the fact: a `[chNN]` (or `[epNN]`, any
 * unit tag, with a note after it such as `§2`) gives the unit.
 */
export function readLedgers(workDir: string): Ledger[] {
  const ledgers: Ledger[] = [];
  for (const id of declaredOutputs(workDir)) {
    if (outputDefinition(id) === undefined) continue;
    const path = continuityFile(workDir, id);
    const lines = readOr(join(workDir, path)).split("\n");
    const facts: LedgerFact[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (parseFactLine(lines[i] as string) === undefined) continue;
      let joined = (lines[i] as string).trimEnd();
      let end = i;
      while (end + 1 < lines.length && /^\s+\S/.test(lines[end + 1] as string) && parseFactLine(lines[end + 1] as string) === undefined) {
        end++;
        joined += ` ${(lines[end] as string).trim()}`;
      }
      const tagMatch = [...joined.matchAll(/\[([a-z]{2})(\d+)\b[^\]]*\]/g)].at(-1);
      const fact = (parseFactLine(joined)?.text ?? "").replace(/(\s*\[[^\]]*\])+\s*$/, "").trim();
      if (fact !== "") {
        facts.push({
          output: id,
          ledger: path,
          line: i + 1,
          fact,
          ...(tagMatch ? { tag: `${tagMatch[1]}${tagMatch[2]}`, unit: Number(tagMatch[2]) } : {}),
        });
      }
      i = end;
    }
    ledgers.push({ output: id, path, facts });
  }
  return ledgers;
}

// ---------------------------------------------------------------- the prompts

const ACROSS_SYSTEM = `You compare the continuity ledgers of different tellings of one story (a novel, a radio show, a blog series, ...). Each ledger lists the facts that telling has established, one per numbered line. Report every pair of facts from DIFFERENT ledgers that cannot both be true of the one story: the same horse a bay in one and grey in the other, a different age, date, name or place for the same thing. A fact one telling has and another never mentions is not a contradiction. Say nothing when nothing contradicts.
Reply with JSON only: [{"claim": "one sentence naming what differs", "lines": ["c3", "c12"]}]. "lines" cites the two contradicting facts by the labels shown, one from each ledger. An empty array means no contradictions.
${DATA_RULE}`;

const ACROSS_REFUTE_SYSTEM = `A critic says two facts from the continuity ledgers of different tellings of one story contradict each other. You get the claim and every ledger, numbered. Decide whether the contradiction holds. Try to knock it down: check whether the two facts are about different things (two horses, two different events), whether another ledger line reconciles them, or whether the critic misread a line.
Reply with JSON only: {"verdict": "uphold" or "withdraw", "reason": "one or two sentences", "lines": ["c4"]}
"lines" cites the ledger lines that settle it, by the labels shown. "withdraw" needs evidence: cite the specific line or lines that reconcile the two facts or show the claim misreads them. A withdrawal that cites no line shown to you is kept as upheld.
${DATA_RULE}`;

/** The ledgers as the critic sees them: one block per output, every fact labelled `c<k>` in one sequence. */
function renderLedgers(ledgers: readonly Ledger[]): { text: string; byLabel: Map<string, LedgerFact> } {
  const byLabel = new Map<string, LedgerFact>();
  let k = 0;
  const blocks = ledgers.map((ledger) => {
    const rows = ledger.facts.map((f) => {
      k += 1;
      byLabel.set(`c${k}`, f);
      return `${`c${k}`.padEnd(7)}${f.fact}${f.tag ? ` [${f.tag}]` : ""}`;
    });
    return `## ${ledger.output} (${ledger.path})\n${rows.join("\n")}`;
  });
  return { text: blocks.join("\n\n"), byLabel };
}

interface Candidate {
  readonly claim: string;
  readonly a: LedgerFact;
  readonly b: LedgerFact;
}

/** The candidates a reply holds: a claim and two cited facts from different outputs; anything else is dropped. */
function parseCandidates(reply: string, byLabel: ReadonlyMap<string, LedgerFact>): Candidate[] {
  let raw: unknown;
  try {
    raw = jsonIn(reply);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const item of raw as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const { claim, lines } = item as Record<string, unknown>;
    const text = typeof claim === "string" ? claim.trim() : "";
    if (text === "" || !Array.isArray(lines)) continue;
    const cited = lines.flatMap((l) => {
      const label = typeof l === "string" ? l.trim().toLowerCase() : typeof l === "number" ? `c${l}` : "";
      const fact = byLabel.get(label);
      return fact ? [fact] : [];
    });
    const a = cited[0];
    const b = cited.find((f) => a !== undefined && f.output !== a.output);
    if (a === undefined || b === undefined) continue;
    const key = findingId(a, b);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ claim: clip(text, 300), a, b });
  }
  return out;
}

/** Stable for the same two facts, whichever order the critic cited them in. */
function findingId(a: LedgerFact, b: LedgerFact): string {
  const sides = [`${a.output}:${a.fact}`, `${b.output}:${b.fact}`].sort();
  return `x${createHash("sha256").update(sides.join("\n")).digest("hex").slice(0, 8)}`;
}

function refutePrompt(c: Candidate, ledgers: string): string {
  return [
    ACROSS_REFUTE_SYSTEM,
    `# Claim\n${fence("claim", `${c.claim}\n${c.a.output}: ${c.a.fact}\n${c.b.output}: ${c.b.fact}`)}`,
    `# Ledgers\n${fence("ledgers", ledgers)}`,
  ].join("\n\n");
}

function sourceOf(fact: LedgerFact): AcrossSource {
  return { ...fact, ...(fact.tag !== undefined ? { establishedBy: `${fact.output}/${fact.tag}` } : {}) };
}

function actionsOf(id: string, slug: string, sources: readonly AcrossSource[]): PromoteAction[] {
  return sources.flatMap((s) =>
    s.establishedBy === undefined
      ? []
      : [{ action: "promote" as const, keep: s.output, establishedBy: s.establishedBy, fact: s.fact, command: `pablo promote --project ${slug} --finding ${id} --keep ${s.output}` }],
  );
}

// ---------------------------------------------------------------- check --across

export interface AcrossOptions {
  readonly projectPath: string;
  readonly ask: Ask;
  /** Told what the run is doing, one line at a time (the verb passes stderr). */
  readonly progress?: (line: string) => void;
}

/** `pablo check --across`: contradictions between the work's ledgers, each upheld by the refute step, saved for `promote`. */
export async function checkAcross(opts: AcrossOptions): Promise<AcrossResult> {
  const marker = readMarker(opts.projectPath);
  if (!marker.ok) return { ok: false, kind: "refused", notice: marker.message };
  const ledgers = readLedgers(opts.projectPath);
  const summary = ledgers.map((l) => ({ output: l.output, path: l.path, facts: l.facts.length }));
  const withFacts = ledgers.filter((l) => l.facts.length > 0);
  const say = opts.progress ?? (() => {});
  if (withFacts.length < 2) {
    const note = `nothing to compare: ${withFacts.length === 0 ? "no output has" : `only ${withFacts[0]?.output} has`} a ledger with facts`;
    saveFindings(opts.projectPath, []);
    return { ok: true, findings: [], ledgers: summary, raised: 0, withdrawn: 0, note };
  }

  const { text, byLabel } = renderLedgers(withFacts);
  const shown = new Set(byLabel.keys());
  say(`pablo: check --across: comparing ${withFacts.map((l) => `${l.output} (${l.facts.length})`).join(", ")}`);
  const findings: AcrossFinding[] = [];
  let withdrawn = 0;
  let raised = 0;
  try {
    const candidates = parseCandidates(await opts.ask([ACROSS_SYSTEM, `# Ledgers\n${fence("ledgers", text)}`].join("\n\n")), byLabel);
    raised = candidates.length;
    if (raised > 0) say(`pablo: check --across: ${raised} contradiction${raised === 1 ? "" : "s"} raised, re-checking`);
    for (const c of candidates) {
      const verdict = applyRefute(await opts.ask(refutePrompt(c, text)), shown);
      if (!verdict.kept) {
        withdrawn++;
        continue;
      }
      const id = findingId(c.a, c.b);
      const sources = [sourceOf(c.a), sourceOf(c.b)];
      findings.push({ id, claim: c.claim, reason: verdict.reason, sources, actions: actionsOf(id, marker.marker.slug, sources) });
    }
  } catch (error) {
    return { ok: false, kind: "error", notice: `pablo: check --across failed: ${(error as Error).message}` };
  }
  try {
    saveFindings(opts.projectPath, findings);
  } catch (error) {
    return { ok: false, kind: "error", notice: `pablo: check --across: could not save the findings: ${(error as Error).message}` };
  }
  say(`pablo: check --across: ${findings.length} kept, ${withdrawn} withdrawn`);
  return { ok: true, findings, ledgers: summary, raised, withdrawn };
}

/** `<work>/.pablo/across.json`: the last `check --across` run's findings, what `promote` reads. */
export function acrossPath(projectPath: string): string {
  return join(projectPath, ".pablo", "across.json");
}

function saveFindings(projectPath: string, findings: readonly AcrossFinding[]): void {
  const path = acrossPath(projectPath);
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ findings }, null, 2)}\n`);
  renameSync(tmp, path);
}

/** The saved findings; none when there is no run or the file is unreadable. */
export function loadFindings(projectPath: string): AcrossFinding[] {
  try {
    const saved = JSON.parse(readFileSync(acrossPath(projectPath), "utf8")) as { findings?: unknown };
    if (!Array.isArray(saved.findings)) return [];
    return (saved.findings as AcrossFinding[]).filter((f) => typeof f?.id === "string" && Array.isArray(f.sources));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- promote

export interface PromoteOptions {
  readonly projectPath: string;
  /** A finding id from the last `check --across`. */
  readonly finding: string;
  /** The output whose side is kept: its fact goes to `facts.md`. */
  readonly keep: string;
  /** The plan session to write on; default a fresh `plan/<date>-<id>` branch. Tests inject one. */
  readonly session?: PlanSession;
  readonly env?: Record<string, string | undefined>;
}

export type PromoteResult =
  | {
      readonly ok: true;
      readonly finding: string;
      readonly branch: string;
      /** `facts.md`, vault-relative. */
      readonly path: string;
      /** The line written. */
      readonly line: string;
      readonly sha?: string;
      /** The comments put on contradicting units' lines, as stored on `branch`. */
      readonly comments: readonly StoredComment[];
      readonly notices: readonly string[];
    }
  | { readonly ok: false; readonly code: 1 | 2; readonly notice: string };

const refusePromote = (notice: string): PromoteResult => ({ ok: false, code: 2, notice: `pablo: promote: ${notice}` });

/** The work-relative file of unit `unit` of output `output`, or undefined when it is not drafted. */
export function unitFile(workDir: string, output: string, unit: number): string | undefined {
  const def = outputDefinition(output);
  if (def === undefined) return undefined;
  const dir = join(workDir, def.artifactDir);
  if (!existsSync(dir)) return undefined;
  const name = readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .sort()
    .find((n) => def.unitOfPath(`${def.artifactDir}/${n}`) === unit);
  return name === undefined ? undefined : `${def.artifactDir}/${name}`;
}

const contentWords = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z][a-z'-]+/g) ?? []).map((w) => w.replace(/'s$/, "")).filter((w) => w.length > 2 && !STOP.has(w));

/**
 * The 1-based line of `text` that most likely establishes `fact`: the prose line (frontmatter skipped) sharing the
 * most content words with it, the first on a tie; undefined when no line shares one.
 */
export function lineFor(text: string, fact: string): number | undefined {
  const lines = text.split("\n");
  const front = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  const start = front === null ? 0 : front[0].replace(/\r?\n$/, "").split("\n").length;
  const words = new Set(contentWords(fact));
  let best: number | undefined;
  let bestScore = 0;
  for (let i = start; i < lines.length; i++) {
    const score = new Set(contentWords(lines[i] as string).filter((w) => words.has(w))).size;
    if (score > bestScore) {
      bestScore = score;
      best = i + 1;
    }
  }
  return best;
}

/**
 * The finding's `promote` action: `keep`'s fact to `facts.md` (`record_fact --promote`, kind `author`: the author
 * decided it by promoting), and a comment on every other side's unit line on the same `plan/` branch.
 */
export function promoteFinding(opts: PromoteOptions): PromoteResult {
  const finding = loadFindings(opts.projectPath).find((f) => f.id === opts.finding);
  if (finding === undefined) return refusePromote(`no finding "${opts.finding}" in the last check --across (run pablo check --across first)`);
  const kept = finding.sources.find((s) => s.output === opts.keep);
  if (kept === undefined) return refusePromote(`finding ${finding.id} has no ${opts.keep} side (it has: ${finding.sources.map((s) => s.output).join(", ")})`);
  if (kept.establishedBy === undefined) return refusePromote(`the ${opts.keep} side of ${finding.id} names no unit, so there is no established-by to promote it with`);
  const repo = repoRoot(opts.projectPath);
  if (repo === undefined) return refusePromote(`${opts.projectPath} is not inside a git repository`);
  const marker = readMarker(opts.projectPath);
  if (!marker.ok) return refusePromote(marker.message.replace(/^pablo: /, ""));

  const session = opts.session ?? startPlanSession(repo, marker.marker.slug, { env: opts.env ?? process.env });
  const written = recordFact(session, opts.projectPath, { fact: kept.fact, where: "", kind: "author", promote: true, establishedBy: kept.establishedBy });
  if (!written.ok) return { ok: false, code: written.notice.includes("already holds") ? 2 : 1, notice: written.notice };

  const comments: StoredComment[] = [];
  const notices: string[] = [];
  for (const other of finding.sources) {
    if (other.output === kept.output) continue;
    const rel = other.unit === undefined ? undefined : unitFile(opts.projectPath, other.output, other.unit);
    if (rel === undefined) {
      notices.push(`pablo: promote: no ${other.output} unit file for "${other.fact}" (${other.ledger}:${other.line}); nothing to comment on`);
      continue;
    }
    const abs = join(opts.projectPath, rel);
    const line = lineFor(readOr(abs), other.fact);
    const noun = outputDefinition(other.output)?.noun ?? "unit";
    const comment: StoredComment = {
      source: "critic",
      tag: "fix",
      path: relative(repo, abs).split("\\").join("/"),
      ...(line !== undefined ? { line } : {}),
      author: "pablo",
      body: `Contradicts facts.md: "${kept.fact}" (established-by: ${kept.establishedBy}). This ${noun} established "${other.fact}" (${other.ledger}:${other.line}). Revise the line, or promote this telling's version instead.`,
    };
    const stored = addComment(opts.projectPath, session.branch, comment);
    if (stored) comments.push(stored);
  }
  return {
    ok: true,
    finding: finding.id,
    branch: written.branch,
    path: written.path,
    line: written.line,
    ...(written.sha !== undefined ? { sha: written.sha } : {}),
    comments,
    notices,
  };
}
