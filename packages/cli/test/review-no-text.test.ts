import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REVIEW_SOURCE_PATH = fileURLToPath(new URL("../src/review.ts", import.meta.url));
const FORBIDDEN_WORDS = ["text", "body", "content", "prose"];

/**
 * The queue carries no manuscript text — id, kind, title, path, vault,
 * project, word count, prompt hash only. This greps the `QueuedEvent`
 * declaration itself (as text, not by importing the module) so a future edit
 * that sneaks a text-bearing field back in fails loudly.
 */
test("QueuedEvent's declaration contains none of the forbidden words", () => {
  const source = readFileSync(REVIEW_SOURCE_PATH, "utf8");

  const start = source.indexOf("export interface QueuedEvent");
  expect(start).toBeGreaterThanOrEqual(0);

  // Depth-tracked brace matching, not a bare `indexOf("}")`: a bare search
  // finds the first close brace at any nesting depth, so it would silently
  // under-cover the declaration the moment a field gets an inline object
  // type (e.g. `metadata?: { origin: string }`).
  let depth = 0;
  let end = -1;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  expect(end).toBeGreaterThan(start);

  const declaration = source.slice(start, end + 1);

  for (const word of FORBIDDEN_WORDS) {
    expect(declaration.toLowerCase().includes(word)).toBe(false);
  }
});
