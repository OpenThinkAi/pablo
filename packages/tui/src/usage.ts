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
  B            the work brief          q       quit

The file is re-read whenever it changes on disk, so editing it elsewhere is a
supported way to work.

Opening a file under <vault>/<kind>/<slug>/ runs \`think brief --cortex writing
--context <slug>\` once, in the background, and keeps the result in memory for
the session. \`B\` shows it. If \`think\` is not on PATH the view opens anyway and
says so in the status line.

pablo proposes; it never writes on its own. The model has no write tool —
every accepted proposal is applied by the app and re-read from disk.

Design doc: saltline-digital-vault/projects/ai-terminal/README.md
`;
