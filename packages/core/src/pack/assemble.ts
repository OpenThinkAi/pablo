/**
 * Assembling the prompt: the deterministic half of every model call.
 *
 * `assemblePack` reads nothing, calls nothing and asks no clock. It takes the
 * text the caller already has, orders it, prices it, cuts it to the budget and
 * hashes the result. Same inputs, same bytes, same hash — which is the whole
 * reason a receipt's `prompt_hash` means anything.
 *
 * The slice order is not decoration. It is the order that produced 1,166 words
 * in 71 seconds from a 4,888-token pack on 2026-09-01, ported from
 * `bin/draft-chapter`: the ask first, then the binding rules, then the facts
 * narrowing from the world to this chapter, then the text to continue from,
 * then the ask again as a directive.
 */

import { createHash } from "node:crypto";
import { selectionText } from "../document";
import { renderPeriodFactLine } from "../period-facts";
import { joinManuscript } from "../sentences";
import {
  CRITICMARKUP_EDIT_CLOSING,
  PROSE_CLOSING,
  PROSE_REVISE_CLOSING,
  REVISE_CLOSING,
  TOOL_EDIT_CLOSING,
} from "./closing";
import type { SliceSpec } from "./budget";
import { fitToBudget, PACK_BUDGETS, renderSlice } from "./budget";
import { estimateTokens } from "./estimate";
import type {
  AssembleOptions,
  BeatRow,
  DraftingInputs,
  EssayBrief,
  EssayClaim,
  Pack,
  PackKind,
  PackVoice,
  ProseInputs,
  ReaderNote,
  ReviseInputs,
  Slice,
  SpanEditInputs,
  TextSource,
} from "./types";

/**
 * The craft rules every drafting pack carries, whatever the vault holds.
 *
 * These are the anti-tell and anti-restating rules from `style/prose.md` and
 * `style/anti-tells.md`, distilled to the ones a model breaks. The slice is
 * required and non-reducible: a budget squeeze can drop the places file, never
 * these.
 */
export const CRAFT_RULES = [
  "- Do not restate the brief. The beat and the fact sheets are scaffolding. Never",
  "  paraphrase them into the prose, and never summarize a character's defining trait;",
  "  show it in what they do and let the reader infer it.",
  "- A scene ends on an image, a line, or an action, never on a paragraph that tells the",
  "  reader what it meant.",
  '- No foreshadowing summaries. No "little did he know", no "it would be years before",',
  '  no "this was the beginning of".',
  '- No rhetorical tricolons, and none of "a testament to", "a reminder that", "in that',
  '  moment".',
  "- Concrete over abstract: name the object, the weather, the tool, the sound. A promise",
  "  of detail is not detail.",
  "- Dialogue is underplayed. Nobody explains the joke or states the theme.",
  '- Straight quotes, never curly. No em-dashes; use a comma, a period, or parentheses.',
  '  Year ranges are written "1920 to 1933".',
  "- Select from the facts you are given. Using all of them reads as machine-written.",
].join("\n");

/** Paragraphs kept on each side of the selection when the caller does not say. */
export const DEFAULT_NEIGHBORHOOD_PARAGRAPHS = 2;

/** Scenes a drafting pack asks for when the caller does not say. */
export const DEFAULT_MIN_SCENES = 3;

/**
 * Output tokens a drafting run is allowed per requested word (`draft-chapter`'s
 * 2.2). `prose` (AGT-1241) reuses the same ratio — there is no separate
 * measurement for freeform copy yet, and a chapter's words-to-tokens shape is
 * the only one this codebase has actually measured.
 */
const OUTPUT_TOKENS_PER_WORD = 2.2;

/** `prose`'s word target when the caller doesn't say — a short piece, not a chapter. */
const DEFAULT_PROSE_WORDS = 300;

/** Floor on the expected answer length for a span edit, so a one-line span still budgets a wait. */
const MIN_EXPECTED_OUTPUT_TOKENS = 256;

export function assemblePack(kind: "spanEdit", inputs: SpanEditInputs, options?: AssembleOptions): Pack;
export function assemblePack(kind: "drafting", inputs: DraftingInputs, options?: AssembleOptions): Pack;
export function assemblePack(kind: "prose", inputs: ProseInputs, options?: AssembleOptions): Pack;
export function assemblePack(kind: "revise", inputs: ReviseInputs, options?: AssembleOptions): Pack;
export function assemblePack(
  kind: PackKind,
  inputs: SpanEditInputs | DraftingInputs | ProseInputs | ReviseInputs,
  options: AssembleOptions = {},
): Pack {
  const estimate = options.estimate ?? estimateTokens;
  const budgetTokens = options.budgetTokens ?? PACK_BUDGETS[kind];
  const built =
    kind === "spanEdit"
      ? spanEditSpecs(inputs as SpanEditInputs)
      : kind === "drafting"
        ? draftingSpecs(inputs as DraftingInputs)
        : kind === "prose"
          ? proseSpecs(inputs as ProseInputs)
          : reviseSpecs(inputs as ReviseInputs);

  const fitted = fitToBudget(built.specs, budgetTokens, estimate);
  const voiceLayers = voiceLayersOf(kind, inputs);
  const periodFacts = kind === "drafting" ? periodFactsSent(inputs as DraftingInputs, fitted.slices) : undefined;
  const prompt = joinSlices(fitted.slices);
  const context = joinSlices(fitted.slices.filter((slice) => !built.tail.has(slice.name)));

  return {
    kind,
    slices: fitted.slices,
    totalTokens: fitted.totalTokens,
    budgetTokens,
    withinBudget: fitted.totalTokens <= budgetTokens,
    adjustments: fitted.adjustments,
    context,
    prompt,
    hash: hashPrompt(prompt),
    expectedOutputTokens: built.expectedOutputTokens,
    ...(voiceLayers === undefined ? {} : { voiceLayers }),
    ...(periodFacts === undefined ? {} : { periodFacts }),
  };
}

/** The layered voice a drafting or prose caller resolved, for the pack's dry run and receipt (AGT-2139). */
function voiceLayersOf(
  kind: PackKind,
  inputs: SpanEditInputs | DraftingInputs | ProseInputs | ReviseInputs,
): PackVoice | undefined {
  if (kind === "drafting") return (inputs as DraftingInputs).voiceLayers;
  if (kind === "prose") return (inputs as ProseInputs).voiceLayers;
  return undefined;
}

/** `sha256`, hex. Exported so a caller can hash a prompt it composed itself. */
export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

interface BuiltSpecs {
  readonly specs: readonly SliceSpec[];
  /**
   * Slices an adapter composes for itself (the passage, the instruction, the
   * closing line). They are in `prompt` and in the hash; they are not in
   * `context`, or `proposeEdit` would send them twice.
   */
  readonly tail: ReadonlySet<string>;
  readonly expectedOutputTokens: number;
}

/**
 * Span edit: the rules, the work's own rules, the manuscript either side of the
 * selection, then the selection and the ask.
 *
 * The headings and the closing line are the ones `createOpenAiAdapter`
 * composes around `EditRequest.context` for the chosen output path, so
 * `pack.prompt` is the text that actually goes over the wire and `pack.hash`
 * identifies it. The two paths share everything but the closing line.
 */
function spanEditSpecs(inputs: SpanEditInputs): BuiltSpecs {
  const passage = selectionText(inputs.document, inputs.span);
  const around = inputs.neighborhoodParagraphs ?? DEFAULT_NEIGHBORHOOD_PARAGRAPHS;
  const before = paragraphsBefore(inputs.document.text, inputs.span.start, around);
  const after = paragraphsAfter(inputs.document.text, inputs.span.end, around);

  const specs: SliceSpec[] = [
    {
      name: "style",
      heading: "# Prose rules (binding)",
      text: concatSources(inputs.style),
      source: sourceLabel(inputs.style),
      required: true,
      keep: "head",
      minTokens: 400,
      reducible: true,
      cutOrder: 1,
    },
    {
      name: "workRules",
      heading: "# Rules for this work (binding)",
      text: inputs.workRules?.text.trim() ?? "",
      source: inputs.workRules?.path,
      required: false,
      keep: "head",
      minTokens: 0,
      reducible: true,
      cutOrder: 2,
    },
    {
      name: "before",
      heading: "# The manuscript just before the selection",
      text: joinManuscript(before),
      source: inputs.document.path,
      required: false,
      keep: "tail",
      minTokens: 0,
      reducible: true,
      cutOrder: 3,
    },
    {
      name: "after",
      heading: "# The manuscript just after the selection",
      text: joinManuscript(after),
      source: inputs.document.path,
      required: false,
      keep: "head",
      minTokens: 0,
      reducible: true,
      cutOrder: 4,
    },
    {
      name: "passage",
      heading: "# The passage",
      text: joinManuscript(passage),
      source: `${inputs.document.path} [${inputs.span.start}, ${inputs.span.end})`,
      required: true,
      keep: "head",
      minTokens: 0,
      reducible: false,
      cutOrder: 0,
    },
    {
      name: "instruction",
      heading: "# What to do to it",
      text: inputs.instruction.trim(),
      source: "the author's intent",
      required: true,
      keep: "head",
      minTokens: 0,
      reducible: false,
      cutOrder: 0,
    },
    {
      name: "closing",
      heading: "",
      text: inputs.output === "text" ? CRITICMARKUP_EDIT_CLOSING : TOOL_EDIT_CLOSING,
      source: undefined,
      required: true,
      keep: "head",
      minTokens: 0,
      reducible: false,
      cutOrder: 0,
    },
  ];

  return {
    specs,
    tail: new Set(["passage", "instruction", "closing"]),
    expectedOutputTokens: Math.max(MIN_EXPECTED_OUTPUT_TOKENS, estimateTokens(passage) * 2),
  };
}

/**
 * Drafting: `bin/draft-chapter`'s pack, in its order — the chapter, the prose
 * rules (the layered voice, AGT-2139: global and vault in `style`, the work's
 * in `workRules`, the output's in `outputRules`, then every voice's `never`),
 * the craft rules, the voices' exemplars, period facts, cast, places, the timeline gated by the
 * chapter's story date, the promoted facts (`facts.md`), the unit's own
 * output's continuity ledger, the tail of the previous
 * chapter, and the task.
 *
 * The timeline gate is the slice that earned its place: draft 1 of chapter 1 put
 * a trapdoor dug three years later into the scene and poured a vintage that did
 * not exist; draft 2, with the gate, did neither.
 */
function draftingSpecs(inputs: DraftingInputs): BuiltSpecs {
  if (inputs.essay !== undefined) return essaySpecs(inputs, inputs.essay);
  const minScenes = inputs.minScenes ?? DEFAULT_MIN_SCENES;
  const { beat } = inputs;
  const beats = [beat, ...(inputs.moreBeats ?? [])];
  const form = inputs.work.description ?? "a novel";

  const label = inputs.unitLabel;
  const script = inputs.scriptUnit === true;
  const noun = script ? "scene" : "chapter";
  const pov = (b: BeatRow): string =>
    script ? "" : `Point of view: ${b.pov} (close third person, one point-of-view character per scene)`;
  const brief = [
    `You are drafting ${label ?? `chapter ${inputs.unit ?? beat.chapter}`} of ${form}, working title "${inputs.work.title}".`,
    label === undefined || script
      ? `This is a first draft the author will cut and reshape. Write the ${noun} and nothing`
      : "This is a first draft the author will cut and reshape. Write the whole piece and nothing",
    "else: no title, no notes, no summary, no questions.",
  ].join("\n");

  const length = `- Length: about ${inputs.wordTarget} words. Stay within ten percent.`;
  // One beat is the usual unit; a plan row may map a unit onto several (AGT-1670), told in order.
  const chapter =
    beats.length === 1
      ? [
          `- Story date: ${beat.storyDate}`,
          `- Working title: ${beat.title}`,
          ...(script ? [] : [`- ${pov(beat)}`]),
          `- Beat: ${beat.beat}`,
          length,
        ].join("\n")
      : [
          `- Working title: ${beat.title}`,
          `- ${label === undefined ? "This chapter" : script ? "This scene" : "This piece"} tells ${beats.length} beats, in order; tell all of them and nothing beyond them:`,
          ...beats.map(
            (b, i) =>
              `  ${i + 1}. Story date: ${b.storyDate}. Title: ${b.title}. ${script ? "" : `${pov(b)}. `}Beat: ${b.beat}`,
          ),
          length,
        ].join("\n");

  const specs: SliceSpec[] = [
    {
      name: "brief",
      heading: "",
      text: brief,
      source: undefined,
      required: true,
      keep: "head",
      minTokens: 0,
      reducible: false,
      cutOrder: 0,
    },
    {
      name: "chapter",
      heading: `# The ${noun}`,
      text: chapter,
      source: beat.source,
      required: true,
      keep: "head",
      minTokens: 0,
      reducible: false,
      cutOrder: 0,
    },
    {
      name: "direction",
      heading: `# Direction for this ${noun} (from the author; follow it)`,
      text: inputs.direction?.trim() ?? "",
      source: inputs.direction?.trim() ? "the author's direction" : undefined,
      required: true,
      keep: "head",
      minTokens: 0,
      reducible: false,
      cutOrder: 0,
    },
    {
      name: "style",
      heading: "# Prose rules (binding)",
      text: concatSources(inputs.style),
      source: sourceLabel(inputs.style),
      required: true,
      keep: "head",
      minTokens: 400,
      reducible: true,
      cutOrder: 1,
    },
    {
      name: "workRules",
      heading: "# Rules for this work (binding; they add to the prose rules above)",
      text: inputs.workRules?.text.trim() ?? "",
      source: inputs.workRules?.path,
      required: false,
      keep: "head",
      minTokens: 0,
      reducible: true,
      cutOrder: 2,
    },
    {
      name: "outputRules",
      heading: "# Rules for this output (binding; they add to the rules above)",
      text: inputs.outputRules?.text.trim() ?? "",
      source: inputs.outputRules?.path,
      required: false,
      keep: "head",
      minTokens: 0,
      reducible: true,
      cutOrder: 2,
    },
    {
      name: "never",
      heading: "# What this voice never does (binding)",
      text: concatSources(inputs.never ?? []),
      source: sourceLabel(inputs.never ?? []),
      required: false,
      keep: "head",
      minTokens: 0,
      reducible: true,
      cutOrder: 2,
    },
    {
      name: "craft",
      heading: "# Craft rules (binding, and the ones models break)",
      text: CRAFT_RULES,
      source: undefined,
      required: true,
      keep: "head",
      minTokens: 0,
      reducible: false,
      cutOrder: 0,
    },
    {
      // The voice's exemplars (AGT-2139): how it sounds, never what happens. The
      // first slice to give under budget pressure, oldest and least specific last
      // in the text so `keep: "head"` drops those first.
      name: "exemplars",
      heading: "# Exemplars of the voice (match how they sound; borrow nothing from what they say)",
      text: concatSources(inputs.exemplars ?? []),
      source: sourceLabel(inputs.exemplars ?? []),
      required: false,
      keep: "head",
      minTokens: 0,
      reducible: true,
      cutOrder: 9,
    },
    {
      // The distilled rows first (AGT-2110), then the work's own STYLE.md section: a head-keeping cut drops the
      // hand-written section before a sourced fact.
      name: "period",
      heading: "# Period and place facts (binding)",
      text: concatSources(periodSources(inputs)),
      source: sourceLabel(periodSources(inputs)),
      required: false,
      keep: "head",
      minTokens: 0,
      reducible: true,
      cutOrder: 4,
    },
    {
      name: "cast",
      heading: "# The cast (use only these people; invent no new named characters)",
      text: inputs.cast?.text.trim() ?? "",
      source: inputs.cast?.path,
      required: false,
      keep: "head",
      minTokens: 0,
      reducible: true,
      cutOrder: 5,
    },
    {
      name: "places",
      heading: "# Places and setting",
      text: inputs.places?.text.trim() ?? "",
      source: inputs.places?.path,
      required: false,
      keep: "head",
      minTokens: 0,
      reducible: true,
      cutOrder: 6,
    },
    {
      name: "timeline",
      heading: `# What exists at this ${noun}'s date`,
      text: renderTimeline(inputs, noun),
      source: inputs.timeline.source,
      required: true,
      keep: "head",
      minTokens: 200,
      reducible: true,
      cutOrder: 3,
    },
    {
      name: "facts",
      heading: "# Story facts every telling honours (binding)",
      text: inputs.facts?.text.trim() ?? "",
      source: inputs.facts?.path,
      required: false,
      keep: "head",
      minTokens: 0,
      reducible: true,
      cutOrder: 4,
    },
    {
      name: "continuity",
      heading: "# Continuity established so far",
      text: inputs.continuity?.text.trim() ?? "",
      source: inputs.continuity?.path,
      required: false,
      keep: "head",
      minTokens: 0,
      reducible: true,
      cutOrder: 7,
    },
    {
      name: "previousTail",
      heading: `# The end of the previous ${noun} (continue from here)`,
      text: joinManuscript(inputs.previousTail?.text ?? ""),
      source: inputs.previousTail?.path,
      required: false,
      keep: "tail",
      minTokens: 0,
      reducible: true,
      cutOrder: 8,
    },
    {
      name: "task",
      heading: "",
      text: [
        ...(script
          ? [`Write the scene now: one scene, not a sequence of them. Scene, not summary. About ${inputs.wordTarget} words, within ten percent.`]
          : [
              `Write the chapter now, in at least ${minScenes} scenes with a line break between`,
              `scenes. Scenes, not summary. About ${inputs.wordTarget} words, within ten percent.`,
            ]),
        "Do not paraphrase the beat or the fact sheets into sentences; show traits through",
        "action and let the reader infer them. End on an image, a line, or an action, never",
        "on what it meant.",
      ].join("\n"),
      source: undefined,
      required: true,
      keep: "head",
      minTokens: 0,
      reducible: false,
      cutOrder: 0,
    },
  ];

  return {
    specs,
    // A drafting pack is sent whole through `complete()`; there is no adapter-composed tail.
    tail: new Set<string>(),
    expectedOutputTokens: Math.ceil(inputs.wordTarget * OUTPUT_TOKENS_PER_WORD),
  };
}

/**
 * The craft rules every essay section carries (AGT-2134), in place of the fiction craft rules: an essay argues, cites
 * and keeps to what its sources say. Required and non-reducible, like `CRAFT_RULES`.
 */
export const ESSAY_CRAFT_RULES = [
  "- Argue the thesis. Every paragraph moves the argument forward; none restates the outline.",
  "- Every factual statement comes from the claims you are given, and carries that claim's citation just before",
  "  the sentence's closing punctuation: [#2] for claim 2, [@note-id] for a source note, [#2; @note-id] for both.",
  "  Never invent a fact, a number, a date, a name or a quotation, and never cite what you were not given.",
  "- Concrete over abstract: the example, the figure, the case. A promise of detail is not detail.",
  '- No rhetorical tricolons, and none of "a testament to", "a reminder that", "in today\'s world", "it is',
  '  important to note".',
  "- Do not summarize what the section just said, and do not announce what the next one will say.",
  '- Straight quotes, never curly. No em-dashes; use a comma, a period, or parentheses.',
  "- Select from the claims. Using all of them in a row reads as machine-written.",
].join("\n");

/**
 * The essay craft rules for an essay about a story (AGT-2135): no claims table, so every fact comes from the story
 * core it is given (the bible, the timeline, the period facts, `facts.md`) and nothing is cited.
 */
export const ESSAY_STORY_CRAFT_RULES = [
  "- Argue the thesis. Every paragraph moves the argument forward; none restates the outline.",
  "- Every statement about the story comes from the story material you are given (the overview, the cast, the",
  "  places, the timeline, the story facts), and every statement about the period from the period facts.",
  "  Never invent a fact, a number, a date, a name, an event or a quotation, and add no citations.",
  "- Concrete over abstract: the scene, the character, the date. A promise of detail is not detail.",
  '- No rhetorical tricolons, and none of "a testament to", "a reminder that", "in today\'s world", "it is',
  '  important to note".',
  "- Do not summarize what the section just said, and do not announce what the next one will say.",
  '- Straight quotes, never curly. No em-dashes; use a comma, a period, or parentheses.',
].join("\n");

/** `1. Title: what it covers` per outline section, the drafted one marked. */
function renderOutline(essay: EssayBrief): string {
  return essay.outline
    .map((s) => `${s.number}. ${s.title}${s.covers === "" ? "" : `: ${s.covers}`}${s.number === essay.section.number ? "  <- this section" : ""}`)
    .join("\n");
}

/** `- [#n] The claim (sources: [@a], [@b])` per claim. */
function renderClaims(claims: readonly EssayClaim[]): string {
  return claims
    .map((c) => `- [#${c.number}] ${c.claim}${c.sources.length === 0 ? "" : ` (sources: ${c.sources.map((id) => `[@${id}]`).join(", ")})`}`)
    .join("\n");
}

/**
 * Drafting one essay section (AGT-2134, D-7): the ask, the section and the outline, the thesis (or the story the
 * essay is about), the section's claims with their citations, the layered voice, the essay craft rules, the voices'
 * exemplars, the period facts and `facts.md` (a fiction track's essay draws on the story core's), the end of the
 * previous section, and the task. A fiction track's essay (AGT-2135) also carries its own thesis beside the story
 * it is about, and the story core's bible: the cast, the places and the whole timeline (never gated: an essay is not
 * told from a point in the story), with the story craft rules in place of the citing ones. Never raw research.
 */
function essaySpecs(inputs: DraftingInputs, essay: EssayBrief): BuiltSpecs {
  const { section } = essay;
  const label = `section ${section.number}, "${section.title}"`;
  const brief = [
    `You are drafting ${label} of ${inputs.work.description ?? "an essay"}, working title "${inputs.work.title}".`,
    "This is a first draft the author will cut and reshape. Write the section's prose and nothing",
    "else: no heading, no title, no notes, no summary, no questions.",
  ].join("\n");
  const sectionText = [
    `- Section ${section.number}: ${section.title}`,
    ...(section.covers === "" ? [] : [`- What it covers: ${section.covers}`]),
    `- Length: about ${inputs.wordTarget} words. Stay within ten percent.`,
    "",
    "The essay's outline:",
    renderOutline(essay),
  ].join("\n");
  const about = essay.thesis ?? essay.subject;
  // An essay about a story (AGT-2135): no claims to cite, the story core is its evidence.
  const story = essay.subject !== undefined && essay.claims.length === 0;

  const spec = (s: Partial<SliceSpec> & Pick<SliceSpec, "name" | "heading" | "text">): SliceSpec => ({
    source: undefined,
    required: false,
    keep: "head",
    minTokens: 0,
    reducible: true,
    cutOrder: 2,
    ...s,
  });

  const specs: SliceSpec[] = [
    spec({ name: "brief", heading: "", text: brief, required: true, reducible: false, cutOrder: 0 }),
    spec({ name: "section", heading: "# The section", text: sectionText, source: essay.outlineSource, required: true, reducible: false, cutOrder: 0 }),
    spec({
      name: "direction",
      heading: "# Direction for this section (from the author; follow it)",
      text: inputs.direction?.trim() ?? "",
      source: inputs.direction?.trim() ? "the author's direction" : undefined,
      required: true,
      reducible: false,
      cutOrder: 0,
    }),
    spec({
      name: "thesis",
      heading: essay.thesis !== undefined ? "# The thesis (the essay argues this)" : "# The story this essay is about",
      text: about?.text.trim() ?? "",
      source: about?.path,
      required: true,
      reducible: false,
      cutOrder: 0,
    }),
    // With a thesis, the story it is about gets its own slice; without one, the `thesis` slice above already sent it.
    spec({
      name: "subject",
      heading: "# The story this essay is about",
      text: essay.thesis !== undefined ? (essay.subject?.text.trim() ?? "") : "",
      source: essay.thesis !== undefined ? essay.subject?.path : undefined,
      required: true,
      reducible: false,
      cutOrder: 0,
    }),
    spec({
      name: "claims",
      heading: "# The claims this section makes (cite each one where you use it)",
      text: renderClaims(essay.claims),
      source: essay.claims.length === 0 ? undefined : essay.claimsSource,
      required: true,
      reducible: false,
      cutOrder: 0,
    }),
    spec({ name: "style", heading: "# Prose rules (binding)", text: concatSources(inputs.style), source: sourceLabel(inputs.style), required: true, minTokens: 400, cutOrder: 1 }),
    spec({ name: "workRules", heading: "# Rules for this work (binding; they add to the prose rules above)", text: inputs.workRules?.text.trim() ?? "", source: inputs.workRules?.path }),
    spec({ name: "outputRules", heading: "# Rules for this output (binding; they add to the rules above)", text: inputs.outputRules?.text.trim() ?? "", source: inputs.outputRules?.path }),
    spec({ name: "never", heading: "# What this voice never does (binding)", text: concatSources(inputs.never ?? []), source: sourceLabel(inputs.never ?? []) }),
    spec({ name: "craft", heading: "# Craft rules (binding, and the ones models break)", text: story ? ESSAY_STORY_CRAFT_RULES : ESSAY_CRAFT_RULES, required: true, reducible: false, cutOrder: 0 }),
    spec({
      name: "exemplars",
      heading: "# Exemplars of the voice (match how they sound; borrow nothing from what they say)",
      text: concatSources(inputs.exemplars ?? []),
      source: sourceLabel(inputs.exemplars ?? []),
      cutOrder: 9,
    }),
    spec({ name: "period", heading: "# Period and place facts (binding)", text: concatSources(periodSources(inputs)), source: sourceLabel(periodSources(inputs)), cutOrder: 4 }),
    spec({ name: "facts", heading: "# Story facts every telling honours (binding)", text: inputs.facts?.text.trim() ?? "", source: inputs.facts?.path, cutOrder: 4 }),
    spec({ name: "cast", heading: "# The story's cast (binding)", text: inputs.cast?.text.trim() ?? "", source: inputs.cast?.path, cutOrder: 5 }),
    spec({ name: "places", heading: "# The story's places (binding)", text: inputs.places?.text.trim() ?? "", source: inputs.places?.path, cutOrder: 6 }),
    spec({ name: "timeline", heading: "# The story's timeline (binding)", text: essay.timeline?.text.trim() ?? "", source: essay.timeline?.path, cutOrder: 5 }),
    spec({
      name: "previousTail",
      heading: "# The end of the previous section (continue from here)",
      text: joinManuscript(inputs.previousTail?.text ?? ""),
      source: inputs.previousTail?.path,
      keep: "tail",
      cutOrder: 8,
    }),
    spec({
      name: "task",
      heading: "",
      text: [
        `Write section ${section.number} now, in paragraphs, about ${inputs.wordTarget} words, within ten percent.`,
        story ? "No citations and no heading: the section's title is added for you." : "Cite every claim you use where you use it. No heading: the section's title is added for you.",
      ].join("\n"),
      required: true,
      reducible: false,
      cutOrder: 0,
    }),
  ];

  return { specs, tail: new Set<string>(), expectedOutputTokens: Math.ceil(inputs.wordTarget * OUTPUT_TOKENS_PER_WORD) };
}

function renderTimeline(inputs: DraftingInputs, noun = "chapter"): string {
  const { exists, later } = inputs.timeline;
  if (exists.length === 0 && later.length === 0) return "";
  const blocks: string[] = [];
  if (exists.length > 0) {
    blocks.push([`## Already true by this ${noun}`, ...exists].join("\n"));
  }
  if (later.length > 0) {
    blocks.push(
      [
        `## Not yet: these do NOT exist at this ${noun}'s date. Do not mention or foreshadow them.`,
        ...later,
      ].join("\n"),
    );
  }
  return blocks.join("\n\n");
}

/**
 * Prose: a named voice plus a brief, no stage machine (AGT-1241). Order is
 * the design doc's own ("Voices" / "The pack" in
 * `pm project show ai-terminal --doc prose`): the voice's
 * rules, its exemplars (newest first — `readVoice` already sorts them that
 * way, and `keep: "head"` here means a budget squeeze drops the *oldest*
 * ones off the tail of the concatenated text, never the newest), what the
 * voice never does, the format stanza, the `--context` files in argument
 * order, the brief, the revise loop's two slices (AGT-1244, below), and the
 * closing directive. The whole pack is sent through `complete()` (like
 * drafting, unlike a span edit's adapter-composed tail), so there is nothing
 * in `tail`.
 */
function proseSpecs(inputs: ProseInputs): BuiltSpecs {
  // AGT-1244's revise loop: the caller (`prose.ts`'s `--draft`/`--instruction`
  // refusal, AC2) guarantees these are given together or not at all, but this
  // module never trusts that from the outside — a lone `instruction` with no
  // `draft` (or vice versa) just renders as one empty, dropped slice rather
  // than a half-built revise prompt, and the closing only switches when BOTH
  // are actually present and the instruction isn't blank.
  const isRevise = inputs.draft !== undefined && (inputs.instruction ?? "").trim() !== "";

  const contextSpecs: SliceSpec[] = inputs.context.map((source, index) => ({
    name: `context-${index}`,
    heading: `# Context: ${sourceLabel([source]) ?? "untitled"}`,
    text: joinManuscript(source.text),
    source: source.path,
    required: false,
    keep: "head",
    minTokens: 0,
    reducible: true,
    cutOrder: 4,
  }));

  const specs: SliceSpec[] = [
    {
      name: "rules",
      heading: "# Voice rules (binding)",
      text: concatSources(inputs.voice.rules),
      source: sourceLabel(inputs.voice.rules),
      required: true,
      keep: "head",
      minTokens: 400,
      reducible: true,
      cutOrder: 1,
    },
    {
      name: "exemplars",
      heading: "# Exemplars (newest first)",
      text: concatSources(inputs.voice.exemplars),
      source: sourceLabel(inputs.voice.exemplars),
      required: false,
      keep: "head",
      minTokens: 0,
      reducible: true,
      cutOrder: 2,
    },
    {
      name: "never",
      heading: "# This voice never does this",
      text: inputs.voice.never?.text.trim() ?? "",
      source: inputs.voice.never?.path,
      required: false,
      keep: "head",
      minTokens: 0,
      reducible: true,
      cutOrder: 3,
    },
    {
      name: "format",
      heading: "# Format",
      text: inputs.format?.trim() ?? "",
      source: undefined,
      required: false,
      keep: "head",
      minTokens: 0,
      reducible: false,
      cutOrder: 0,
    },
    ...contextSpecs,
    {
      name: "brief",
      heading: "# The brief",
      text: inputs.brief.text.trim(),
      source: inputs.brief.path,
      required: true,
      keep: "head",
      minTokens: 0,
      reducible: false,
      cutOrder: 0,
    },
    {
      name: "draft",
      heading: "# The previous text (revise this)",
      text: joinManuscript(inputs.draft?.text ?? ""),
      source: inputs.draft?.path,
      required: false,
      keep: "head",
      minTokens: 0,
      reducible: true,
      // The design doc's budget note (AGT-1244): the draft is the first slice
      // to give ground after the exemplars (cutOrder 2) — a revise call's own
      // prior output is worth truncating before the voice's binding rules
      // ever are, but only once the purely illustrative exemplars are gone.
      // Sits between exemplars (2) and rules' required 400-token floor (1).
      cutOrder: 1.5,
    },
    {
      name: "instruction",
      heading: "# What to change",
      text: inputs.instruction?.trim() ?? "",
      source: "the author's instruction",
      required: false,
      keep: "head",
      minTokens: 0,
      reducible: false,
      cutOrder: 0,
    },
    {
      name: "closing",
      heading: "",
      text: isRevise ? PROSE_REVISE_CLOSING : PROSE_CLOSING,
      source: undefined,
      required: true,
      keep: "head",
      minTokens: 0,
      reducible: false,
      cutOrder: 0,
    },
  ];

  return {
    specs,
    tail: new Set<string>(),
    expectedOutputTokens: Math.ceil((inputs.wordTarget ?? DEFAULT_PROSE_WORDS) * OUTPUT_TOKENS_PER_WORD),
  };
}

/**
 * Revise: rewrite one located passage in place (AGT-1257). The pack carries
 * the passage's own manuscript neighbourhood (`before`/`after`, already cut
 * to whatever window the caller wants — `locatePassage` in `document.ts`
 * finds the span, the caller slices the text either side of it) rather than
 * paragraph counts the way `spanEdit` does, because this kind has no
 * document/span pair of its own to walk.
 *
 * Slice order: `rules` (style + this work's own rules, one combined slice —
 * unlike `spanEdit`, which keeps them separate), `before`, `passage`,
 * `after`, `instruction`, `closing`. Budget pressure falls on `before` first,
 * `after` second, and `rules` last (protected by the same 400-token floor
 * `spanEdit` and `prose` give their rules slice); `passage`, `instruction`
 * and `closing` are never cut — a squeezed revise pack still asks a coherent
 * question about the whole passage.
 */
function reviseSpecs(inputs: ReviseInputs): BuiltSpecs {
  const ruleSources = inputs.workRules === undefined ? inputs.style : [...inputs.style, inputs.workRules];

  const specs: SliceSpec[] = [
    {
      name: "rules",
      heading: "# Prose rules (binding)",
      text: concatSources(ruleSources),
      source: sourceLabel(ruleSources),
      required: true,
      keep: "head",
      minTokens: 400,
      reducible: true,
      cutOrder: 1,
    },
    {
      name: "before",
      heading: "# The manuscript just before the passage",
      text: joinManuscript(inputs.before),
      source: undefined,
      required: false,
      keep: "tail",
      minTokens: 0,
      reducible: true,
      cutOrder: 3,
    },
    {
      name: "passage",
      heading: "# The passage to rewrite",
      text: joinManuscript(inputs.passage),
      source: undefined,
      required: true,
      keep: "head",
      minTokens: 0,
      reducible: false,
      cutOrder: 0,
    },
    {
      name: "after",
      heading: "# The manuscript just after the passage",
      text: joinManuscript(inputs.after),
      source: undefined,
      required: false,
      keep: "head",
      minTokens: 0,
      reducible: true,
      cutOrder: 2,
    },
    // A reader's comment, when the revise answers one (AGT-1642): what they said, on which line, before the author's
    // direction. Never cut: without it the direction can read as arbitrary.
    ...(inputs.readerNote === undefined ? [] : [{
      name: "readerNote",
      heading: "# What a reader said",
      text: readerNoteText(inputs.readerNote),
      source: "a reader's comment",
      required: true,
      keep: "head" as const,
      minTokens: 0,
      reducible: false,
      cutOrder: 0,
    }]),
    {
      name: "instruction",
      heading: inputs.readerNote === undefined ? "# What to change" : "# What the author wants",
      text: inputs.instruction.trim(),
      source: "the author's instruction",
      required: true,
      keep: "head",
      minTokens: 0,
      reducible: false,
      cutOrder: 0,
    },
    {
      name: "closing",
      heading: "",
      text: REVISE_CLOSING,
      source: undefined,
      required: true,
      keep: "head",
      minTokens: 0,
      reducible: false,
      cutOrder: 0,
    },
  ];

  return {
    specs,
    // Sent whole through `complete()`, like `prose` and `drafting`: no adapter-composed tail.
    tail: new Set<string>(),
    expectedOutputTokens: Math.max(MIN_EXPECTED_OUTPUT_TOKENS, estimateTokens(inputs.passage) * 2),
  };
}

/** `Atara, reading the line "…", wrote: "…"`: the note as one plain paragraph, its quotes flattened to one line each. */
function readerNoteText(note: ReaderNote): string {
  const flat = (text: string) => text.replace(/\s+/g, " ").trim();
  const quoted = flat(note.quoted);
  return `${flat(note.reader) || "A reader"}, reading ${quoted === "" ? "this passage" : `the line "${quoted}"`}, wrote: "${flat(note.comment)}"`;
}

function joinSlices(slices: readonly Slice[]): string {
  return slices.map((slice) => renderSlice(slice.heading, slice.text)).join("\n\n");
}

/** The `period` slice's sources: `facts/period.md`'s rows for the unit as the writer sees them, then the `STYLE.md` section. */
function periodSources(inputs: DraftingInputs): TextSource[] {
  const distilled = inputs.distilledFacts;
  return [
    ...(distilled === undefined ? [] : [{ path: distilled.path, text: distilled.facts.map(renderPeriodFactLine).join("\n") }]),
    ...(inputs.periodFacts === undefined ? [] : [inputs.periodFacts]),
  ];
}

/**
 * How many distilled period facts the fitted pack carries (AGT-2110): each row's line counted when it survives whole
 * in the `period` slice. `undefined` when the inputs had no `facts/period.md`.
 */
function periodFactsSent(inputs: DraftingInputs, slices: readonly Slice[]): number | undefined {
  const distilled = inputs.distilledFacts;
  if (distilled === undefined) return undefined;
  const lines = new Set((slices.find((slice) => slice.name === "period")?.text ?? "").split("\n"));
  return distilled.facts.filter((fact) => lines.has(renderPeriodFactLine(fact))).length;
}

function concatSources(sources: readonly TextSource[]): string {
  return sources
    .map((source) => source.text.trim())
    .filter((text) => text !== "")
    .join("\n\n");
}

function sourceLabel(sources: readonly TextSource[]): string | undefined {
  const paths = sources.filter((source) => source.text.trim() !== "").map((source) => source.path);
  return paths.length === 0 ? undefined : paths.join(", ");
}

/** The last `count` paragraphs of `text` before `at`, including the partial one the span begins in. */
function paragraphsBefore(text: string, at: number, count: number): string {
  if (count <= 0) return "";
  const chunks = splitParagraphs(text.slice(0, at));
  return chunks.slice(Math.max(0, chunks.length - count)).join("\n\n");
}

/** The first `count` paragraphs of `text` after `at`, including the rest of the one the span ends in. */
function paragraphsAfter(text: string, at: number, count: number): string {
  if (count <= 0) return "";
  return splitParagraphs(text.slice(at)).slice(0, count).join("\n\n");
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
}
