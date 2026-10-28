/**
 * The essay output's plan, preconditions and pack (AGT-2134, D-7).
 *
 * A section's pack is an essay pack (core's `essaySpecs`, chosen by the
 * inputs' `essay` brief): the section and the outline around it, the thesis
 * (nonfiction) or the story the essay is about (a fiction track's
 * `bible/overview.md`), the section's claims with the research note ids they
 * cite, so the writer puts citations (`[#2]`, `[@note-id]`) in the text, the
 * layered voice and the essay's own `RULES.md` (`packFromInputs`), and the end
 * of the previous section. On a fiction track it also carries the story
 * core's distilled period facts and `facts.md`, read as the story pack reads
 * them, and (AGT-2135) the essay's own thesis (`outputs/essay/thesis.md`) and
 * the bible: the cast (every character file, AGT-2183), the places and the whole timeline, and a section about one
 * act carries that act's beat rows (`actBeatsFor`). Research notes
 * themselves are never in it (D-10): a claim's sources go to the writer as
 * ids only, and a fiction essay's facts come distilled.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { beatsFile, outputRulesFile, parseHeadedBeatRows, readDraftingInputs, readTextSource, readWorkRules, DEFAULT_MIN_SCENES } from "@openthink/pablo-core";
import type { BeatRow, DraftingInputs, EssayBrief, EssaySection, TextSource } from "@openthink/pablo-core";
import { readCoreState } from "../../core/machine";
import { CLAIMS_FILE, hasProse, THESIS_FILE } from "../../core/nonfiction";
import { trackOf } from "../../marker";
import { CAST_ENDS_AT, packFromInputs } from "../../novel/pack";
import { frontmatterField } from "../novel/plan";
import type { TrackId } from "../../tracks/registry";
import type { PlanRow, UnitPackOptions, UnitPackOutcome, UnitPreconditions } from "../types";
import { actLabel, actTitle } from "./scaffold";
import { ESSAY_OUTLINE_FILE, ESSAY_PATH, ESSAY_THESIS_FILE, essayOutline, essayTrack, readEssayFile, sectionBody, sectionClaims } from "./sections";
import { ESSAY_ID } from "./units";

/** Words asked for one section when the request names no length. */
export const SECTION_WORDS = 600;

/** Words asked for the whole essay on a fiction track with no outline of its own (one section). */
export const FICTION_ESSAY_WORDS = 1500;

/** How much of the previous section the next one continues from. */
const PREVIOUS_SECTION_WORDS = 250;

/** `OUTPUTS.essay.plan`: one row per section; on nonfiction a section tells its outline row, on a fiction track every beat. */
export function essayDefaultPlan(workDir: string): PlanRow[] {
  const track = essayTrack(workDir);
  const { sections } = essayOutline(workDir, track);
  const content = readEssayFile(workDir);
  const status = content === undefined ? "draft" : (frontmatterField(content, "status") ?? "draft");
  const beats = track === "nonfiction" ? undefined : readCoreState(workDir, track).beats.map((b) => b.chapter);
  return sections.map((s) => ({
    unit: s.number,
    title: s.title,
    beats: beats ?? [s.number],
    status: content !== undefined && sectionBody(sections, content, s.number) !== undefined ? status : "beat",
  }));
}

/**
 * `OUTPUTS.essay.preconditions`: the section is in the outline, the section before it is in `essay.md` (merged), and
 * (nonfiction) the thesis is written and every claim it names exists.
 */
export function essayPreconditions(workDir: string, unit: number): UnitPreconditions {
  const track = essayTrack(workDir);
  const { sections, source } = essayOutline(workDir, track);
  const section = sections.find((s) => s.number === unit);
  if (section === undefined) {
    return { ready: false, missing: [sections.length === 0 ? `no sections in ${source}` : `no section ${unit} in ${source} (it has ${sections.map((s) => s.number).join(", ")})`] };
  }
  const missing: string[] = [];
  // Sections are written in order, each accepted before the next: every draft branch rewrites the one file's
  // frontmatter, so two unmerged sections would always conflict.
  const previous = sections.filter((s) => s.number < unit).at(-1);
  if (previous !== undefined) {
    const content = readEssayFile(workDir);
    if (content === undefined || sectionBody(sections, content, previous.number) === undefined) {
      missing.push(`section ${previous.number} is not written and accepted yet (pablo write --output essay --unit ${previous.number}, then merge its branch)`);
    }
  }
  if (track === "nonfiction") {
    if (!hasProse(read(join(workDir, THESIS_FILE)) ?? "")) missing.push(`${THESIS_FILE} has no thesis`);
    for (const n of sectionClaims(workDir, section).absent) missing.push(`section ${unit} names claim #${n}, which ${CLAIMS_FILE} does not have`);
  } else {
    const core = readCoreState(workDir, track);
    // An essay with its own outline (AGT-2135) argues a thesis about the story.
    if (source === ESSAY_OUTLINE_FILE && !hasProse(read(join(workDir, ESSAY_THESIS_FILE)) ?? "")) {
      missing.push(`${ESSAY_THESIS_FILE} has no thesis (write the one thing the essay argues about the story there)`);
    }
    if (!core.premise) missing.push("bible/overview.md has no logline (the essay is about the story)");
    if (core.beats.length === 0) missing.push(`no beats in ${core.outlineFile} (the essay is about the story they tell)`);
  }
  return { ready: missing.length === 0, missing };
}

function read(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** The tail of the previous section, to continue from: its last words, by whole lines. */
function previousSection(vaultRoot: string, workDir: string, sections: readonly EssaySection[], unit: number): TextSource | undefined {
  const content = readEssayFile(workDir);
  if (content === undefined) return undefined;
  const before = sections.filter((s) => s.number < unit).at(-1);
  if (before === undefined) return undefined;
  const body = sectionBody(sections, content, before.number);
  if (body === undefined) return undefined;
  const lines = body.split("\n");
  const kept: string[] = [];
  let words = 0;
  for (let i = lines.length - 1; i >= 0 && words < PREVIOUS_SECTION_WORDS; i--) {
    kept.unshift(lines[i] as string);
    words += (lines[i] as string).split(/\s+/).filter((w) => w !== "").length;
  }
  return { path: relative(vaultRoot, join(workDir, ESSAY_PATH)).split(sep).join("/"), text: kept.join("\n").trim() };
}

/** The section as the pack's (unused by the essay specs, but required) beat row. */
function sectionBeat(section: EssaySection, source: string): BeatRow {
  return { chapter: section.number, storyDate: "", title: section.title, beat: section.covers, pov: "", status: "", source };
}

/** Case and spacing folded, for matching a section or heading to an act. */
function fold(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The beat rows a fiction essay's act section tells (AGT-2183): the section whose title is an act's (by its own
 * title, as the scaffold writes it) gets the beats under that act's `## Act I` heading in the beats file, when the file
 * splits its beats across two or more act headings; otherwise the beats split over the acts in order, as evenly as
 * they go (a beats file that lists every beat under one heading says nothing finer). `undefined` for a section that
 * is not an act's. `source` labels the rows (the vault-relative beats file).
 */
export function actBeatsFor(workDir: string, track: TrackId, section: EssaySection, source: string): readonly BeatRow[] | undefined {
  const { acts } = readCoreState(workDir, track);
  // An outline scaffolded before act titles (or edited back) names the section `Act I`: the label still finds the act.
  const index = acts.findIndex((a) => fold(actTitle(a)) === fold(section.title) || fold(actLabel(a)) === fold(section.title));
  if (index === -1) return undefined;
  const beats = parseHeadedBeatRows(read(join(workDir, beatsFile(workDir))) ?? "", source);
  // The beats file's headings name an act by its plain label (`## Act I`); the section is titled by the act's own title.
  const actOf = (heading: string): number => acts.findIndex((a) => fold(actLabel(a)) === fold(heading) || fold(actTitle(a)) === fold(heading));
  const headed = new Set(beats.map((b) => actOf(b.heading)).filter((i) => i !== -1));
  if (headed.size >= 2) return beats.filter((b) => actOf(b.heading) === index).map((b) => b.row);
  const from = Math.floor((index * beats.length) / acts.length);
  const to = Math.floor(((index + 1) * beats.length) / acts.length);
  return beats.slice(from, to).map((b) => b.row);
}

/** `OUTPUTS.essay.pack`: the section's writer pack, or a refusal (a `neverSend` violation, an unknown section). */
export function buildEssayPack(vaultRoot: string, workDir: string, unit: number, options: UnitPackOptions): UnitPackOutcome {
  const track = trackOf(options.marker);
  const { sections, source } = essayOutline(workDir, track);
  const section = sections.find((s) => s.number === unit);
  if (section === undefined) return { ok: false, code: 2, message: `pablo: the essay has no section ${unit} (${source})` };
  const vaultRel = (rel: string): string => relative(vaultRoot, join(workDir, rel)).split(sep).join("/");
  const previousTail = previousSection(vaultRoot, workDir, sections, unit);
  const outputRulesPath = join(workDir, outputRulesFile(ESSAY_ID));

  let inputs: DraftingInputs;
  let essay: EssayBrief;
  if (track === "nonfiction") {
    const { claims } = sectionClaims(workDir, section);
    const thesis = readTextSource(vaultRoot, join(workDir, THESIS_FILE));
    const workRules = readWorkRules(vaultRoot, workDir);
    essay = { section, outline: sections, outlineSource: vaultRel(source), thesis, claims, claimsSource: vaultRel(CLAIMS_FILE) };
    inputs = {
      work: { title: options.marker.title, description: "an essay" },
      beat: sectionBeat(section, vaultRel(source)),
      unit,
      style: [],
      ...(workRules === undefined ? {} : { workRules }),
      timeline: { exists: [], later: [], source: "" },
      wordTarget: options.words ?? SECTION_WORDS,
    };
  } else {
    // A fiction track's essay is about the story: the core read as the story pack reads it, over every beat.
    const beats = readCoreState(workDir, track).beats.map((b) => b.chapter);
    const story = readDraftingInputs({
      vaultRoot,
      workRoot: workDir,
      chapter: beats[0] ?? 1,
      ...(beats.length === 0 ? {} : { beats }),
      outputRulesPath,
      wordTarget: options.words ?? (source === ESSAY_OUTLINE_FILE ? SECTION_WORDS : FICTION_ESSAY_WORDS),
      minScenes: DEFAULT_MIN_SCENES,
      castEndsAt: CAST_ENDS_AT,
      work: { description: "an essay about the story" },
      output: ESSAY_ID,
    });
    // AGT-2135: the essay's own thesis, and the story core's bible and whole timeline (never research, D-10).
    const subject = readTextSource(vaultRoot, join(workDir, "bible", "overview.md"));
    const thesisPath = join(workDir, ESSAY_THESIS_FILE);
    const thesis = hasProse(read(thesisPath) ?? "") ? readTextSource(vaultRoot, thesisPath) : undefined;
    const timeline = readTextSource(vaultRoot, join(workDir, "bible", "timeline.md"));
    // AGT-2183: a section about one act carries that act's beat rows.
    const actBeats = actBeatsFor(workDir, track, section, story.beat.source);
    essay = {
      section,
      outline: sections,
      outlineSource: vaultRel(source),
      ...(thesis === undefined ? {} : { thesis }),
      subject,
      ...(timeline === undefined ? {} : { timeline }),
      ...(actBeats === undefined ? {} : { actBeats, actBeatsSource: story.beat.source }),
      claims: [],
    };
    inputs = { ...story, beat: sectionBeat(section, story.beat.source), moreBeats: [], unit, previousTail: undefined };
  }
  return packFromInputs(vaultRoot, workDir, { ...inputs, essay, ...(previousTail === undefined ? {} : { previousTail }) }, { ...options, output: ESSAY_ID });
}
