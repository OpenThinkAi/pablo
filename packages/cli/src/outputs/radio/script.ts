/**
 * The roles a radio script needs voices for (AGT-1686), read without the
 * Python side, so the radio output's stage checks (`perform` with an unbound
 * role is refused before anything runs) and `status`/`resume` never provision
 * it.
 *
 * This is only the role list, and it is the same list as
 * `packages/casting/src/pablo_casting/script.py`'s `Script.role_names()`: the
 * `CAST:` roles in order, then every speaker that speaks without being
 * declared. Directions, cues, descriptions and traits stay the Python side's
 * (one parser, tested once); `test/radio-output.test.ts` and
 * `packages/casting/tests/test_role_names_parity.py` read the same fixture
 * (`packages/casting/tests/fixtures/role_names.json`), so the two cannot drift.
 */

/** `script.py`'s `LINE`: a speaker in capitals, a colon, the words. */
const LINE = /^([A-Z][A-Z .'\-]{0,30}):\s*(.+)$/;
/** `script.py`'s `CUE`. */
const CUE = /^\[(SFX|BED|MUSIC):\s*(.+?)\]\s*$/i;
const PAREN = /\(([^)]*)\)/g;
const QUOTES = new Set(['"', "“", "”"]);

/** Whether the text has a `CAST:` line (`script.py`'s `has_cast_line`). */
export function hasCastLine(text: string): boolean {
  return text.split(/\r?\n/).some((raw) => raw.trim().replace(/\*/g, "").toUpperCase().startsWith("CAST:"));
}

/** How many lines the frontmatter takes (0 when there is none, or the fence is unclosed). */
function frontmatterLines(lines: readonly string[]): number {
  if ((lines[0] ?? "").trim() !== "---") return 0;
  for (let i = 1; i < lines.length; i += 1) if ((lines[i] ?? "").trim() === "---") return i + 1;
  return 0;
}

/** Splits on `sep` outside quotes, as `script.py`'s `_split_unquoted`. */
function splitUnquoted(text: string, sep: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of text) {
    if (QUOTES.has(char)) quoted = !quoted;
    if (char === sep && !quoted) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts;
}

/** The role names a `CAST:` line declares, upper-cased, in order. */
function castNames(raw: string): string[] {
  return splitUnquoted(raw, ",")
    .filter((part) => part.includes("="))
    .map((part) => (part.split("=", 1)[0] ?? "").trim().toUpperCase());
}

/** Every role the script needs a voice for: the `CAST:` roles, then any undeclared speaker, in order of first appearance. */
export function scriptRoles(text: string): string[] {
  const lines = text.split("\n");
  const declared: string[] = [];
  const speakers: string[] = [];
  for (const rawLine of lines.slice(frontmatterLines(lines))) {
    const raw = rawLine.trim().replace(/\*/g, "");
    if (raw === "") continue;
    if (raw.toUpperCase().startsWith("CAST:")) {
      for (const name of castNames(raw.slice(5))) if (!declared.includes(name)) declared.push(name);
      continue;
    }
    if (CUE.test(raw)) continue;
    const spoken = LINE.exec(raw);
    if (spoken === null) continue;
    // A line of only parentheticals (a non-verbal on its own) is dropped, as the Python reader drops it.
    if ((spoken[2] ?? "").replace(PAREN, "").trim() === "") continue;
    const speaker = (spoken[1] ?? "").trim();
    if (!speakers.includes(speaker)) speakers.push(speaker);
  }
  return [...declared, ...speakers.filter((s) => !declared.includes(s))];
}
