/**
 * The radio output's `RULES.md` template (AGT-1694, pm project
 * `pablo-casting`): the script shape, the cues, the length, the direction
 * grammar and its closed vocabulary, and the described `CAST:` line. The
 * `radio` registry entry (AGT-1686) takes it as its `rulesTemplate`; `pablo
 * output add radio` scaffolds it to `outputs/radio/RULES.md`, where it is its
 * own slice in the writer's pack.
 *
 * Generic on purpose: it carries no work's names or manuscript text. The
 * work's voice, period and characters come from the core's slices; this says
 * only how an episode is laid out and what `pablo check` accepts.
 *
 * The vocabulary below is the one in `packages/casting/src/pablo_casting/
 * directions.py` (`EMOTIONS`); `test/radio-rules.test.ts` fails if they drift.
 */

import { RADIO_DEFAULT_STYLE, RADIO_EPISODE_MINUTES, radioEpisodeWords, type RadioStyle } from "./style";

/** The delivery words (volume and breath), in `directions.py` `DELIVERIES` order (AGT-2319). */
export const RADIO_DELIVERIES = ["whisper", "hushed"] as const;

/** The closed emotion vocabulary, in `directions.py` order. */
export const RADIO_EMOTIONS = [
  "neutral",
  "warm",
  "amused",
  "dry",
  "tender",
  "tense",
  "urgent",
  "angry",
  "afraid",
  "sad",
  "weary",
  "boisterous",
] as const;

/** The non-verbals an actor may make inside a line. */
export const RADIO_NONVERBALS = ["laughs", "sighs", "gasps", "clears throat", "coughs"] as const;

/**
 * The rules for a style (AGT-2318): the old-time-radio conventions (announcer,
 * narrator, music) are the template's defaults, and a premise or request that
 * switches one off ("no narrator") gets rules that say so. Nothing is dropped
 * on its own: with no word on it, the template keeps its narrator.
 */
export function radioRules(style: RadioStyle = RADIO_DEFAULT_STYLE): string {
  const { announcer, narrator, music } = style;
  const off = [!announcer && "announcer", !narrator && "narrator", !music && "music"].filter((x): x is string => x !== false);
  const voices = [announcer && "the announcer", narrator && "the narrator"].filter((x): x is string => x !== false);
  const placing = narrator ? "a narrator line or a bed and a sound" : "a bed and a sound";
  const lines = [
    "    CAST: NAME=m \"description\", NAME=f \"description\", ...",
    ...(music ? ["    [MUSIC: short description]       an organ or band cue: theme, bridge, sting, swell"] : []),
    ...(announcer ? ["    ANNOUNCER: words                 opens and closes the episode, in the period's style"] : []),
    ...(narrator ? ["    NARRATOR: words                  sparing, past tense, sets place and time, bridges scenes"] : []),
    "    NAME: words                      a character speaks under their first name in capitals",
    "    [SFX: short description]         a one-shot sound made by the effects person",
    "    [BED: short description]         ambience that runs under the lines that follow",
    "    [BED: off]                       stops the ambience",
    "    [DRAMA]                          the lines that follow are a dramatic scene",
    "    [DRAMA: off]                     ends the scene",
  ].join("\n");
  return `# Radio rules

Rules for the radio output only, layered after the work's voice and before an
episode's own slices. Each episode is a script for a cast of voices: heard once,
read aloud, never seen. These rules replace the prose conventions where they
conflict (point of view, narration, scene breaks).${off.length === 0 ? "" : `

## Style

${style.source === undefined ? "This work's premise" : `This work's ${style.source}`} switches off: ${off.join(", ")}. The script has no ${off.map((o) => (o === "music" ? "[MUSIC] cues" : `${o.toUpperCase()} lines`)).join(" and no ")}${narrator ? "" : "; place, time and what just happened are heard in the dialogue and the sounds"}.`}

## The script

One item per line and nothing else: no markdown, no stage directions, no
em-dashes.

${lines}

A speech that runs long may continue on the next lines; it belongs to the
speaker above.

A dramatic scene is performed with a more emotional voice engine. Use it
sparingly, for the story's turning points (an accident, a death, a fire), never
for a whole episode. Each marker sits alone on its line and makes no sound;
close every \`[DRAMA]\` with \`[DRAMA: off]\` (an unclosed one runs to the end of
the episode), and never open one inside another.

## The shape of an episode

- ${[music && "Theme music", announcer && (music ? "then the announcer" : "The announcer") + " opens with the title and episode number, then a\n  line or two placing the listener"].filter((x): x is string => x !== false && x !== undefined).join(", ") || "Open on the first scene, with no theme and no announcer"}.
- Three to five scenes. Each opens with ${placing} that
  tells the ear where we are.${music ? " Music bridges between scenes." : ""}
- The story is carried by dialogue. A listener cannot see: who is in the room,
  what they are holding and what just happened must be heard, in what people say
  and in the sounds. Never have a character describe what both of them can see.
- 8 to 16 sound cues, each concrete and under ten words.
- End on ${music ? "a sting or " : ""}a held moment${announcer || music ? `, then ${[announcer && "the announcer closes", music && "the theme plays"].filter((x): x is string => x !== false).join(" and ")}` : ""}.
- Length: what fits a ${style.minutes ?? RADIO_EPISODE_MINUTES}-minute broadcast, about ${radioEpisodeWords(style.minutes).toLocaleString("en-US")} spoken words.
- The same voice as the work's other outputs: the same people, the same facts, the
  same register.

## The cast line

The first line of the script is \`CAST:\`. Every speaking role is on it, with its
gender (\`m\` or \`f\`) and a description in quotes, taken from the character
sheet in the core: age, then how the voice sounds, then anything that marks it.

    CAST: MAE=f "fifties, dry, unhurried", TOBY=m "twenties, quick, nervous"

- Describe every role${voices.length > 0 ? `, ${voices.join(" and ")} included` : ""}. A role with no
  description cannot be cast and \`pablo check\` reports it.
- A speaker who is not on the \`CAST:\` line is an undescribed role too: declare
  every voice before it speaks.
- Use plain words for the voice (age, pitch, pace, temperament). Do not name an
  actor or a real person.

## Directions

Direction is sparing. Most lines carry none; add one only where the delivery is not
what the words alone would give. One direction per line, in one leading
parenthesis, before the words:

    SPEAKER: (<emotion>[, <intensity>][, <pace>]) words

- emotion, one of exactly these twelve words: ${RADIO_EMOTIONS.join(", ")}.
  No other word, no synonym, no adverb: write \`dry\`, never \`dryly\`.
- intensity, optional: \`a little\` or \`very\`.
- pace, optional: \`slow\` or \`quick\`.
- delivery, optional: ${RADIO_DELIVERIES.map((d) => `\`${d}\``).join(" or ")}, for a voice that is
  lowered or breathed rather than felt. It goes in the same parenthesis, beside an
  emotion or alone: \`(whisper, afraid)\`. The mix lowers the line and gives it a
  close-mic EQ. The mixer changes the line's gain; the EQ lives in the mix
  document, in the clip's \`eq\`.
- A line takes at most one direction. Never a second parenthesis for delivery, and
  none for a sound or a movement: put sounds in an \`[SFX: ...]\` cue.
- Inside a line an actor may make these sounds, sparingly:
  ${RADIO_NONVERBALS.map((n) => `(${n})`).join(" ")}. They are not directions.

\`pablo check\` reports a direction outside the vocabulary, a line with more than
one, a role with no description, a \`[DRAMA: off]\` with no open scene and a
\`[DRAMA]\` inside one, each with its line number.
`;
}

/** The template with every convention on: what a premise that says nothing gets. */
export const RADIO_RULES_TEMPLATE = radioRules();
