/**
 * The sentence splitter behind one-sentence-per-line manuscripts (AGT-1530).
 *
 * Chapters are stored one sentence per line so a git diff is a sentence diff;
 * a blank line still separates paragraphs, and markdown renders the single
 * newlines as spaces, so readers never see the splits. The model never sees
 * them either: pablo splits a paragraph when it saves and joins the lines
 * back before anything is sent to a model.
 *
 * The rules are tuned for fiction rather than for prose in general: dialogue
 * and its tags, a quote holding several sentences, honorifics (`Mr.`, `Dr.`,
 * `St.`), initials, ellipses, and speech broken off with a dash. A wrong split
 * is harmless — the paragraph reads the same once joined — it only makes the
 * diffs noisier, so where a rule is unsure it leans towards not splitting.
 *
 * Pure and dependency-free: the only contract is that
 * `joinSentences(splitSentences(p))` is `p` with its whitespace runs collapsed
 * to single spaces and trimmed.
 */

/**
 * The whitespace a split normalizes: ASCII spaces, tabs and line breaks. A
 * no-break space is deliberately not in the set — an author who typed
 * `Mr. Hale` asked for those two words to stay together, and they do.
 */
const WHITESPACE = /[ \t\n\r\f\v]+/g;

/** Characters that can close a sentence after its terminal punctuation: quotes, brackets, emphasis. */
const CLOSERS = new Set(['"', "”", "'", "’", ")", "]", "»", "*", "_"]);

/** Characters that can open a sentence before its first letter. */
const OPENERS = new Set(['"', "“", "'", "‘", "(", "[", "«", "*", "_"]);

/** Closing quotation marks, for telling dialogue from narration. */
const CLOSING_QUOTES = new Set(['"', "”", "'", "’", "»"]);

/**
 * Abbreviations that never end a sentence in fiction: honorifics and titles,
 * which always lead into a name, plus the Latin pair that leads into a gloss.
 * Lower-cased, without the final period. `etc.` and `a.m.`/`p.m.` are left
 * out on purpose — they end sentences often enough that splitting before a
 * capital is the better bet.
 */
const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "mx",
  "dr",
  "st",
  "prof",
  "rev",
  "fr",
  "sr",
  "jr",
  "capt",
  "cpt",
  "col",
  "gen",
  "lt",
  "sgt",
  "cpl",
  "maj",
  "adm",
  "gov",
  "sen",
  "rep",
  "hon",
  "pres",
  "supt",
  "insp",
  "messrs",
  "mme",
  "mlle",
  "mt",
  "ft",
  "vs",
  "e.g",
  "i.e",
  "cf",
]);

/**
 * Verbs of speaking, for recognising a dialogue tag that starts with a name:
 * `"Get down!" Mara shouted.` is one sentence, not two.
 */
const SPEECH_VERBS = new Set([
  "said",
  "says",
  "asked",
  "asks",
  "shouted",
  "yelled",
  "whispered",
  "called",
  "cried",
  "replied",
  "answered",
  "muttered",
  "murmured",
  "snapped",
  "began",
  "added",
  "continued",
  "insisted",
  "demanded",
  "hissed",
  "breathed",
  "screamed",
  "sighed",
  "laughed",
  "warned",
  "barked",
  "gasped",
  "growled",
  "repeated",
  "offered",
  "admitted",
  "agreed",
  "protested",
  "pleaded",
  "roared",
  "stammered",
  "managed",
  "groaned",
  "sobbed",
  "spat",
  "told",
  "wondered",
  "explained",
  "interrupted",
  "exclaimed",
  "mumbled",
  "croaked",
]);

/** How many leading name words a tag may have before its speech verb (`Old Mr. Hale said`). */
const MAX_TAG_NAME_WORDS = 3;

/** Collapses every whitespace run to one space and trims the ends. */
function normalizeWhitespace(text: string): string {
  return text.replace(WHITESPACE, " ").trim();
}

/** `token` without its trailing closing quotes, brackets and emphasis marks. */
function stripClosers(token: string): string {
  let end = token.length;
  while (end > 0 && CLOSERS.has(token[end - 1] as string)) end--;
  return token.slice(0, end);
}

/** `token` without its leading opening quotes, brackets and emphasis marks. */
function stripOpeners(token: string): string {
  let start = 0;
  while (start < token.length && OPENERS.has(token[start] as string)) start++;
  return token.slice(start);
}

/** Whether `token` ends with a closing quotation mark (possibly inside a bracket or emphasis). */
function endsInQuote(token: string): boolean {
  for (let i = token.length - 1; i >= 0; i--) {
    const ch = token[i] as string;
    if (CLOSING_QUOTES.has(ch)) return true;
    if (!CLOSERS.has(ch)) return false;
  }
  return false;
}

function isEllipsis(core: string): boolean {
  return core.endsWith("...") || core.endsWith("…");
}

function isDash(core: string): boolean {
  return core.endsWith("—") || core.endsWith("–") || core.endsWith("--");
}

/** Whether a token (openers already stripped) starts the way a sentence starts: a capital letter. */
function startsUpper(text: string): boolean {
  return /^\p{Lu}/u.test(text);
}

/** A word with surrounding punctuation removed, lower-cased, for list lookups. */
function bare(token: string): string {
  return stripOpeners(stripClosers(token))
    .replace(/[,.;:!?…]+$/u, "")
    .toLowerCase();
}

/**
 * Whether the words starting at `tokens[from]` read as a dialogue tag led by a
 * name — up to {@link MAX_TAG_NAME_WORDS} capitalised words (or honorifics),
 * then a verb of speaking: `Mara said`, `Mr. Hale asked`, `I whispered`.
 */
function isNamedTag(tokens: readonly string[], from: number): boolean {
  for (let i = from; i < tokens.length && i <= from + MAX_TAG_NAME_WORDS; i++) {
    const token = tokens[i] as string;
    const word = bare(token);
    if (i > from && SPEECH_VERBS.has(word)) return true;
    const isName = startsUpper(stripOpeners(token)) || ABBREVIATIONS.has(word);
    if (!isName) return false;
    // A name word that itself ends the clause (`Mara.`) cannot lead a tag.
    if (/[.!?,;:]$/u.test(stripClosers(token)) && !ABBREVIATIONS.has(word)) return false;
  }
  return false;
}

/**
 * Whether a sentence ends between `tokens[i]` and `tokens[i + 1]`.
 *
 * The left word must end in terminal punctuation — `.`, `!`, `?`, an
 * ellipsis, or (inside a closing quote) a dash for broken-off speech — with
 * any closing quotes and brackets after it; the right word must start with a
 * capital, after any opening quotes. Then the exceptions: honorifics and
 * initials, a stammer across an ellipsis, a spaced ellipsis, and a dialogue
 * tag led by a name.
 */
function endsSentence(tokens: readonly string[], i: number): boolean {
  const left = tokens[i] as string;
  const right = tokens[i + 1] as string;
  const core = stripClosers(left);
  const quoted = endsInQuote(left);

  // A spaced ellipsis (`wait . . . for`) is one mark split over several words.
  if (right.startsWith(".")) return false;

  const ellipsis = isEllipsis(core) || core === ".";
  const dash = quoted && isDash(core);
  const terminal = /[.!?]$/u.test(core) || ellipsis || dash;
  if (!terminal) return false;

  if (!startsUpper(stripOpeners(right))) return false;

  if (core.endsWith(".") && !ellipsis) {
    const word = core.slice(0, -1);
    // Honorifics and Latin glosses: `Mr. Hale`, `St. Clair`, `e.g. Paris`.
    if (ABBREVIATIONS.has(stripOpeners(word).toLowerCase())) return false;
    // Initials: `J. R. Morrow`, `T.S. Eliot` — but not the pronoun (`It was I. Then...`).
    const initials = stripOpeners(word);
    if (initials !== "I" && /^(\p{Lu}\.)*\p{Lu}$/u.test(initials)) return false;
  }

  if (ellipsis) {
    // A stammer: `I... I don't know.`
    const before = bare(core.replace(/(\.\.\.|…)$/u, ""));
    if (before !== "" && before === bare(right)) return false;
  }

  // `"Get down!" Mara shouted.` — a tag after an exclamation, question,
  // ellipsis or dash belongs to the quote's sentence. After a plain period
  // the quote did end its sentence, so a capital starts a new one.
  if (quoted && (ellipsis || !core.endsWith("."))) {
    if (isNamedTag(tokens, i + 1)) return false;
  }

  return true;
}

/**
 * Splits one paragraph into its sentences, in order, each with its own
 * closing quotes and brackets attached. Whitespace runs inside the paragraph
 * (including hard-wrapped line breaks) collapse to single spaces; an empty or
 * whitespace-only paragraph has no sentences.
 *
 * A quote holding several sentences is split inside the quote, so a line can
 * open a quotation another line closes — joining puts it back together.
 */
export function splitSentences(paragraph: string): string[] {
  const text = normalizeWhitespace(paragraph);
  if (text === "") return [];

  const tokens = text.split(" ");
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (endsSentence(tokens, i)) {
      sentences.push(tokens.slice(start, i + 1).join(" "));
      start = i + 1;
    }
  }
  sentences.push(tokens.slice(start).join(" "));
  return sentences;
}

/**
 * Joins sentence lines back into one paragraph: lines joined with a space,
 * whitespace runs collapsed, ends trimmed. The inverse of
 * {@link splitSentences} up to whitespace.
 */
export function joinSentences(lines: readonly string[]): string {
  return normalizeWhitespace(lines.join(" "));
}

/**
 * Joins a whole document's sentence lines back into paragraphs: each run of
 * non-blank lines becomes one line, and paragraphs stay separated by one blank
 * line. For code that assumes one paragraph per line (AGT-1532) — a document
 * already stored one paragraph per line comes back unchanged, so it is safe to
 * call on either layout. Lines are trimmed; runs of blank lines collapse to one.
 */
export function joinParagraphs(text: string): string {
  const paragraphs: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length > 0) paragraphs.push(joinSentences(run));
    run = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") flush();
    else run.push(line);
  }
  flush();
  return paragraphs.join("\n\n");
}

/** Splits a text into paragraphs on blank lines, dropping empty ones. */
function paragraphsOf(text: string): string[] {
  return text
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
}

/**
 * Whether a block is plain prose. A block with any line that opens like
 * markdown structure (heading, list item, quote, table row, fence, rule) is
 * left alone, so joining never glues a table or a bullet list into one line.
 */
function isProseBlock(block: string): boolean {
  return !block.split("\n").some((line) => /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|~~~|---+\s*$|\*\*\*+\s*$)/.test(line));
}

/**
 * Splits a whole text into the saved form: each paragraph one sentence per
 * line, paragraphs separated by one blank line. Blocks that are not plain
 * prose (see {@link isProseBlock}) pass through unchanged.
 */
export function splitManuscript(text: string): string {
  return paragraphsOf(text)
    .map((block) => (isProseBlock(block) ? splitSentences(block).join("\n") : block))
    .join("\n\n");
}

/**
 * The inverse, for everything sent to a model: sentence lines rejoin into
 * paragraphs, paragraphs stay separated by one blank line. Lossless for text
 * {@link splitManuscript} produced, and a no-op on text that is already one
 * paragraph per line.
 */
export function joinManuscript(text: string): string {
  return paragraphsOf(text)
    .map((block) => (isProseBlock(block) ? joinSentences(block.split("\n")) : block))
    .join("\n\n");
}
