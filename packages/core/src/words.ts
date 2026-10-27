// The one word counter (AGT-2175): `pablo status`'s per-unit `words` and the TUI editor's live count both come from
// here, so the editor's number for a saved file is `pablo status`'s. A word is a run of non-whitespace characters, the
// same rule `write` and `publish` count by; a file's count leaves its YAML frontmatter out.

const FRONTMATTER = /^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** Words in `text`: runs of non-whitespace. */
export function countWords(text: string): number {
  let n = 0;
  let inWord = false;
  for (const ch of text) {
    const space = /\s/.test(ch);
    if (!space && !inWord) n++;
    inWord = !space;
  }
  return n;
}

/** Words in a unit file's body: `raw` with a leading frontmatter block left out. */
export function fileWords(raw: string): number {
  return countWords(raw.replace(FRONTMATTER, ""));
}
