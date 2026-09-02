import { expect, test } from "bun:test";
import { parse, type Mark, type Span } from "@openthink/pablo-core";
import {
  ACCEPT_TRAILER,
  acceptCommitMessage,
  acceptEdited,
  acceptHunk,
  hunkAt,
  markText,
  originalText,
  parseAcceptRecord,
  planRevert,
  proposedText,
  rejectHunk,
  resolveEveryMark,
  revertCommitMessage,
  reviewQueue,
} from "../src/review";

/**
 * The review decisions, without a terminal, without a model and without git.
 *
 * Every accept and reject is checked by **re-parsing the result**: a decision
 * that leaves markup the parser rejects has corrupted the manuscript however
 * plausible the string looks, and a decision that leaves a mark the author
 * already decided has not decided anything.
 */

const CHAPTER = `# Twenty-Six

The cellar was cold in a way the house never was, and {~~stayed~>kept~~} that way.

{++She counted the barrels twice.++} There were nineteen.

The lamp {--only--} guttered once. {>>check the ledger<<}
`;

function doc(text = CHAPTER) {
  return { path: "/tmp/chapter-26.md", text };
}

function queue(text = CHAPTER): readonly Mark[] {
  return reviewQueue(parse(text));
}

function spanOf(text: string, phrase: string): Span {
  const start = text.indexOf(phrase);
  return { start, end: start + phrase.length };
}

test("the queue is every pending mark, in document order (AC1)", () => {
  const marks = queue();
  expect(marks.map((mark) => mark.kind)).toEqual([
    "substitution",
    "addition",
    "deletion",
    "note",
  ]);

  // Document order means offsets that only go up, which is what makes `n` and
  // `p` a walk through the file rather than a walk through the parse tree.
  const starts = marks.map((mark) => mark.span.start);
  expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  expect(hunkAt(parse(CHAPTER), 1)?.kind).toBe("addition");
  expect(hunkAt(parse(CHAPTER), 99)).toBeUndefined();
});

test("a hunk shows its old and its new text, and says when it proposes none (AC1)", () => {
  const [substitution, addition, deletion, note] = queue() as [Mark, Mark, Mark, Mark];

  expect(originalText(CHAPTER, substitution)).toBe("stayed");
  expect(proposedText(CHAPTER, substitution)).toBe("kept");
  expect(markText(CHAPTER, substitution)).toBe("{~~stayed~>kept~~}");

  expect(proposedText(CHAPTER, addition)).toBe("She counted the barrels twice.");

  // A deletion proposes an absence and a note proposes no prose at all, so
  // there is nothing for the `edit` verb to open on either.
  expect(proposedText(CHAPTER, deletion)).toBeUndefined();
  expect(proposedText(CHAPTER, note)).toBeUndefined();
  expect(originalText(CHAPTER, note)).toBe("check the ledger");
});

test("accepting a hunk resolves that hunk and leaves the others pending (AC2)", () => {
  const marks = queue();
  const substitution = marks[0];
  expect(substitution).toBeDefined();
  if (substitution === undefined) return;

  const edit = acceptHunk(doc(), substitution);
  expect(edit.ok).toBe(true);
  if (!edit.ok) return;

  expect(edit.doc.text).toContain("and kept that way.");
  expect(edit.doc.text).not.toContain("{~~");
  // The other three are untouched — accepting a hunk decides a hunk.
  expect(reviewQueue(parse(edit.doc.text)).map((mark) => mark.kind)).toEqual([
    "addition",
    "deletion",
    "note",
  ]);
  expect(parse(edit.doc.text).violations).toEqual([]);

  // The span it reports is where the accepted text actually landed, which is
  // what the view puts the cursor on.
  expect(edit.doc.text.slice(edit.span.start, edit.span.end)).toBe("kept");
});

test("rejecting restores the original, for every kind (AC2)", () => {
  const marks = queue();
  const [substitution, addition, deletion] = marks as [Mark, Mark, Mark];

  const kept = rejectHunk(doc(), substitution);
  expect(kept.ok).toBe(true);
  if (kept.ok) expect(kept.doc.text).toContain("and stayed that way.");

  const dropped = rejectHunk(doc(), addition);
  expect(dropped.ok).toBe(true);
  if (dropped.ok) expect(dropped.doc.text).toContain("\n There were nineteen.");

  // Rejecting a deletion is keeping the words it wanted gone.
  const survived = rejectHunk(doc(), deletion);
  expect(survived.ok).toBe(true);
  if (survived.ok) expect(survived.doc.text).toContain("The lamp only guttered once.");
});

test("accepting an edited proposal writes the author's text, not the model's (AC2)", () => {
  const substitution = queue()[0];
  expect(substitution).toBeDefined();
  if (substitution === undefined) return;

  const edit = acceptEdited(doc(), substitution.span, "held");
  expect(edit.ok).toBe(true);
  if (!edit.ok) return;
  expect(edit.doc.text).toContain("and held that way.");
  expect(edit.doc.text).not.toContain("kept");
  expect(edit.doc.text.slice(edit.span.start, edit.span.end)).toBe("held");
});

test("an accepted edit must be plain prose, never markup (AC6)", () => {
  const substitution = queue()[0];
  expect(substitution).toBeDefined();
  if (substitution === undefined) return;

  // A mark typed into the field would put an *undecided* proposal into the
  // file through the accept path — the one thing review exists to prevent.
  const refused = acceptEdited(doc(), substitution.span, "{~~stayed~>lingered~~}");
  expect(refused.ok).toBe(false);
  if (refused.ok) return;
  expect(refused.reason).toContain("plain prose");
});

test("accept-all and reject-all resolve everything in one write (AC2)", () => {
  const accepted = resolveEveryMark(doc(), "accept", 0);
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;
  expect(reviewQueue(parse(accepted.doc.text))).toEqual([]);
  expect(accepted.doc.text).toContain("and kept that way.");
  expect(accepted.doc.text).toContain("She counted the barrels twice. There were nineteen.");
  expect(accepted.doc.text).toContain("The lamp  guttered once.");

  const rejected = resolveEveryMark(doc(), "reject", 0);
  expect(rejected.ok).toBe(true);
  if (!rejected.ok) return;
  expect(reviewQueue(parse(rejected.doc.text))).toEqual([]);
  expect(rejected.doc.text).toContain("and stayed that way.");
  expect(rejected.doc.text).toContain("The lamp only guttered once.");

  // A file with nothing pending is refused rather than committed as a no-op.
  expect(resolveEveryMark({ path: "/tmp/x.md", text: "plain prose\n" }, "accept", 0).ok).toBe(false);
});

test("the batch puts the cursor back where the author was, not at the top (AC2)", () => {
  const at = CHAPTER.indexOf("There were nineteen.");
  const edit = resolveEveryMark(doc(), "accept", at);
  expect(edit.ok).toBe(true);
  if (!edit.ok) return;
  expect(edit.span).toEqual({ start: at, end: at });
});

test("a decision on a mark past the end of the file is refused, not thrown (AC2)", () => {
  const substitution = queue()[0];
  expect(substitution).toBeDefined();
  if (substitution === undefined) return;

  const shrunk = doc("tiny\n");
  expect(acceptHunk(shrunk, substitution).ok).toBe(false);
  expect(rejectHunk(shrunk, substitution).ok).toBe(false);
  expect(acceptEdited(shrunk, substitution.span, "x").ok).toBe(false);
});

// ------------------------------------------------------------------- commits

test("the accept commit message names the file, the intent and the provider (AC3, AC5)", () => {
  const message = acceptCommitMessage({
    relPath: "novels/valleys-shadow/chapters/26-the-cellar.md",
    fileName: "26-the-cellar.md",
    intent: "prompt",
    provider: "local",
    model: "gemma-4-31b",
    promptHash: "3f9a1c2ed4b5a6f7",
    before: { start: 61, end: 79 },
    after: { start: 61, end: 65 },
    hunks: 1,
    edited: false,
  });

  expect(message.split("\n")[0]).toBe("pablo: accept a proposal (prompt) in 26-the-cellar.md");
  expect(message).toContain(`${ACCEPT_TRAILER}: novels/valleys-shadow/chapters/26-the-cellar.md`);
  expect(message).toContain("pablo-intent: prompt");
  expect(message).toContain("pablo-provider: local");
  expect(message).toContain("pablo-model: gemma-4-31b");
  expect(message).toContain("pablo-prompt-hash: 3f9a1c2ed4b5a6f7");
  expect(message).toContain("pablo-span-before: 61-79");
  expect(message).toContain("pablo-span-after: 61-65");
  expect(message).toContain("pablo-hunks: 1");
});

test("a run with no receipt still commits, saying so rather than inventing a hash (AC5)", () => {
  const message = acceptCommitMessage({
    relPath: "chapter.md",
    fileName: "chapter.md",
    intent: "unknown",
    provider: "unknown",
    model: "unknown",
    promptHash: undefined,
    before: { start: 0, end: 4 },
    after: { start: 0, end: 2 },
    hunks: 3,
    edited: true,
  });

  expect(message.split("\n")[0]).toBe("pablo: accept 3 proposals (unknown) in chapter.md");
  expect(message).toContain("pablo-prompt-hash: unknown");
  expect(message).toContain("pablo-hunks: 3");
  expect(message).toContain("pablo-edited: true");
  expect(message).toContain("edited by the author");
});

test("a revert commit carries no accept trailer, so the next revert walks past it (AC4)", () => {
  const message = revertCommitMessage("chapter.md", "chapter.md", "0123456789abcdef", { start: 3, end: 9 });
  expect(parseAcceptRecord(message)).toBeUndefined();
  expect(message).toContain("pablo-revert: chapter.md");
  expect(message).toContain("pablo-reverted: 0123456789abcdef");
});

test("the accept trailers round-trip out of a commit message (AC4)", () => {
  const message = acceptCommitMessage({
    relPath: "chapters/01.md",
    fileName: "01.md",
    intent: "tighten",
    provider: "local",
    model: "gemma",
    promptHash: "abc",
    before: { start: 10, end: 30 },
    after: { start: 10, end: 18 },
    hunks: 2,
    edited: false,
  });

  const record = parseAcceptRecord(message);
  expect(record).toBeDefined();
  expect(record?.relPath).toBe("chapters/01.md");
  expect(record?.before).toEqual({ start: 10, end: 30 });
  expect(record?.after).toEqual({ start: 10, end: 18 });
  expect(record?.hunks).toBe(2);

  // Anything else in the log is not an accept, including a message that only
  // talks about one.
  expect(parseAcceptRecord("chore: mention pablo-accept in the README")).toBeUndefined();
  expect(parseAcceptRecord("")).toBeUndefined();
});

// -------------------------------------------------------------------- revert

/** A `GitReader` over literal versions of the file, newest first. */
function history(versions: readonly { sha: string; message: string; text: string }[]) {
  const byRef = new Map<string, string>();
  for (const [index, version] of versions.entries()) {
    byRef.set(version.sha, version.text);
    const parent = versions[index + 1];
    if (parent !== undefined) byRef.set(`${version.sha}^`, parent.text);
  }
  return {
    log: () => versions.map((version) => ({ sha: version.sha, message: version.message })),
    show: (ref: string) => byRef.get(ref),
  };
}

const ORIGINAL = "# One\n\nThe cellar was cold.\n\nThere were nineteen.\n";
const ACCEPTED = "# One\n\nThe cellar held its cold.\n\nThere were nineteen.\n";

function acceptMessage(after: Span): string {
  return acceptCommitMessage({
    relPath: "chapter.md",
    fileName: "chapter.md",
    intent: "prompt",
    provider: "local",
    model: "gemma",
    promptHash: "abc",
    before: { start: 8, end: 40 },
    after,
    hunks: 1,
    edited: false,
  });
}

test("revert restores the paragraph from before the accept that produced it (AC4)", () => {
  const paragraph = spanOf(ACCEPTED, "The cellar held its cold.");
  const plan = planRevert(
    { path: "/tmp/chapter.md", text: ACCEPTED },
    paragraph,
    history([
      { sha: "bbbb", message: acceptMessage(spanOf(ACCEPTED, "held its cold")), text: ACCEPTED },
      { sha: "aaaa", message: "the first draft", text: ORIGINAL },
    ]),
  );

  expect(plan.ok).toBe(true);
  if (!plan.ok) return;
  expect(plan.restored).toBe("The cellar was cold.");
  expect(plan.sha).toBe("bbbb");
  expect(plan.doc.text).toBe(ORIGINAL);
});

test("revert takes the most recent accept on this paragraph, not the newest commit (AC4)", () => {
  // Two accepts, on two different paragraphs. Reverting the first paragraph
  // must find the accept that changed *it*, and walk straight past the newer
  // one that changed something else.
  const both = "# One\n\nThe cellar held its cold.\n\nThere were twenty.\n";
  const paragraph = spanOf(both, "The cellar held its cold.");

  const plan = planRevert(
    { path: "/tmp/chapter.md", text: both },
    paragraph,
    history([
      { sha: "cccc", message: acceptMessage(spanOf(both, "twenty")), text: both },
      { sha: "bbbb", message: acceptMessage(spanOf(ACCEPTED, "held its cold")), text: ACCEPTED },
      { sha: "aaaa", message: "the first draft", text: ORIGINAL },
    ]),
  );

  expect(plan.ok).toBe(true);
  if (!plan.ok) return;
  expect(plan.sha).toBe("bbbb");
  expect(plan.restored).toBe("The cellar was cold.");
  expect(plan.doc.text).toContain("There were twenty.");
});

test("revert refuses rather than guessing (AC4)", () => {
  // Nothing accepted at all.
  const nothing = planRevert(
    { path: "/tmp/chapter.md", text: ORIGINAL },
    spanOf(ORIGINAL, "The cellar was cold."),
    history([{ sha: "aaaa", message: "the first draft", text: ORIGINAL }]),
  );
  expect(nothing.ok).toBe(false);
  if (!nothing.ok) expect(nothing.reason).toContain("nothing has been accepted");

  // Accepted, but on some other paragraph.
  const elsewhere = planRevert(
    { path: "/tmp/chapter.md", text: ACCEPTED },
    spanOf(ACCEPTED, "There were nineteen."),
    history([
      { sha: "bbbb", message: acceptMessage(spanOf(ACCEPTED, "held its cold")), text: ACCEPTED },
      { sha: "aaaa", message: "the first draft", text: ORIGINAL },
    ]),
  );
  expect(elsewhere.ok).toBe(false);

  // The accept added a paragraph, so "which block was this one" has no honest
  // answer and the manuscript is left alone.
  const grew = "# One\n\nThe cellar was cold.\n\nA new one.\n\nThere were nineteen.\n";
  const added = planRevert(
    { path: "/tmp/chapter.md", text: grew },
    spanOf(grew, "A new one."),
    history([
      { sha: "bbbb", message: acceptMessage(spanOf(grew, "A new one.")), text: grew },
      { sha: "aaaa", message: "the first draft", text: ORIGINAL },
    ]),
  );
  expect(added.ok).toBe(false);
  if (!added.ok) expect(added.reason).toContain("added or removed a paragraph");
});
