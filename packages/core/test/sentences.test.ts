import { describe, expect, test } from "bun:test";
import { joinSentences, splitSentences } from "../src/index";

/**
 * The fiction sentence splitter (AGT-1530). Every fixture below is invented
 * for this test — no manuscript text belongs in this repo, whose GitHub
 * mirror is public.
 *
 * Each case is a paragraph and the sentence lines it must split into. Every
 * case is also checked for the round-trip contract: joining the lines gives
 * back the paragraph with its whitespace normalized.
 */

interface Case {
  readonly name: string;
  readonly paragraph: string;
  readonly lines: readonly string[];
}

const CASES: readonly Case[] = [
  // Plain narration.
  {
    name: "one sentence stays one line",
    paragraph: "The ferry left the quay at dawn.",
    lines: ["The ferry left the quay at dawn."],
  },
  {
    name: "periods, questions and exclamations end sentences",
    paragraph: "The tide turned. Would the ferry wait? It would not!",
    lines: ["The tide turned.", "Would the ferry wait?", "It would not!"],
  },
  {
    name: "a lowercase word after a period does not start a sentence",
    paragraph: "She bought bread, eggs, etc. and walked home.",
    lines: ["She bought bread, eggs, etc. and walked home."],
  },
  {
    name: "stacked marks end one sentence",
    paragraph: "You sold the boat?! Without asking me?",
    lines: ["You sold the boat?!", "Without asking me?"],
  },

  // Dialogue and tags.
  {
    name: "a lowercase tag after a quoted comma stays with the quote",
    paragraph: '"The ferry is late," Ines said. "It is always late."',
    lines: ['"The ferry is late," Ines said.', '"It is always late."'],
  },
  {
    name: "a lowercase tag after a quoted question stays with the quote",
    paragraph: '"Who rang the bell?" asked the warden. Nobody answered.',
    lines: ['"Who rang the bell?" asked the warden.', "Nobody answered."],
  },
  {
    name: "a pronoun tag after an exclamation stays with the quote",
    paragraph: '"Get off the pier!" he shouted. The boys scattered.',
    lines: ['"Get off the pier!" he shouted.', "The boys scattered."],
  },
  {
    name: "a named tag after an exclamation stays with the quote",
    paragraph: '"Get down!" Mara shouted. The lamp shattered above them.',
    lines: ['"Get down!" Mara shouted.', "The lamp shattered above them."],
  },
  {
    name: "a named tag with an honorific stays with the quote",
    paragraph: '"Is it raining?" Mr. Quill asked. It was.',
    lines: ['"Is it raining?" Mr. Quill asked.', "It was."],
  },
  {
    name: "the pronoun I leads a tag too",
    paragraph: '"Wait for me!" I called. The cart did not stop.',
    lines: ['"Wait for me!" I called.', "The cart did not stop."],
  },
  {
    name: "an exclamation followed by a named action is two sentences",
    paragraph: '"Run!" Mara grabbed his sleeve and pulled.',
    lines: ['"Run!"', "Mara grabbed his sleeve and pulled."],
  },
  {
    name: "a quote closed with a period ends its sentence even before a named verb",
    paragraph: '"I am going home." Mara said nothing to that.',
    lines: ['"I am going home."', "Mara said nothing to that."],
  },
  {
    name: "two speakers in a row split at the closing quote",
    paragraph: '"Yes." "No." "Maybe, then?"',
    lines: ['"Yes."', '"No."', '"Maybe, then?"'],
  },
  {
    name: "curly quotes behave like straight ones",
    paragraph: "“It’s cold,” she said. “Shut the door.” He shut it.",
    lines: ["“It’s cold,” she said.", "“Shut the door.”", "He shut it."],
  },
  {
    name: "a tag in the middle of a quoted sentence",
    paragraph: '"If the river rises," said Ines, "we leave tonight." Nobody argued.',
    lines: ['"If the river rises," said Ines, "we leave tonight."', "Nobody argued."],
  },

  // A quote holding several sentences.
  {
    name: "a quote holding several sentences splits inside the quote",
    paragraph: '"Stop. Look at me. Now listen."',
    lines: ['"Stop.', "Look at me.", 'Now listen."'],
  },
  {
    name: "a multi-sentence quote with a tag in the middle",
    paragraph: '"Stop. Look at me," he said. "Now listen. Are you listening?"',
    lines: ['"Stop.', 'Look at me," he said.', '"Now listen.', 'Are you listening?"'],
  },
  {
    name: "a multi-sentence quote with curly quotes",
    paragraph: "“The lock is new. Someone changed it. Why?” Ines frowned.",
    lines: ["“The lock is new.", "Someone changed it.", "Why?”", "Ines frowned."],
  },

  // Nested quotes.
  {
    name: "a nested quote ending a sentence inside the outer quote",
    paragraph: "\"She told me, 'Run.' So I ran.\"",
    lines: ["\"She told me, 'Run.'", 'So I ran."'],
  },
  {
    name: "nested quotes closing together end the sentence",
    paragraph: "\"He only said, 'Not tonight.'\" The fire was out.",
    lines: ["\"He only said, 'Not tonight.'\"", "The fire was out."],
  },
  {
    name: "nested curly quotes",
    paragraph: "“The sign said ‘Closed.’ We went anyway.”",
    lines: ["“The sign said ‘Closed.’", "We went anyway.”"],
  },
  {
    name: "a quoted word mid-sentence does not split",
    paragraph: "He called it 'the long night.' and nothing more.",
    lines: ["He called it 'the long night.' and nothing more."],
  },

  // Honorifics and abbreviations.
  {
    name: "Mr., Mrs. and Dr. do not end sentences",
    paragraph: "Mr. Quill met Mrs. Abernathy outside. Dr. Lyle was late.",
    lines: ["Mr. Quill met Mrs. Abernathy outside.", "Dr. Lyle was late."],
  },
  {
    name: "St. as a saint's name and as a street",
    paragraph: "They prayed at St. Brennock's. The bells were silent.",
    lines: ["They prayed at St. Brennock's.", "The bells were silent."],
  },
  {
    name: "Ms., Prof. and military ranks",
    paragraph: "Ms. Varga argued with Prof. Ede. Capt. Holm and Sgt. Pike kept out of it.",
    lines: ["Ms. Varga argued with Prof. Ede.", "Capt. Holm and Sgt. Pike kept out of it."],
  },
  {
    name: "an honorific at the end of a sentence still holds the next name",
    paragraph: "The note was signed by Dr. Lyle.",
    lines: ["The note was signed by Dr. Lyle."],
  },
  {
    name: "honorifics are case-insensitive and survive opening quotes",
    paragraph: '"MR. Quill is here," said the boy.',
    lines: ['"MR. Quill is here," said the boy.'],
  },
  {
    name: "Latin glosses do not end sentences",
    paragraph: "Bring something warm, e.g. Wool or fleece.",
    lines: ["Bring something warm, e.g. Wool or fleece."],
  },
  {
    name: "a.m. and p.m. end a sentence before a capital",
    paragraph: "The train left at six p.m. Nobody saw it go.",
    lines: ["The train left at six p.m.", "Nobody saw it go."],
  },
  {
    name: "No. before a numeral is not a sentence",
    paragraph: "She lived at No. 9 on the hill.",
    lines: ["She lived at No. 9 on the hill."],
  },
  {
    name: '"No." as a whole reply is a sentence',
    paragraph: '"No." She closed the gate.',
    lines: ['"No."', "She closed the gate."],
  },

  // Initials.
  {
    name: "spaced initials hold a name together",
    paragraph: "The book was by J. R. Morrow. Nobody had read it.",
    lines: ["The book was by J. R. Morrow.", "Nobody had read it."],
  },
  {
    name: "run-together initials hold a name together",
    paragraph: "T.S. Ambler wrote back. A.J. Penn did not.",
    lines: ["T.S. Ambler wrote back.", "A.J. Penn did not."],
  },
  {
    name: "a middle initial",
    paragraph: "Harriet K. Vance owned the mill. She never visited it.",
    lines: ["Harriet K. Vance owned the mill.", "She never visited it."],
  },
  {
    name: "the pronoun I at a sentence end is not an initial",
    paragraph: "The one who stayed was I. Everyone else left.",
    lines: ["The one who stayed was I.", "Everyone else left."],
  },

  // Numbers.
  {
    name: "a decimal number never splits",
    paragraph: "The well was 1.5 metres deep. It held 3.25 litres of rain.",
    lines: ["The well was 1.5 metres deep.", "It held 3.25 litres of rain."],
  },
  {
    name: "money and times with points",
    paragraph: "It cost $4.50 at 7.30 that night. Too much.",
    lines: ["It cost $4.50 at 7.30 that night.", "Too much."],
  },
  {
    name: "a numeral at a sentence end",
    paragraph: "The count came to 12. Then the lights went out.",
    lines: ["The count came to 12.", "Then the lights went out."],
  },

  // Ellipses.
  {
    name: "an ellipsis before a lowercase word trails off mid-sentence",
    paragraph: "She waited... and waited.",
    lines: ["She waited... and waited."],
  },
  {
    name: "an ellipsis before a capital ends a sentence",
    paragraph: "I thought we had more time... Never mind.",
    lines: ["I thought we had more time...", "Never mind."],
  },
  {
    name: "a single-character ellipsis",
    paragraph: "The road went on… Then it simply stopped.",
    lines: ["The road went on…", "Then it simply stopped."],
  },
  {
    name: "a stammer across an ellipsis is one sentence",
    paragraph: '"I... I don\'t know." He looked away.',
    lines: ['"I... I don\'t know."', "He looked away."],
  },
  {
    name: "a quoted trailing ellipsis before a named tag",
    paragraph: '"Well..." Ines began. She thought better of it.',
    lines: ['"Well..." Ines began.', "She thought better of it."],
  },
  {
    name: "a quoted trailing ellipsis before narration",
    paragraph: '"If only..." She let it go.',
    lines: ['"If only..."', "She let it go."],
  },
  {
    name: "a spaced ellipsis is one mark",
    paragraph: "He counted . . . and lost count. Then he began again.",
    lines: ["He counted . . . and lost count.", "Then he began again."],
  },
  {
    name: "a spaced ellipsis before a capital ends the sentence",
    paragraph: "It was gone . . . Nothing was left.",
    lines: ["It was gone . . .", "Nothing was left."],
  },
  {
    name: "an ellipsis then a question mark",
    paragraph: "You mean...? Yes.",
    lines: ["You mean...?", "Yes."],
  },

  // Dashes and interrupted speech.
  {
    name: "an em-dash inside a sentence never splits",
    paragraph: "The house—what was left of it—stood in the rain. We went in.",
    lines: ["The house—what was left of it—stood in the rain.", "We went in."],
  },
  {
    name: "a spaced dash inside a sentence never splits",
    paragraph: "He came back — Ines never knew why — and stayed.",
    lines: ["He came back — Ines never knew why — and stayed."],
  },
  {
    name: "speech broken off with a dash, answered by another speaker",
    paragraph: '"I never meant—" "Then what did you mean?"',
    lines: ['"I never meant—"', '"Then what did you mean?"'],
  },
  {
    name: "speech broken off with a dash, then narration",
    paragraph: '"If you open that door—" The door opened.',
    lines: ['"If you open that door—"', "The door opened."],
  },
  {
    name: "speech broken off with a dash, then a named tag",
    paragraph: '"If you open that—" Ines began. Too late.',
    lines: ['"If you open that—" Ines began.', "Too late."],
  },
  {
    name: "speech broken off with a dash, then a lowercase tag",
    paragraph: '"Wait, I—" she said, but he was gone.',
    lines: ['"Wait, I—" she said, but he was gone.'],
  },
  {
    name: "a double hyphen counts as a dash",
    paragraph: '"Don\'t--" The line went dead.',
    lines: ['"Don\'t--"', "The line went dead."],
  },
  {
    name: "an unquoted trailing dash does not split",
    paragraph: "He reached for the— No, it was gone.",
    lines: ["He reached for the— No, it was gone."],
  },

  // Brackets and emphasis.
  {
    name: "a parenthetical sentence keeps its bracket",
    paragraph: "(He never came back.) She kept his chair by the fire.",
    lines: ["(He never came back.)", "She kept his chair by the fire."],
  },
  {
    name: "markdown emphasis around a sentence",
    paragraph: "*Not again.* She set the cup down. _Never again._",
    lines: ["*Not again.*", "She set the cup down.", "_Never again._"],
  },
  {
    name: "an emphasised opening word starts a sentence",
    paragraph: "The bell rang. *Twice.*",
    lines: ["The bell rang.", "*Twice.*"],
  },

  // Whitespace.
  {
    name: "hard-wrapped lines and runs of spaces are normalized",
    paragraph: "  The rain\nkept on.   It did\tnot stop\r\nfor days.  ",
    lines: ["The rain kept on.", "It did not stop for days."],
  },
  {
    name: "a no-break space holds an honorific to its name",
    paragraph: "Mr. Quill nodded. He left.",
    lines: ["Mr. Quill nodded.", "He left."],
  },
  {
    name: "a paragraph with no terminal punctuation is one line",
    paragraph: "and then the light went out",
    lines: ["and then the light went out"],
  },
  {
    name: "a sentence starting with an accented capital",
    paragraph: "They reached the coast. Émile was waiting.",
    lines: ["They reached the coast.", "Émile was waiting."],
  },
];

/** What the round-trip contract promises: whitespace runs collapsed, ends trimmed. */
function normalized(text: string): string {
  return text.replace(/[ \t\n\r\f\v]+/g, " ").trim();
}

describe("splitSentences", () => {
  for (const c of CASES) {
    test(c.name, () => {
      expect(splitSentences(c.paragraph)).toEqual([...c.lines]);
    });
  }

  test("an empty or whitespace-only paragraph has no sentences", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("  \n\t ")).toEqual([]);
  });
});

describe("joinSentences", () => {
  for (const c of CASES) {
    test(`round-trips: ${c.name}`, () => {
      expect(joinSentences(splitSentences(c.paragraph))).toBe(normalized(c.paragraph));
    });
  }

  test("joins lines with single spaces and trims stray whitespace", () => {
    expect(joinSentences(["  The tide turned. ", "", "It always does.\n"])).toBe(
      "The tide turned. It always does.",
    );
  });

  test("no lines join to an empty paragraph", () => {
    expect(joinSentences([])).toBe("");
  });

  test("splitting a joined paragraph gives the same lines back", () => {
    for (const c of CASES) {
      expect(splitSentences(joinSentences(c.lines))).toEqual([...c.lines]);
    }
  });
});
