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
  DraftingInputs,
  Pack,
  PackKind,
  ProseInputs,
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

/**
 * Prose: a named voice plus a brief, no stage machine (AGT-1241). Order is
 * the design doc's own ("Voices" / "The pack" in
 * `~/saltline-digital-vault/projects/ai-terminal/prose.md`): the voice's
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
    text: source.text.trim(),
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
      text: inputs.draft?.text.trim() ?? "",
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
      text: inputs.before.trim(),
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
      text: inputs.passage,
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
      text: inputs.after.trim(),
      source: undefined,
      required: false,
      keep: "head",
      minTokens: 0,
      reducible: true,
      cutOrder: 2,
    },
    {
      name: "instruction",
      heading: "# What to change",
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
