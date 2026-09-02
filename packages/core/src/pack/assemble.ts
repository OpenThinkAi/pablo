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
import { CRITICMARKUP_EDIT_CLOSING, TOOL_EDIT_CLOSING } from "../providers/openai";
import type { SliceSpec } from "./budget";
import { fitToBudget, PACK_BUDGETS, renderSlice } from "./budget";
import { estimateTokens } from "./estimate";
import type {
  AssembleOptions,
  DraftingInputs,
  Pack,
  PackKind,
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

/** Output tokens a drafting run is allowed per requested word (`draft-chapter`'s 2.2). */
const OUTPUT_TOKENS_PER_WORD = 2.2;

/** Floor on the expected answer length for a span edit, so a one-line span still budgets a wait. */
const MIN_EXPECTED_OUTPUT_TOKENS = 256;

export function assemblePack(kind: "spanEdit", inputs: SpanEditInputs, options?: AssembleOptions): Pack;
export function assemblePack(kind: "drafting", inputs: DraftingInputs, options?: AssembleOptions): Pack;
export function assemblePack(
  kind: PackKind,
  inputs: SpanEditInputs | DraftingInputs,
  options: AssembleOptions = {},
): Pack {
  const estimate = options.estimate ?? estimateTokens;
  const budgetTokens = options.budgetTokens ?? PACK_BUDGETS[kind];
  const built =
    kind === "spanEdit"
      ? spanEditSpecs(inputs as SpanEditInputs)
      : draftingSpecs(inputs as DraftingInputs);

  const fitted = fitToBudget(built.specs, budgetTokens, estimate);
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
  };
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
      text: before,
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
      text: after,
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
      text: passage,
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
 * rules, the craft rules, period facts, cast, places, the timeline gated by the
 * chapter's story date, the continuity ledger, the tail of the previous
 * chapter, and the task.
 *
 * The timeline gate is the slice that earned its place: draft 1 of chapter 1 put
 * a trapdoor dug three years later into the scene and poured a vintage that did
 * not exist; draft 2, with the gate, did neither.
 */
function draftingSpecs(inputs: DraftingInputs): BuiltSpecs {
  const minScenes = inputs.minScenes ?? DEFAULT_MIN_SCENES;
  const { beat } = inputs;
  const form = inputs.work.description ?? "a novel";

  const brief = [
    `You are drafting chapter ${beat.chapter} of ${form}, working title "${inputs.work.title}".`,
    "This is a first draft the author will cut and reshape. Write the chapter and nothing",
    "else: no title, no notes, no summary, no questions.",
  ].join("\n");

  const chapter = [
    `- Story date: ${beat.storyDate}`,
    `- Working title: ${beat.title}`,
    `- Point of view: ${beat.pov} (close third person, one point-of-view character per scene)`,
    `- Beat: ${beat.beat}`,
    `- Length: about ${inputs.wordTarget} words. Stay within ten percent.`,
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
      heading: "# The chapter",
      text: chapter,
      source: beat.source,
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
      name: "period",
      heading: "# Period and place facts (binding)",
      text: inputs.periodFacts?.text.trim() ?? "",
      source: inputs.periodFacts?.path,
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
      heading: "# What exists at this chapter's date",
      text: renderTimeline(inputs),
      source: inputs.timeline.source,
      required: true,
      keep: "head",
      minTokens: 200,
      reducible: true,
      cutOrder: 3,
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
      heading: "# The end of the previous chapter (continue from here)",
      text: inputs.previousTail?.text.trim() ?? "",
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
        `Write the chapter now, in at least ${minScenes} scenes with a line break between`,
        `scenes. Scenes, not summary. About ${inputs.wordTarget} words, within ten percent.`,
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

function renderTimeline(inputs: DraftingInputs): string {
  const { exists, later } = inputs.timeline;
  if (exists.length === 0 && later.length === 0) return "";
  const blocks: string[] = [];
  if (exists.length > 0) {
    blocks.push(["## Already true by this chapter", ...exists].join("\n"));
  }
  if (later.length > 0) {
    blocks.push(
      [
        "## Not yet: these do NOT exist at this chapter's date. Do not mention or foreshadow them.",
        ...later,
      ].join("\n"),
    );
  }
  return blocks.join("\n\n");
}

function joinSlices(slices: readonly Slice[]): string {
  return slices.map((slice) => renderSlice(slice.heading, slice.text)).join("\n\n");
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
