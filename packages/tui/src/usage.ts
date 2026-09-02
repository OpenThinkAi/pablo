export const USAGE = `pablo — an AI-native terminal tool for writing and composition.

usage: pablo [file.md]

  pablo              print this message
  pablo chapter.md   open the manuscript view

In the view — no action needs a function key or a number key:

  n / p        select the next / previous unit
  + / -        expand / shrink: sentence, paragraph, scene, chapter
  [ ] { }      nudge the selection start / end one character
  i / a        collapse to the boundary before / after the selection
  space / b    page down / up          g / G   start / end of the manuscript
  r            re-read from disk       ?       all keys
  q            quit

The file is re-read whenever it changes on disk, so editing it elsewhere is a
supported way to work.

pablo proposes; it never writes on its own. The model has no write tool —
every accepted proposal is applied by the app and re-read from disk.

Design doc: saltline-digital-vault/projects/ai-terminal/README.md
`;
