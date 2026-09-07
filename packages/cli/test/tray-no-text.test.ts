import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STATE_SOURCE_PATH = fileURLToPath(new URL("../src/tray/state.ts", import.meta.url));
const FORBIDDEN_WORDS = ["text", "body", "content", "prose", "path"];

/**
 * The state file the daemon writes for the menu-bar helper carries titles and
 * word counts only — no manuscript text, and no manuscript path either (the
 * helper never needs one and must never be handed one). This greps the
 * `TrayPiece` and `TrayState` declarations themselves (as text, not by
 * importing the module), the same discipline as
 * `test/review-no-text.test.ts` on `QueuedEvent`.
 */
function declarationOf(source: string, name: string): string {
  const start = source.indexOf(`export interface ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);

  // Depth-tracked brace matching, not a bare `indexOf("}")`: a bare search
  // finds the first close brace at any nesting depth, so it would silently
  // under-cover the declaration the moment a field gets an inline object type.
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
  return source.slice(start, end + 1);
}

test("TrayPiece's declaration contains none of the forbidden words", () => {
  const source = readFileSync(STATE_SOURCE_PATH, "utf8");
  const declaration = declarationOf(source, "TrayPiece");
  for (const word of FORBIDDEN_WORDS) {
    expect(declaration.toLowerCase().includes(word)).toBe(false);
  }
});

test("TrayState's declaration contains none of the forbidden words", () => {
  const source = readFileSync(STATE_SOURCE_PATH, "utf8");
  const declaration = declarationOf(source, "TrayState");
  for (const word of FORBIDDEN_WORDS) {
    expect(declaration.toLowerCase().includes(word)).toBe(false);
  }
});
