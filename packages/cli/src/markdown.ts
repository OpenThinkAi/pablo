/**
 * Shared plain-markdown `## `-section helpers (AGT-1243).
 *
 * `insertUnderHeading` started life private to `novel/continuity.ts`
 * (AGT-1232, the continuity ritual filing extracted facts under
 * `continuity.md`'s headings) and is extracted here verbatim, unchanged, so
 * `voice.ts`'s `flagLine` (AGT-1243, filing a rejected line under a voice's
 * `## Flagged` section) can reuse the same "insert at the end of this
 * section, or append the section at EOF if it doesn't exist yet" logic
 * without copying it. `continuity.ts` imports it back from here; its own
 * tests pin this function's behaviour and must keep passing unchanged.
 */

/**
 * Finds `heading`'s section in `lines` (its line to the next `## ` heading or
 * EOF) and inserts `bulletLine` as the section's last line, preserving
 * everything else byte-for-byte. A missing heading is appended at EOF as
 * `heading`, a blank line, then `bulletLine` — matching the fixture's own
 * "heading, blank line, first bullet" shape.
 */
export function insertUnderHeading(lines: readonly string[], heading: string, bulletLine: string): string[] {
  const headingIndex = lines.findIndex((line) => line.trim() === heading);

  if (headingIndex === -1) {
    const result = [...lines];
    while (result.length > 0 && (result[result.length - 1] ?? "") === "") result.pop();
    if (result.length > 0) result.push("");
    result.push(heading, "", bulletLine);
    return result;
  }

  let sectionEnd = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i] ?? "")) {
      sectionEnd = i;
      break;
    }
  }

  let insertAt = sectionEnd;
  for (let i = sectionEnd - 1; i > headingIndex; i--) {
    if ((lines[i] ?? "").trim() !== "") {
      insertAt = i + 1;
      break;
    }
  }

  const result = [...lines];
  result.splice(insertAt, 0, bulletLine);
  return result;
}
