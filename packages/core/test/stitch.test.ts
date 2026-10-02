import { expect, test } from "bun:test";
import { detectMoves, markWords, parseDiff, stitch, tokenize, type Edit, type FileDiff, type Seg, type Stitcher } from "../src/index";

// Invented fixtures throughout. A hunk is written as its lines with their sign; `diff` adds git's headers and counts.
type H = { o: number; n: number; lines: string[] };
function diff(...files: { path: string; hunks: H[] }[]): FileDiff[] {
  const text = files.map(({ path, hunks }) => {
    const body = hunks.map(({ o, n, lines }) => {
      const old = lines.filter((l) => l[0] !== "+").length, neu = lines.filter((l) => l[0] !== "-").length;
      return [`@@ -${o},${old} +${n},${neu} @@`, ...lines].join("\n");
    });
    return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...body].join("\n");
  });
  return parseDiff(`${text.join("\n")}\n`);
}
const one = (lines: string[], o = 1, n = o) => diff({ path: "ch.md", hunks: [{ o, n, lines }] });

/** A row as text: its sign, then the line with marked stretches in [brackets]. */
const marked = (segs: readonly Seg[]) => segs.map((s) => (s.hl ? `[${s.text}]` : s.text)).join("");
const show = (e: Edit) => e.rows.map((r) => `${r.sign}${marked(r.segs)}`);
const shape = (e: Edit) => ({ kind: e.kind, line: e.line, rows: show(e) });

test("tokenize: words keep inner apostrophes, punctuation stands alone, and the tokens join back to the line", () => {
  expect(tokenize(`"Don't," Mr. O’Hare said — twice...`)).toEqual(
    ['"', "Don't", ",", '"', " ", "Mr", ".", " ", "O’Hare", " ", "said", " ", "—", " ", "twice", ".", ".", "."],
  );
  for (const line of ["", "   ", "She left.", "\t«Oui», dit-elle.", "Café au lait, 3 cups!"]) expect(tokenize(line).join("")).toBe(line);
});

// markWords: one removed and one added sentence, as `[marked]` text.
const words: [string, string, string, string, string][] = [
  ["a one-word fix marks the word", "Mara opened the gate.", "Mara closed the gate.", "Mara [opened] the gate.", "Mara [closed] the gate."],
  ["a changed phrase is one stretch, spaces inside it marked", "She did not look up.", "She never looked up.", "She [did not look] up.", "She [never looked] up."],
  ["only the punctuation", "He was gone.", "He was gone?", "He was gone[.]", "He was gone[?]"],
  ["a word added", "The road was empty.", "The long road was empty.", "The road was empty.", "The [long] road was empty."],
  ["a word taken out", "It was very cold.", "It was cold.", "It was [very] cold.", "It was cold."],
  ["a lone short word between changes is folded in", "Anna sold the car to Ben on Monday.", "Anna gave the keys to Ben on Monday.", "Anna [sold the car] to Ben on Monday.", "Anna [gave the keys] to Ben on Monday."],
  ["a sentence mostly new is shown whole", "The cat sat on the mat.", "A storm rolled over the hills at dusk.", "The cat sat on the mat.", "A storm rolled over the hills at dusk."],
  ["dialogue: the quoted words, not the quotes", `"Go home," she said.`, `"Stay here," she said.`, `"[Go home]," she said.`, `"[Stay here]," she said.`],
  ["case counts", "the end.", "The end.", "[the] end.", "[The] end."],
];
for (const [name, from, to, wantFrom, wantTo] of words)
  test(`markWords: ${name}`, () => {
    const { removed, added } = markWords([from], [to]);
    expect([marked(removed[0]!), marked(added[0]!)]).toEqual([wantFrom, wantTo]);
    expect([removed[0]!.map((s) => s.text).join(""), added[0]!.map((s) => s.text).join("")]).toEqual([from, to]);
  });

test("markWords: words are matched across the sentences of an edit; a new sentence in it stays plain", () => {
  const { removed, added } = markWords(
    ["She did not look up.", "Edwin sat at the table."],
    ["She never looked up.", "Nobody sat at the table.", "The kettle ticked."],
  );
  expect(removed.map(marked)).toEqual(["She [did not look] up.", "[Edwin] sat at the table."]);
  expect(added.map(marked)).toEqual(["She [never looked] up.", "[Nobody] sat at the table.", "The kettle ticked."]);
});

test("markWords: a blank line is no segments; an edit too large to diff is shown whole", () => {
  expect(markWords([""], ["Now."]).removed).toEqual([[]]);
  const big = Array.from({ length: 600 }, (_, i) => `w${i}`).join(" ");
  const { removed, added } = markWords([big], [`${big} more`]);
  expect([removed[0], added[0]]).toEqual([[{ text: big, hl: false }], [{ text: `${big} more`, hl: false }]]);
});

// stitch: a diff in, the edits as { kind, line, rows }.
const cases: [string, FileDiff[], ReturnType<typeof shape>[]][] = [
  [
    "adjacent changed sentences are one edit, with a line of context either side",
    one([" The well had been dry since June.", "-She did not look up.", "-Edwin sat at the table.", "+She never looked up.", "+Nobody sat at the table.", "+The kettle ticked.", " ", " The road was empty."]),
    [{ kind: "change", line: 2, rows: [" The well had been dry since June.", "-She [did not look] up.", "-[Edwin] sat at the table.", "+She [never looked] up.", "+[Nobody] sat at the table.", "+The kettle ticked.", " "] }],
  ],
  [
    "changes either side of an unchanged sentence are two edits",
    one(["-It was cold.", "+It was bitterly cold.", " Nobody spoke.", "-The fire died.", "+The fire went out."]),
    [
      { kind: "change", line: 1, rows: ["-It was cold.", "+It was [bitterly] cold.", " Nobody spoke."] },
      { kind: "change", line: 3, rows: [" Nobody spoke.", "-The fire [died].", "+The fire [went out]."] },
    ],
  ],
  [
    "a sentence added, plain, at its new line",
    one([" One.", "+Two.", " Three."], 4),
    [{ kind: "add", line: 5, rows: [" One.", "+Two.", " Three."] }],
  ],
  [
    "a sentence taken out, at the line it leaves behind",
    one([" One.", "-Two.", " Three."], 4),
    [{ kind: "remove", line: 5, rows: [" One.", "-Two.", " Three."] }],
  ],
  [
    "a removal at the very top sits at the hunk's first line",
    one(["-Gone.", " Kept."]),
    [{ kind: "remove", line: 1, rows: ["-Gone.", " Kept."] }],
  ],
  [
    "a paragraph split is a paragraph break added",
    one([" She waited.", "+", " Then the bell rang."]),
    [{ kind: "add", line: 2, rows: [" She waited.", "+", " Then the bell rang."] }],
  ],
  [
    "a paragraph moved unchanged is one move; the blank lines it leaves and brings are the move's",
    one(["+The harbor was quiet.", "+Gulls wheeled overhead.", "+", " Morning came late.", " It brought rain.", "-", "-The harbor was quiet.", "-Gulls wheeled overhead."]),
    [{ kind: "move", line: 1, rows: ["~The harbor was quiet.", "~Gulls wheeled overhead."] }],
  ],
  [
    "a paragraph moved and touched on the way is a move with its changed sentence marked",
    one([
      "+The harbor was quiet that night.",
      "+Gulls wheeled over the empty boats.",
      "+",
      " Morning came late.",
      " It brought rain.",
      "-",
      "-The harbor was quiet.",
      "-Gulls wheeled over the empty boats.",
    ]),
    [{ kind: "move", line: 1, rows: ["-The harbor was quiet.", "+The harbor was quiet [that night].", "~Gulls wheeled over the empty boats."] }],
  ],
  [
    "a sentence rewritten in place is a change, not a move, however alike",
    one([" Before.", "-The harbor was quiet that night.", "+The harbor was quiet that morning.", " After."]),
    [{ kind: "change", line: 2, rows: [" Before.", "-The harbor was quiet that [night].", "+The harbor was quiet that [morning].", " After."] }],
  ],
  [
    "a short paragraph alike to another is not taken for a move",
    one(["-Yes, she said.", " Middle.", " Middle two.", "+No, she said."]),
    [
      { kind: "remove", line: 1, rows: ["-Yes, she said.", " Middle."] },
      { kind: "add", line: 3, rows: [" Middle two.", "+No, she said."] },
    ],
  ],
  [
    "a change beside a move stays its own edit",
    one(["-Old opening line here.", "+New opening line here.", "+", "+Para to move a.", "+Para to move b.", " ", " Middle.", "-", "-Para to move a.", "-Para to move b."]),
    [
      { kind: "change", line: 1, rows: ["-[Old] opening line here.", "+[New] opening line here."] },
      { kind: "move", line: 3, rows: ["~Para to move a.", "~Para to move b."] },
    ],
  ],
];
for (const [name, files, want] of cases) test(`stitch: ${name}`, () => expect(stitch(files).map(shape)).toEqual(want));

test("stitch: a move across files sits where the paragraph arrived and says where it came from", () => {
  const files = diff(
    { path: "ch01.md", hunks: [{ o: 1, n: 1, lines: [" The lamp flickered.", " ", "-The harbor was quiet.", "-Gulls wheeled overhead.", "-", " Morning came late."] }] },
    { path: "ch02.md", hunks: [{ o: 4, n: 4, lines: [" Dusk fell.", "+", "+The harbor was quiet.", "+Gulls wheeled overhead.", " Doors closed."] }] },
  );
  const [move, ...rest] = stitch(files);
  expect(rest).toEqual([]);
  expect(move).toMatchObject({ id: "edit:0", path: "ch02.md", kind: "move", line: 6, from: { path: "ch01.md", line: 3 }, added: 0, removed: 0 });
  expect(move!.removedLines).toEqual([3, 4, 5].map((line) => ({ path: "ch01.md", line })));
  expect(move!.addedLines).toEqual([5, 6, 7].map((line) => ({ path: "ch02.md", line })));
});

test("stitch: moves default to core's detectMoves; passing none still finds a paragraph moved whole", () => {
  const files = one(["-Para one a is here.", "-Para one b is here.", " ", " Mid.", " ", "+Para one a is here.", "+Para one b is here."]);
  expect(detectMoves(files)).toHaveLength(1);
  expect(stitch(files).map((e) => e.kind)).toEqual(["move"]);
  expect(stitch(files, []).map(shape)).toEqual(stitch(files).map(shape));
});

test("stitch: a binary file is one change with a notice and no lines of its own", () => {
  const files = parseDiff("diff --git a/cover.png b/cover.png\nBinary files a/cover.png and b/cover.png differ\n");
  expect(stitch(files).map((e) => [e.kind, show(e), e.removedLines, e.addedLines])).toEqual([["change", [" (binary file changed)"], [], []]]);
});

test("stitch: ids run in diff order across files and hunks", () => {
  const files = diff(
    { path: "a.md", hunks: [{ o: 1, n: 1, lines: ["-A.", "+A!"] }, { o: 20, n: 20, lines: [" x.", "+Y."] }] },
    { path: "b.md", hunks: [{ o: 3, n: 3, lines: ["-Z."] }] },
  );
  expect(stitch(files).map((e) => [e.id, e.path, e.kind, e.line])).toEqual([["edit:0", "a.md", "change", 1], ["edit:1", "a.md", "add", 21], ["edit:2", "b.md", "remove", 3]]);
});

// Every changed line of a diff is owned by exactly one edit: accept/reject (AGT-1539) acts on these lists.
const allFixtures: FileDiff[][] = [...cases.map(([, f]) => f)];
test("stitch: every changed line belongs to exactly one edit, and every row's text joins back to a diff line", () => {
  for (const files of allFixtures) {
    const want: string[] = [], texts = new Set<string>();
    for (const f of files)
      for (const h of f.hunks)
        for (const l of h.lines) {
          texts.add(l.text);
          if (l.t === "-") want.push(`-${f.path}:${l.o}`);
          if (l.t === "+") want.push(`+${f.path}:${l.n}`);
        }
    const edits = stitch(files);
    const got = edits.flatMap((e) => [...e.removedLines.map((r) => `-${r.path}:${r.line}`), ...e.addedLines.map((r) => `+${r.path}:${r.line}`)]);
    expect(got.slice().sort()).toEqual(want.slice().sort());
    expect(new Set(got).size).toBe(got.length);
    for (const e of edits) for (const r of e.rows) expect(texts.has(r.segs.map((s) => s.text).join(""))).toBe(true);
  }
});

test("stitch fits the Stitcher interface a later, learned grouping will share", () => {
  const s: Stitcher = (files) => stitch(files);
  expect(s([])).toEqual([]);
});
