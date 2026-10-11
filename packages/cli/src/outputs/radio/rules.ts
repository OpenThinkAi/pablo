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

export const RADIO_RULES_TEMPLATE = `# Radio rules

Rules for the radio output only, layered after the work's voice and before an
episode's own slices. Each episode is a script for a cast of voices: heard once,
read aloud, never seen. These rules replace the prose conventions where they
conflict (point of view, narration, scene breaks).

## The script

One item per line and nothing else: no markdown, no stage directions, no
em-dashes.

    CAST: NAME=m "description", NAME=f "description", ...
    [MUSIC: short description]       an organ or band cue: theme, bridge, sting, swell
    ANNOUNCER: words                 opens and closes the episode, in the period's style
    NARRATOR: words                  sparing, past tense, sets place and time, bridges scenes
    NAME: words                      a character speaks under their first name in capitals
    [SFX: short description]         a one-shot sound made by the effects person
    [BED: short description]         ambience that runs under the lines that follow
    [BED: off]                       stops the ambience

A speech that runs long may continue on the next lines; it belongs to the
speaker above.

## The shape of an episode

- Theme music, then the announcer opens with the title and episode number, then a
  line or two placing the listener.
- Three to five scenes. Each opens with a narrator line or a bed and a sound that
  tells the ear where we are. Music bridges between scenes.
- The story is carried by dialogue. A listener cannot see: who is in the room,
  what they are holding and what just happened must be heard, in what people say
  and in the sounds. Never have a character describe what both of them can see.
- 8 to 16 sound cues, each concrete and under ten words.
- End on a sting or a held moment, then the announcer closes and the theme plays.
- Length: what fits a twelve-minute broadcast, about 1,800 spoken words.
- The same voice as the work's other outputs: the same people, the same facts, the
  same register.

## The cast line

The first line of the script is \`CAST:\`. Every speaking role is on it, with its
gender (\`m\` or \`f\`) and a description in quotes, taken from the character
sheet in the core: age, then how the voice sounds, then anything that marks it.

    CAST: MAE=f "fifties, dry, unhurried", TOBY=m "twenties, quick, nervous"

- Describe every role, the announcer and the narrator included. A role with no
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
- A line takes at most one direction. Never a second parenthesis for delivery, and
  none for a sound or a movement: put sounds in an \`[SFX: ...]\` cue.
- Inside a line an actor may make these sounds, sparingly:
  ${RADIO_NONVERBALS.map((n) => `(${n})`).join(" ")}. They are not directions.

\`pablo check\` reports a direction outside the vocabulary, a line with more than
one, and a role with no description, each with its line number.
`;
