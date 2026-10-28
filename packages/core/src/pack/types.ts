/**
 * The vocabulary of the context pack: what pablo decided to send, how big each
 * part of it is, and what it had to give up to stay inside the budget.
 *
 * A pack is a *value*. Assembling one reads no files, calls no model and asks
 * no clock: the same inputs produce the same bytes and the same hash, which is
 * what makes the hash in a receipt worth recording.
 */

import type { Document, Span } from "../document";
import type { OutputMode } from "../providers/types";
import type { PeriodFact } from "../period-facts";
import type { TokenEstimator } from "./estimate";

/** The shapes of prompt pablo assembles today. */
export type PackKind = "spanEdit" | "drafting" | "prose" | "revise";

/** One named, sourced section of the prompt. */
export interface Slice {
  /** Stable identifier (`style`, `timeline`); the table and the receipt key on it. */
  readonly name: string;
  /** The markdown heading this slice is introduced by; `""` for a bare paragraph. */
  readonly heading: string;
  /** The body as it appears in the prompt, after any truncation. */
  readonly text: string;
  /** Estimated tokens of the slice *as rendered* (heading included). */
  readonly tokens: number;
  /** Where the text came from: a file path, or a short phrase for caller-supplied text. */
  readonly source: string | undefined;
}

export type SliceAction = "truncated" | "dropped";

/** What the budget took, from which slice, and how much. Never silent. */
export interface SliceAdjustment {
  readonly name: string;
  readonly action: SliceAction;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly droppedTokens: number;
  readonly source: string | undefined;
}

export interface Pack {
  readonly kind: PackKind;
  /** In prompt order. */
  readonly slices: readonly Slice[];
  readonly totalTokens: number;
  readonly budgetTokens: number;
  readonly withinBudget: boolean;
  /** Empty when nothing had to give. Ordered by the order the cuts were taken. */
  readonly adjustments: readonly SliceAdjustment[];
  /**
   * The slices an adapter takes as `EditRequest.context` / `ExtractRequest.context`:
   * everything except the passage, the instruction and the closing directive, which
   * the adapter composes itself. Equal to `prompt` for kinds with no such tail.
   */
  readonly context: string;
  /** The exact bytes pablo sends when it drives the endpoint through `complete()`. */
  readonly prompt: string;
  /** `sha256(prompt)`, hex. Stable across runs; the receipt's `prompt_hash`. */
  readonly hash: string;
  /** What the answer is expected to cost, for the wait estimate and `maxTokens`. */
  readonly expectedOutputTokens: number;
  /**
   * The voice layers the pack was built from (AGT-2139, D-15), when the caller
   * resolved them: carried to the dry run and the receipt. Not part of the
   * prompt, so not part of the hash.
   */
  readonly voiceLayers?: PackVoice | undefined;
  /**
   * How many of `facts/period.md`'s rows the prompt carries (AGT-2110): the rows the unit's date let in, less any
   * the budget cut. Present on a drafting pack whose work has the file; the receipt's `period_facts`.
   */
  readonly periodFacts?: number | undefined;
}

/** One piece of the layered voice a pack carries, as a receipt shows it. */
export interface PackVoiceLayer {
  /** `global`, `vault`, `work` or `output`. */
  readonly layer: string;
  /** The voice's name (`default`, `plain`, `style`, the rules file, `RULES.md (radio)`). */
  readonly name: string;
  /** Where it was read from: vault-relative inside the vault, absolute outside it. */
  readonly source: string;
  /** What put it in the pack: the `pablo.json` entry (`voice[2]: plain`), or `global default`. */
  readonly via?: string | undefined;
}

/** A voice the work's `pablo.json` names that was not found (or was empty): shown, never silently skipped. */
export interface PackVoiceMissing {
  readonly layer?: string | undefined;
  readonly name: string;
  /** The `pablo.json` entry that named it. */
  readonly via: string;
  readonly reason: string;
}

/** The layered voice behind a pack, lowest precedence first. */
export interface PackVoice {
  readonly layers: readonly PackVoiceLayer[];
  readonly missing: readonly PackVoiceMissing[];
}

/** The rows of `facts/period.md` a drafting pack carries (AGT-2110). */
export interface DistilledFacts {
  /** The file's path as the table and the receipt show it (vault-relative). */
  readonly path: string;
  readonly facts: readonly PeriodFact[];
}

/** A style or rules file read out of the vault, kept with its path for the table. */
export interface TextSource {
  /** Path as it should appear in the dry-run table and the receipt. */
  readonly path: string;
  readonly text: string;
}

export interface SpanEditInputs {
  readonly document: Document;
  readonly span: Span;
  /** What to do to the span, in the author's terms ("cut this by a third"). */
  readonly instruction: string;
  /** `<vault>/style/*.md`, in the order they should appear. */
  readonly style: readonly TextSource[];
  /** The work's own rules file (`STYLE.md`) when it has one. */
  readonly workRules?: TextSource | undefined;
  /**
   * Which structured path the adapter will take, so the closing line priced
   * here is the one that goes over the wire. Defaults to the tool call, the
   * OpenAI-compatible adapter's measured preference (AGT-1202).
   */
  readonly output?: OutputMode | undefined;
  /** Paragraphs of the manuscript to keep on each side of the span. Default 2. */
  readonly neighborhoodParagraphs?: number | undefined;
}

/** One row of `outline/chapters.md`: `# | story date | title | beat | POV | status`. */
export interface BeatRow {
  readonly chapter: number;
  readonly storyDate: string;
  readonly title: string;
  readonly beat: string;
  readonly pov: string;
  readonly status: string;
  /** Path of the outline the row came from. */
  readonly source: string;
}

/** `bible/timeline.md` split by the chapter's story date. */
export interface TimelineGate {
  /** Rows dated at or before the chapter, rendered one per line. */
  readonly exists: readonly string[];
  /** Rows dated after it: the "do not mention or foreshadow" list. */
  readonly later: readonly string[];
  readonly source: string;
}

/** The work being drafted, for the opening line of the prompt. */
export interface WorkIdentity {
  readonly title: string;
  /** How to describe the form ("a literary historical novel set in Napa Valley"). */
  readonly description?: string | undefined;
}

/** One section of an essay's outline (AGT-2134): its number, its title and what it covers. */
export interface EssaySection {
  readonly number: number;
  readonly title: string;
  readonly covers: string;
}

/** A claim an essay section makes (AGT-2134): the claims row, and the research note ids it cites (never the notes). */
export interface EssayClaim {
  readonly number: number;
  readonly claim: string;
  readonly sources: readonly string[];
}

/**
 * The brief of one essay section (AGT-2134, D-7): a drafting pack with `essay` set is an essay's, not a chapter's.
 * The section, the whole outline for its place, the thesis (nonfiction) or the story the essay is about (a fiction
 * track), and the section's claims with the citations the writer puts in the text (`[#n]`, `[@note-id]`).
 */
export interface EssayBrief {
  readonly section: EssaySection;
  /** Every section of the outline, in order, so the writer knows where this one sits. */
  readonly outline: readonly EssaySection[];
  /** Where the outline came from (work-relative), for the slice's source. */
  readonly outlineSource: string;
  /** The thesis (`core/thesis.md`) on nonfiction. */
  readonly thesis?: TextSource | undefined;
  /**
   * On a fiction track: the story the essay is about (`bible/overview.md`). With a `thesis` too (a fiction essay's
   * own, `outputs/essay/thesis.md`, AGT-2135) both are sent, the thesis first.
   */
  readonly subject?: TextSource | undefined;
  /**
   * On a fiction track (AGT-2135): the story's whole timeline (`bible/timeline.md`), ungated: an essay speaks of the
   * story from outside it, so nothing in it is "not yet". The cast and places come from the inputs' own slices.
   */
  readonly timeline?: TextSource | undefined;
  /**
   * On a fiction track (AGT-2183): the beat rows a section about one act tells — what happens in that act — so the
   * writer works from the story's own events instead of inventing them. Absent for a section that is not an act's.
   */
  readonly actBeats?: readonly BeatRow[] | undefined;
  /** The section's claims, each with the note ids it cites. Empty for a section that makes none. */
  readonly claims: readonly EssayClaim[];
  /** Where the claims came from (`core/claims.md`), for the slice's source. */
  readonly claimsSource?: string | undefined;
}

export interface DraftingInputs {
  readonly work: WorkIdentity;
  /** The unit's first (primary) beat. */
  readonly beat: BeatRow;
  /**
   * The rest of the beats the unit tells, in order (AGT-1670: a plan row may
   * map one unit onto several beats). Empty or absent for the usual one beat.
   */
  readonly moreBeats?: readonly BeatRow[] | undefined;
  /** The unit's number when it differs from its beat's (a plan that maps unit 1 to beats 4-5); defaults to the beat's. */
  readonly unit?: number | undefined;
  /**
   * What the unit is called in the brief, replacing "chapter N" (`the whole
   * piece` for the story output, AGT-1689). Absent means a chapter, worded as
   * every novel pack has always been.
   */
  readonly unitLabel?: string | undefined;
  /**
   * The unit is one scene of a script (AGT-2189): the brief drops the chapter wording and the
   * prose point-of-view line, and asks for one scene instead of a scene count.
   */
  readonly scriptUnit?: boolean | undefined;
  /** `<vault>/style/*.md`. The built-in craft rules are added on top, always. */
  readonly style: readonly TextSource[];
  /**
   * The work's own rule sections from its `STYLE.md` (ground rules, point of view
   * and voice), layered after `style`. The period facts are in `periodFacts`.
   */
  readonly workRules?: TextSource | undefined;
  /**
   * The output's own `outputs/<type>/RULES.md` (AGT-1670), layered after the
   * work's rules and before the unit's slices. Its own slice, `outputRules`.
   */
  readonly outputRules?: TextSource | undefined;
  /**
   * Every `never.md` of the voices the work carries (AGT-2139), lowest layer
   * first: its own slice after the output's rules.
   */
  readonly never?: readonly TextSource[] | undefined;
  /**
   * The exemplars of the voices the work carries (AGT-2139), most specific
   * layer first and each voice's newest first, so a budget squeeze drops the
   * global voices' oldest pieces before the work's own.
   */
  readonly exemplars?: readonly TextSource[] | undefined;
  /** Which layers `style`, `workRules`, `outputRules`, `never` and `exemplars` came from, for the receipt. */
  readonly voiceLayers?: PackVoice | undefined;
  /** The work's own period and place section of its `STYLE.md`, when it has one; sent after `distilledFacts`. */
  readonly periodFacts?: TextSource | undefined;
  /**
   * `facts/period.md` (AGT-2110, D-10): the distilled, sourced period facts this unit may rely on, already filtered
   * to the unit's story date (`periodFactsAt`). Present whenever the work has the file, even with no row left.
   * The source note of each row is never sent; only the fact and its date.
   */
  readonly distilledFacts?: DistilledFacts | undefined;
  /**
   * `bible/overview.md` (AGT-2183): the premise — logline, premise, themes, tone — so the writer knows what the
   * piece is about. Its own slice in every fiction drafting pack; an essay sends it as the story it is about.
   */
  readonly premise?: TextSource | undefined;
  /**
   * `bible/characters/*.md` (AGT-2183): who exists. The family tree first, then each character's own file; `path`
   * names every file sent, `, `-separated.
   */
  readonly cast?: TextSource | undefined;
  /** `bible/places.md`. */
  readonly places?: TextSource | undefined;
  readonly timeline: TimelineGate;
  /** The unit's own output's continuity ledger: what this telling has already established. */
  readonly continuity?: TextSource | undefined;
  /** `facts.md` (AGT-1671): promoted facts every output must honour, whichever established them. */
  readonly facts?: TextSource | undefined;
  /** The tail of the previous chapter, to continue from. */
  readonly previousTail?: TextSource | undefined;
  readonly wordTarget: number;
  /** Minimum scenes to ask for. Default 3; a floor moves length more than words do. */
  readonly minScenes?: number | undefined;
  /** The author's (or harness's) steer for this chapter beyond the beat row, e.g. "slower, stay on Cora" (AGT-1562). Its own slice; absent or blank means none. */
  readonly direction?: string | undefined;
  /** An essay section's brief (AGT-2134): set, the pack drafts that section of an essay instead of a chapter. */
  readonly essay?: EssayBrief | undefined;
}

export interface AssembleOptions {
  /** Defaults to the chars-per-token estimator in `estimate.ts`. */
  readonly estimate?: TokenEstimator | undefined;
  /** Overrides the kind's default budget from `PACK_BUDGETS`. */
  readonly budgetTokens?: number | undefined;
}

/**
 * A named voice's own material, in the shape a prose pack draws from —
 * `readVoice` (`packages/cli/src/voice.ts`) returns exactly this shape, so a
 * caller passes it straight through without remapping.
 */
export interface VoiceInputs {
  /** `voice.md`'s body (frontmatter stripped); one source, or none for a bare directory. */
  readonly rules: readonly TextSource[];
  /** `exemplars/*.md`, newest first — the order the pack keeps them in. */
  readonly exemplars: readonly TextSource[];
  /** `never.md`, when the voice has one. */
  readonly never?: TextSource | undefined;
}

/**
 * `pablo prose --voice <name> --brief <file|-> [--context <file>]...` (AGT-1241):
 * a voice plus a brief, no stage machine. See the design doc's extension
 * (`pm project show ai-terminal --doc prose`).
 */
export interface ProseInputs {
  readonly voice: VoiceInputs;
  /**
   * The format stanza's already-rendered text (email/post/page/reply/note
   * live in `packages/cli/src/formats.ts`, a CLI concern — core only knows
   * it as one more slice of text). Omitted when no `--format` was given.
   */
  readonly format?: string | undefined;
  /** `--context` files, sent verbatim, in the order they were given. */
  readonly context: readonly TextSource[];
  /** The ask, as markdown (a file, stdin, or MCP text — resolved by the caller). */
  readonly brief: TextSource;
  /** Which layers `voice` was merged from (AGT-2139), for the receipt. */
  readonly voiceLayers?: PackVoice | undefined;
  /** Target word count; defaults to 300 (drafting's own default is a chapter, prose's is a short piece). */
  readonly wordTarget?: number | undefined;
  /**
   * The revise loop (AGT-1244): the previous output to rewrite, frontmatter
   * already stripped by the caller (`readVoice`'s own convention — a pack
   * input is prose, never pablo's own metadata). Present together with
   * `instruction`, or not at all; `assemblePack` switches to
   * `PROSE_REVISE_CLOSING` exactly when both are given.
   */
  readonly draft?: TextSource | undefined;
  /** What to change about `draft`, in the author's own words. See `draft`. */
  readonly instruction?: string | undefined;
}

/**
 * `pablo revise` (AGT-1257): rewrite one located passage of a manuscript in
 * place. This is the pure-core half — `locatePassage` (`document.ts`) turns
 * the author's quoted text into the `before`/`passage`/`after` split this
 * type carries; the `pablo revise` verb that reads a document and calls
 * `locatePassage` for the caller is AGT-1264.
 */
export interface ReviseInputs {
  /** `<vault>/style/*.md`, in the order they should appear. */
  readonly style: readonly TextSource[];
  /** The work's own rules file (`STYLE.md`) when it has one. */
  readonly workRules?: TextSource | undefined;
  /** The manuscript immediately before the passage, for continuity. */
  readonly before: string;
  /** The passage to rewrite, verbatim from the manuscript. */
  readonly passage: string;
  /** The manuscript immediately after the passage, for continuity. */
  readonly after: string;
  /** What to change about the passage, in the author's own words. */
  readonly instruction: string;
  /**
   * A reader's comment the revise answers (AGT-1642): who wrote it, the line(s) it was on, and what they said. The
   * comment says what is wrong; `instruction` stays the author's direction. Absent for a plain revise.
   */
  readonly readerNote?: ReaderNote | undefined;
}

/** A reader's comment on a passage, carried into a revise as its own section of the pack. */
export interface ReaderNote {
  readonly reader: string;
  /** The line(s) the comment was on, verbatim. */
  readonly quoted: string;
  readonly comment: string;
}
