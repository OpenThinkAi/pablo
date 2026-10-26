/**
 * The screenplay output's `RULES.md` template (AGT-2132): valid Fountain,
 * one scene per unit. `pablo output add screenplay` scaffolds it to
 * `outputs/screenplay/RULES.md`, where it is its own slice in the writer's
 * pack, layered after the work's voice.
 *
 * Generic on purpose: no work's names or text. What `pablo check` flags here
 * is `./fountain.ts`'s `lintFountain`.
 */

export const SCREENPLAY_RULES_TEMPLATE = `# Screenplay rules

Rules for the screenplay output only, layered after the work's voice and before a
scene's own slices. Each unit is one scene of a screenplay, written in Fountain
(https://fountain.io), plain text that screenwriting tools read and format. These
rules replace the prose conventions where they conflict: there is no narrator, no
point of view and no interior thought, only what the camera sees and what people
say. Wherever the pack says "chapter", it means the scene.

## Fountain

Write Fountain and nothing else: no Markdown, no code fences, no notes about the
scene. Separate every element with one blank line, except dialogue, which sits
directly under its character.

    INT. KITCHEN - NIGHT

    Rain on the window. MAE (50s) counts coins into a jar.

    MAE
    (not looking up)
    You're late.

    TOBY
    The bridge was out.

    CUT TO:

- **Scene heading**: the scene opens with one, alone on its line with a blank
  line before and after it: \`INT.\` or \`EXT.\` (or \`INT./EXT.\`), the place, a
  dash, the time of day, in capitals. A scene that moves to a new place gets a new
  heading.
- **Action**: what we see and hear, in the present tense, in short paragraphs of
  a few lines. Introduce a character in capitals the first time they appear, with
  an age or a glimpse of them. Never describe what cannot be filmed.
- **Character**: the speaker's name in capitals on its own line, a blank line
  above it. Use the same name every time. \`(V.O.)\` and \`(O.S.)\` may follow it.
- **Dialogue**: directly under the character, no blank line between. Never write
  \`NAME: words\` on one line; that is not Fountain.
- **Parenthetical**: a short delivery note in parentheses on its own line,
  between the character and the dialogue, sparingly. Never outside a speech.
- **Transition**: \`CUT TO:\` and the like, in capitals, alone on a line,
  sparingly; most scenes need none.

## The shape of a scene

- One scene per unit, telling the beat it is given and nothing beyond it. Start
  late, leave early.
- The story is carried by what people do and say. Subtext over statement: people
  rarely say what they mean.
- Length: about two to four pages, one page to a minute of screen time.
- The same people, facts and register as the work's other outputs.

\`pablo check\` reports a scene with no opening heading, a heading not set off
by blank lines, a character with no dialogue, a parenthetical outside a speech,
\`NAME: words\` lines, Markdown fences and an unclosed \`/*\`, each with its line
number.
`;
