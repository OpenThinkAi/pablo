import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { parse, type Mark, type Receipt } from "@openthink/pablo-core";
import { git } from "../src/git";
import { ACCEPT_TRAILER, parseAcceptRecord } from "../src/review";
import { openView, type ViewHandle } from "../src/view";

/**
 * The proposal queue end to end (AGT-1205): the real renderer, the real
 * filesystem, and a **real git repository created by this test in a temp
 * directory**. Nothing here goes near `~/writing`, nothing spawns `think`, and
 * nothing calls a model — the marks are written into the fixture, because the
 * point of review is what happens to a mark that is already in the file.
 *
 * The repository is given its own `user.name`, `user.email` and
 * `commit.gpgsign=false` as *local* config, which overrides whatever the
 * machine's global config says: a test must not sign with the author's key, and
 * must not fail on a machine that requires signing.
 */

const directories: string[] = [];
const open: ViewHandle[] = [];
const renderers: TestRendererSetup[] = [];

afterEach(async () => {
  const closing = open.map((handle) => {
    handle.stop();
    return handle.closed;
  });
  open.length = 0;
  await Promise.all(closing);
  while (renderers.length > 0) renderers.pop()?.renderer.destroy();
  while (directories.length > 0) rmSync(directories.pop() ?? "", { recursive: true, force: true });
});

const ORIGINAL = "The cellar was cold in a way the house never was,";
const CHAPTER = `# Twenty-Six

The cellar was cold in a way the house never was, and {~~stayed~>kept~~} that way.

{++She counted the barrels twice.++} There were nineteen.

The lamp guttered once and held.
`;

interface Workspace {
  readonly root: string;
  readonly path: string;
  text(): string;
  log(): string;
  lastMessage(): string;
  lastFiles(): string[];
  status(): string;
}

/** A writing vault in a temp directory, which is also a git repository. */
function workspace(text = CHAPTER, options: { repo?: boolean } = {}): Workspace {
  const root = mkdtempSync(join(tmpdir(), "pablo-review-"));
  directories.push(root);
  mkdirSync(join(root, "style"), { recursive: true });
  writeFileSync(join(root, "style", "prose.md"), "Straight quotes, never curly.\n", "utf8");

  const work = join(root, "novels", "valleys-shadow");
  mkdirSync(join(work, "chapters"), { recursive: true });
  writeFileSync(join(work, "QWEN.md"), "# The Valley's Shadow\n", "utf8");

  const path = join(work, "chapters", "26-the-cellar.md");
  writeFileSync(path, text, "utf8");

  if (options.repo !== false) {
    expect(git(["init", "-b", "main", root]).ok).toBe(true);
    // Local config only: never the machine's identity, never its signing key.
    git(["-C", root, "config", "user.name", "pablo test"]);
    git(["-C", root, "config", "user.email", "pablo@example.invalid"]);
    git(["-C", root, "config", "commit.gpgsign", "false"]);
    git(["-C", root, "config", "core.hooksPath", join(root, ".git", "no-hooks")]);
    expect(git(["-C", root, "add", "-A"]).ok).toBe(true);
    expect(git(["-C", root, "commit", "--quiet", "-m", "the first draft"]).ok).toBe(true);
  }

  return {
    root,
    path,
    text: () => readFileSync(path, "utf8"),
    log: () => git(["-C", root, "log", "--format=%H %s"]).stdout,
    lastMessage: () => git(["-C", root, "log", "-1", "--format=%B"]).stdout,
    lastFiles: () =>
      git(["-C", root, "show", "--name-only", "--format=", "HEAD"])
        .stdout.split("\n")
        .map((row) => row.trim())
        .filter((row) => row.length > 0),
    status: () => git(["-C", root, "status", "--porcelain"]).stdout,
  };
}

async function view(space: Workspace, size = { width: 100, height: 20 }): Promise<[ViewHandle, TestRendererSetup]> {
  const setup = await createTestRenderer(size);
  renderers.push(setup);
  const handle = await openView(space.path, {
    renderer: setup.renderer,
    watch: false,
    // No model, no `think`, no config read: this suite is about marks that are
    // already in the file.
    brief: false,
  });
  open.push(handle);
  await setup.renderOnce();
  return [handle, setup];
}

/** One receipt in the vault's log, so a hunk under review has something to show. */
function logReceipt(space: Workspace, receipt: Partial<Receipt>): void {
  const dir = join(space.root, ".pablo");
  mkdirSync(dir, { recursive: true });
  const full: Receipt = {
    at: "2026-09-02T04:00:00.000Z",
    intent: "tighten",
    pack_kind: "spanEdit",
    prompt_hash: "3f9a1c2ed4b5a6f70011223344556677",
    slices: [],
    provider: "local",
    model: "gemma-4-31b",
    params: { max_tokens: 900 },
    tokens_read: 4900,
    tokens_written: 1500,
    ttft_ms: 19_000,
    gen_tok_s: 30,
    wall_ms: 69_000,
    measurement: "stream",
    proposal: null,
    error: null,
    ...receipt,
  };
  appendFileSync(join(dir, "receipts.jsonl"), `${JSON.stringify(full)}\n`, "utf8");
}

// --------------------------------------------------------------------- AC1

test("`v` opens the queue, lists the pending marks and jumps between them (AC1)", async () => {
  const space = workspace();
  const [handle, setup] = await view(space);

  setup.mockInput.pressKey("v");
  await setup.renderOnce();

  expect(handle.state().review.open).toBe(true);
  expect(handle.state().review.index).toBe(0);

  const frame = handle.frame();
  expect(frame).toContain("review — proposal 1 of 2");
  expect(frame).toContain("substitution");
  // Old against new, both quoted.
  expect(frame).toContain("stayed");
  expect(frame).toContain("kept");
  // The queue position is in the status line too.
  expect(frame).toContain("proposal 1 of 2");

  // The cursor is on the mark, not wherever it happened to be.
  const marks = parse(space.text()).marks;
  const [first, second] = marks as [Mark, Mark];
  expect(handle.state().selection.span).toEqual(first.span);

  setup.mockInput.pressKey("n");
  await setup.renderOnce();
  expect(handle.state().review.index).toBe(1);
  expect(handle.frame()).toContain("review — proposal 2 of 2");
  expect(handle.frame()).toContain("addition");
  expect(handle.state().selection.span).toEqual(second.span);

  // The ends of the queue hold rather than wrap into nothing.
  setup.mockInput.pressKey("n");
  await setup.renderOnce();
  expect(handle.state().review.index).toBe(1);

  setup.mockInput.pressKey("p");
  await setup.renderOnce();
  expect(handle.state().review.index).toBe(0);

  setup.mockInput.pressKey("v");
  await setup.renderOnce();
  expect(handle.state().review.open).toBe(false);
});

test("a file with no proposals says so instead of opening an empty queue (AC1)", async () => {
  const space = workspace("# One\n\nPlain prose, no marks.\n");
  const [handle, setup] = await view(space);

  setup.mockInput.pressKey("v");
  await setup.renderOnce();

  expect(handle.state().review.open).toBe(false);
  expect(handle.state().message).toContain("no pending proposals");
});

test("the review keys outside review say how to get in, and change nothing (AC1)", async () => {
  const space = workspace();
  const [handle, setup] = await view(space);

  for (const key of ["y", "k", "c"]) {
    setup.mockInput.pressKey(key);
    await setup.renderOnce();
    expect(handle.state().message).toContain("press v");
  }
  expect(space.text()).toBe(CHAPTER);
});

// --------------------------------------------------------------- AC2 and AC3

test("`y` accepts, writes, re-renders from disk and commits the one file (AC2, AC3)", async () => {
  const space = workspace();
  const [handle, setup] = await view(space);

  setup.mockInput.pressKey("v");
  setup.mockInput.pressKey("y");
  await setup.renderOnce();

  // Written, and the view is showing the file as it now is on disk.
  expect(space.text()).toContain("and kept that way.");
  expect(space.text()).not.toContain("{~~");
  expect(handle.state().doc.text).toBe(space.text());
  expect(parse(space.text()).violations).toEqual([]);

  // The queue advanced onto the one proposal that is left.
  expect(handle.state().review.open).toBe(true);
  expect(handle.frame()).toContain("review — proposal 1 of 1");

  // Committed, with everything AC3 asks the message to name.
  const message = space.lastMessage();
  expect(message).toContain("pablo: accept a proposal");
  expect(message).toContain("26-the-cellar.md");
  expect(message).toContain(`${ACCEPT_TRAILER}: novels/valleys-shadow/chapters/26-the-cellar.md`);
  expect(parseAcceptRecord(message)).toBeDefined();
  expect(space.lastFiles()).toEqual(["novels/valleys-shadow/chapters/26-the-cellar.md"]);
  expect(space.status()).toBe("");
});

test("one commit per accepted hunk (AC3)", async () => {
  const space = workspace();
  const [, setup] = await view(space);
  const before = space.log().split("\n").filter((row) => row.trim() !== "").length;

  setup.mockInput.pressKey("v");
  setup.mockInput.pressKey("y");
  await setup.renderOnce();
  setup.mockInput.pressKey("y");
  await setup.renderOnce();

  const after = space.log().split("\n").filter((row) => row.trim() !== "").length;
  expect(after - before).toBe(2);
  expect(space.text()).not.toContain("{++");
});

test("an accept never commits an unrelated dirty file, even a staged one (AC3)", async () => {
  const space = workspace();
  const stray = join(space.root, "novels", "valleys-shadow", "chapters", "27-the-press.md");
  writeFileSync(stray, "# Twenty-Seven\n\nUnfinished.\n", "utf8");
  git(["-C", space.root, "add", "--", stray]);

  const [, setup] = await view(space);
  setup.mockInput.pressKey("v");
  setup.mockInput.pressKey("y");
  await setup.renderOnce();

  expect(space.lastFiles()).toEqual(["novels/valleys-shadow/chapters/26-the-cellar.md"]);
  // Still staged, still uncommitted: pablo committed a path, not a state.
  expect(space.status()).toContain("27-the-press.md");
});

test("`k` rejects: the original stands, and nothing is committed (AC2, AC3)", async () => {
  const space = workspace();
  const [handle, setup] = await view(space);
  const before = space.log();

  setup.mockInput.pressKey("v");
  setup.mockInput.pressKey("k");
  await setup.renderOnce();

  expect(space.text()).toContain("and stayed that way.");
  expect(space.text()).not.toContain("kept");
  expect(handle.state().doc.text).toBe(space.text());
  // A rejection restores the author's own text, and the author's own edits are
  // theirs to commit — AC3 asks for a commit on accept.
  expect(space.log()).toBe(before);
});

test("`c` opens the proposal, and ctrl+s accepts what the author typed (AC2)", async () => {
  const space = workspace();
  const [handle, setup] = await view(space);

  setup.mockInput.pressKey("v");
  setup.mockInput.pressKey("c");
  await setup.renderOnce();

  expect(handle.state().field?.kind).toBe("proposal");
  expect(handle.state().field?.value).toBe("kept");
  expect(handle.frame()).toContain("edit the proposal");
  // Review is still open behind the field: the field *is* the review surface.
  expect(handle.state().review.open).toBe(true);

  for (let step = 0; step < "kept".length; step += 1) setup.mockInput.pressBackspace();
  await setup.mockInput.typeText("held");
  setup.mockInput.pressKey("s", { ctrl: true });
  await setup.renderOnce();

  expect(space.text()).toContain("and held that way.");
  expect(space.text()).not.toContain("kept");
  expect(space.text()).not.toContain("{~~");
  expect(handle.state().field).toBeUndefined();
  expect(space.lastMessage()).toContain("pablo-edited: true");
});

test("esc in the proposal field leaves the mark pending (AC2)", async () => {
  const space = workspace();
  const [handle, setup] = await view(space);

  setup.mockInput.pressKey("v");
  setup.mockInput.pressKey("c");
  await setup.mockInput.typeText("xyz");
  setup.mockInput.pressEscape();
  await setup.renderOnce();
  await Bun.sleep(20);

  expect(space.text()).toBe(CHAPTER);
  expect(handle.state().pendingProposal).toBeUndefined();
});

test("`c` on a hunk that proposes no text says so rather than opening an empty field (AC2)", async () => {
  const space = workspace("# One\n\nThe lamp {--only--} guttered. {>>check the ledger<<}\n");
  const [handle, setup] = await view(space);

  setup.mockInput.pressKey("v");
  setup.mockInput.pressKey("c");
  await setup.renderOnce();

  expect(handle.state().field).toBeUndefined();
  expect(handle.state().message).toContain("accept or reject");
});

test("`Y` accepts every proposal in one write and one commit (AC2, AC3)", async () => {
  const space = workspace();
  const [handle, setup] = await view(space);
  const before = space.log().split("\n").filter((row) => row.trim() !== "").length;

  setup.mockInput.pressKey("v");
  setup.mockInput.pressKey("Y");
  await setup.renderOnce();

  expect(parse(space.text()).marks).toEqual([]);
  expect(space.text()).toContain("and kept that way.");
  expect(space.text()).toContain("She counted the barrels twice. There were nineteen.");

  const after = space.log().split("\n").filter((row) => row.trim() !== "").length;
  expect(after - before).toBe(1);
  expect(space.lastMessage()).toContain("pablo: accept 2 proposals");
  expect(space.lastMessage()).toContain("pablo-hunks: 2");

  // Nothing is left to review, so the pane closed rather than lying about it.
  expect(handle.state().review.open).toBe(false);
  expect(handle.state().message).toContain("no proposals left");
});

test("`K` rejects every proposal in one write, and commits none (AC2)", async () => {
  const space = workspace();
  const [, setup] = await view(space);
  const before = space.log();

  setup.mockInput.pressKey("v");
  setup.mockInput.pressKey("K");
  await setup.renderOnce();

  expect(parse(space.text()).marks).toEqual([]);
  expect(space.text()).toContain(`${ORIGINAL} and stayed that way.`);
  expect(space.text()).toContain("There were nineteen.");
  expect(space.log()).toBe(before);
});

test("a vault that is not a git repository still applies, and says why not (AC3)", async () => {
  const space = workspace(CHAPTER, { repo: false });
  const [handle, setup] = await view(space);

  setup.mockInput.pressKey("v");
  setup.mockInput.pressKey("y");
  await setup.renderOnce();

  // The write is what matters and it happened; git is a notice on top of it.
  expect(space.text()).toContain("and kept that way.");
  expect(handle.state().message).toContain("not a git repository");
});

// --------------------------------------------------------------------- AC5

test("a hunk under review shows the receipt of the run that produced it (AC5)", async () => {
  const space = workspace();
  const mark = parse(CHAPTER).marks[0];
  expect(mark).toBeDefined();
  if (mark === undefined) return;

  logReceipt(space, {
    proposal: { path: space.path, start: mark.span.start, end: mark.span.end, variants: 1 },
  });

  const [handle, setup] = await view(space);
  setup.mockInput.pressKey("v");
  await setup.renderOnce();

  const frame = handle.frame();
  expect(frame).toContain("tighten");
  expect(frame).toContain("local");
  expect(frame).toContain("gemma-4-31b");
  expect(frame).toContain("prompt 3f9a1c2e");
  expect(frame).toContain("read 4,900");
  expect(frame).toContain("wrote 1,500");

  // And the hash goes into the commit the accept makes.
  setup.mockInput.pressKey("y");
  await setup.renderOnce();
  expect(space.lastMessage()).toContain("pablo-prompt-hash: 3f9a1c2ed4b5a6f70011223344556677");
  expect(space.lastMessage()).toContain("pablo-intent: tighten");
  expect(space.lastMessage()).toContain("pablo-provider: local");
});

test("no receipt log is 'no receipt', not an error or a zero (AC5)", async () => {
  const space = workspace();
  const [handle, setup] = await view(space);

  setup.mockInput.pressKey("v");
  await setup.renderOnce();

  expect(handle.frame()).toContain("no receipt for this proposal");

  setup.mockInput.pressKey("y");
  await setup.renderOnce();
  expect(space.lastMessage()).toContain("pablo-prompt-hash: unknown");
});

// --------------------------------------------------------------------- AC4

test("`u` reverts a paragraph to before the most recent accept on it (AC4)", async () => {
  const space = workspace();
  const [handle, setup] = await view(space);

  // Two accepts on the same paragraph: the substitution, then a second
  // proposal written into the same sentence and accepted.
  setup.mockInput.pressKey("v");
  setup.mockInput.pressKey("y");
  await setup.renderOnce();
  expect(space.text()).toContain("and kept that way.");

  writeFileSync(
    space.path,
    space.text().replace("and kept that way.", "and {~~kept~>held~~} that way."),
    "utf8",
  );
  handle.reload();
  // Review is still open on the hunk after the one just accepted, so `v` closes
  // it and a second `v` reopens the refreshed queue at its first hunk.
  setup.mockInput.pressKey("v");
  setup.mockInput.pressKey("v");
  setup.mockInput.pressKey("y");
  await setup.renderOnce();
  expect(space.text()).toContain("and held that way.");

  // Leave review — which hands the paragraph granularity back, so `n` walks
  // paragraphs again rather than the queue — and put the cursor on the one that
  // was accepted into twice.
  setup.mockInput.pressKey("v");
  setup.mockInput.pressKey("g");
  setup.mockInput.pressKey("n");
  await setup.renderOnce();
  expect(handle.state().selection.granularity).toBe("paragraph");
  const selected = handle.state();
  expect(selected.doc.text.slice(selected.selection.span.start, selected.selection.span.end)).toContain(
    "The cellar was cold",
  );

  setup.mockInput.pressKey("u");
  await setup.renderOnce();
  expect(space.text()).toContain("and kept that way.");
  expect(space.lastMessage()).toContain("pablo: revert a paragraph");
  // The revert is itself a commit, and carries no accept trailer.
  expect(parseAcceptRecord(space.lastMessage())).toBeUndefined();

  // A second `u` walks past the revert (which carries no accept trailer) to the
  // first accept, and restores the paragraph as it was *before* that one ran —
  // which means the proposal itself comes back, pending, into the queue. That
  // is what "before the intent ran" means, and it is the useful answer: the
  // author gets the decision back, not just the words.
  setup.mockInput.pressKey("u");
  await setup.renderOnce();
  expect(space.text()).toContain("and {~~stayed~>kept~~} that way.");
  expect(parse(space.text()).marks).toHaveLength(2);
});

test("`u` on a paragraph nothing was accepted on refuses and changes nothing (AC4)", async () => {
  const space = workspace();
  const [handle, setup] = await view(space);

  setup.mockInput.pressKey("u");
  await setup.renderOnce();

  expect(space.text()).toBe(CHAPTER);
  expect(handle.state().message).toContain("nothing has been accepted");
});
