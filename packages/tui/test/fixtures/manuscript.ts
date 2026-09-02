/**
 * A generator for manuscript-sized fixtures.
 *
 * AC1 is about a 200k-token file, which is ~1.3MB of prose — far too big to
 * commit, and pointless to commit anyway since nothing about it is interesting
 * except its size. The generator is committed instead: deterministic for a
 * given seed, shaped like a real book (chapters, scene breaks, paragraphs of
 * sentences), and salted with all five CriticMarkup forms, including marks that
 * cross a paragraph break and a scene break so the layout is exercised where it
 * is hardest.
 *
 * Tokens are estimated at 0.75 words per token, the usual English ratio.
 */

const WORDS = [
  "valley", "cellar", "harvest", "trellis", "vintage", "cooperage", "must", "brandy",
  "sulphur", "mildew", "rootstock", "phylloxera", "railcar", "sacrament", "altar", "priest",
  "sheriff", "warrant", "ledger", "creek", "fog", "oak", "barrel", "press",
  "the", "a", "and", "of", "in", "with", "against", "under",
  "she", "he", "they", "him", "her", "it", "them", "who",
  "waited", "counted", "poured", "walked", "listened", "remembered", "hid", "wrote",
  "slow", "cold", "green", "bitter", "quiet", "long", "sour", "bright",
];

const NAMES = ["Ada", "Emil", "Josefina", "Mr. Vane", "Dr. Salt", "Costanza"];

/** mulberry32: small, fast, and identical everywhere, which is the whole point. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ManuscriptOptions {
  /** Roughly how many tokens of prose to produce. */
  readonly tokens: number;
  readonly seed?: number;
  /** Sprinkle CriticMarkup through the prose. On by default. */
  readonly marks?: boolean;
}

interface Generator {
  readonly next: () => number;
  pick<T>(items: readonly T[]): T;
  int(low: number, high: number): number;
}

function generator(seed: number): Generator {
  const next = random(seed);
  const int = (low: number, high: number): number => low + Math.floor(next() * (high - low + 1));
  return {
    next,
    int,
    pick<T>(items: readonly T[]): T {
      const item = items[int(0, items.length - 1)];
      if (item === undefined) throw new Error("empty pool");
      return item;
    },
  };
}

function sentence(rng: Generator): string {
  const length = rng.int(8, 18);
  const words: string[] = [];
  for (let index = 0; index < length; index += 1) {
    words.push(rng.next() < 0.06 ? rng.pick(NAMES) : rng.pick(WORDS));
  }
  const first = words[0] ?? "The";
  words[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return `${words.join(" ")}${rng.next() < 0.12 ? "?" : "."}`;
}

function paragraph(rng: Generator): string {
  const sentences: string[] = [];
  for (let index = 0, length = rng.int(3, 6); index < length; index += 1) sentences.push(sentence(rng));
  return sentences.join(" ");
}

function marked(rng: Generator, text: string): string {
  switch (rng.int(0, 4)) {
    case 0:
      return `${text}{++ ${sentence(rng)}++}`;
    case 1:
      return `${text} {--${sentence(rng)}--}`;
    case 2:
      return text.replace(/\b(\w{6,})\b/, (word) => `{~~${word}~>${rng.pick(WORDS)}~~}`);
    case 3:
      return `${text}{>>${rng.pick(NAMES)} would not say this<<}`;
    default:
      return `{==${text}==}`;
  }
}

/** Words per token, the usual English estimate. */
const WORDS_PER_TOKEN = 0.75;

export function generateManuscript(options: ManuscriptOptions): string {
  const rng = generator(options.seed ?? 20260902);
  const withMarks = options.marks ?? true;
  const targetWords = Math.max(1, Math.round(options.tokens * WORDS_PER_TOKEN));

  const parts: string[] = [];
  let words = 0;
  let chapter = 0;
  let paragraphs = 0;

  while (words < targetWords) {
    chapter += 1;
    parts.push(`# Chapter ${chapter}\n`);

    for (let scene = 0; scene < rng.int(3, 6) && words < targetWords; scene += 1) {
      if (scene > 0) parts.push("* * *\n");

      const count = rng.int(4, 9);
      for (let index = 0; index < count && words < targetWords; index += 1) {
        paragraphs += 1;
        let text = paragraph(rng);

        if (withMarks && paragraphs % 9 === 0) text = marked(rng, text);
        if (withMarks && paragraphs % 47 === 0) {
          // A mark that opens here and closes in the next paragraph, or across
          // the scene break — legal CriticMarkup that a per-block renderer has
          // to carry between blocks.
          text = `{==${text}\n\n${paragraph(rng)}==}`;
          words += 40;
        }

        words += text.split(/\s+/).length;
        parts.push(`${text}\n`);
      }
    }
  }

  return parts.join("\n");
}
