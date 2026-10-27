import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commitAs, createBranch, worktreePath } from "../src/branch";
import { revisionsForPane, screenEditPane } from "../src/edit-session";
import { apply, openText, saveText, type EditText } from "../../tui/src/edit-pane";
import { acceptHunk, currentHunk, pendingCount, rejectHunk, shownHunks, stepHunk, withRevisions } from "../../tui/src/inline-diff";

/**
 * AGT-2177: a pending `revise/` branch shows inline in the editing pane, each edit accepted or rejected on its own;
 * accepted edits reach the work's `edit/` branch through the pane's save path, and rejecting every edit leaves the edit
 * branch as it was. Fixture revise branches in a temp git copy of the fixture vault: no model is called.
 */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");

const dirs: string[] = [];
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true }); });

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString("utf8")}`);
  return r.stdout.toString("utf8").trim();
}

const CH1 = "chapters/01-the-last-full-cut.md";
const HEAD = ["---", "chapter: 1", "title: The Last Full Cut", "words: 60", "model: base-model", "---", ""];
const BASE = [...HEAD, "The pond rang under the horse.", "Odile heard it from the doorway.", "She wrote the time in the green book.", "", "The cutters came at noon.", "They brought the long saws.", ""].join("\n");
/** The model's revise: two edits in the first paragraph (one unchanged sentence between), one in the second. */
const REVISED = [...HEAD, "The pond boomed under the horse.", "Odile heard it from the doorway.", "She wrote the hour in the green ledger.", "", "The cutters came at noon.", "They brought the long saws and a sledge.", ""].join("\n");

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pablo-inline-"));
  dirs.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const project = join(vault, "novels", "ice-house");
  writeFileSync(join(project, CH1), BASE);
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "matt@example.com");
  git(vault, "config", "user.name", "Matt Test");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  const env = { PATH: NO_THINK_PATH, XDG_STATE_HOME: join(dir, "state"), XDG_CONFIG_HOME: join(dir, "config"), PABLO_HOME: join(dir, "home") };
  // The revise branch, as `a r` leaves one: a commit on `revise/<id>` changing the chapter.
  const made = createBranch(vault, "ice-house", "revise/r1", env);
  if (!made.ok) throw new Error(made.notice);
  const wt = worktreePath("ice-house", "revise/r1", env);
  writeFileSync(join(wt, "novels", "ice-house", CH1), REVISED);
  const c = commitAs(wt, { message: "revise", author: { name: "pablo", email: "pablo@localhost" } });
  if (!c.ok) throw new Error(c.notice);
  const session = screenEditPane(project, { env, shortId: () => "ab12cd" });
  const opened = await session.open(CH1);
  if (!opened.ok) throw new Error(opened.message);
  const revs = await session.revisions(CH1);
  const pane = withRevisions(openText(opened.text, "sentences", 1), revs);
  return { vault, project, env, session, pane, revs };
}

const fileOf = (t: EditText) => saveText(t.raw, t.buffer.text(), t.storage);
const onEdit = (vault: string) => git(vault, "show", `edit/ab12cd:novels/ice-house/${CH1}`) + "\n";

test("the unit's pending revise branch comes over as its diff, each edit shown inline under its paragraph", async () => {
  const { pane, revs, project } = await setup();
  expect(revs.map((r) => r.branch)).toEqual(["revise/r1"]);
  const shown = shownHunks(pane);
  expect(shown).toHaveLength(3);
  expect(shown.map((s) => [s.row, s.matches])).toEqual([[0, true], [0, true], [2, true]]);
  // Word-level: only the words that differ are marked.
  const first = shown[0]!.hunk.edit.rows.filter((r) => r.sign !== " ");
  expect(first.map((r) => [r.sign, r.segs.filter((s) => s.hl).map((s) => s.text)])).toEqual([["-", ["rang"]], ["+", ["boomed"]]]);
  // A file no revise branch touches has none.
  expect(await revisionsForPane(project, "chapters/02-nope.md")).toEqual([]);
});

test("accepted edits land on the edit branch through the save path; the rejected one does not", async () => {
  const { vault, session, pane } = await setup();
  const mainHead = git(vault, "rev-parse", "main");
  let t = acceptHunk(pane); // rang -> boomed
  t = rejectHunk(t); // time -> hour, book -> ledger
  t = stepHunk(t, 1);
  expect(t.buffer.cursor.row).toBe(2);
  t = acceptHunk(t); // ... and a sledge
  expect(pendingCount(t)).toBe(0);
  expect(t.buffer.dirty).toBe(true);
  const saved = await session.save(CH1, "edit/ab12cd", fileOf(t));
  expect(saved.ok).toBe(true);
  expect(onEdit(vault)).toBe(BASE.replace("rang", "boomed").replace("long saws.", "long saws and a sledge."));
  expect(git(vault, "rev-parse", "main")).toBe(mainHead);
  // The revise branch is never written.
  expect(git(vault, "show", `revise/r1:novels/ice-house/${CH1}`) + "\n").toBe(REVISED);
});

test("accepting every edit makes the edit branch's file the revise branch's", async () => {
  const { vault, session, pane } = await setup();
  let t = pane;
  while (pendingCount(t) > 0) t = acceptHunk(t);
  expect(fileOf(t)).toBe(REVISED);
  expect((await session.save(CH1, "edit/ab12cd", fileOf(t))).ok).toBe(true);
  expect(onEdit(vault)).toBe(REVISED);
});

test("rejecting every edit leaves the text clean and the edit branch unchanged", async () => {
  const { vault, session, pane } = await setup();
  const before = git(vault, "rev-parse", "edit/ab12cd");
  let t = pane;
  while (pendingCount(t) > 0) t = rejectHunk(t);
  expect(t.buffer.dirty).toBe(false);
  expect(t.buffer.text()).toBe(pane.buffer.text());
  const saved = await session.save(CH1, "edit/ab12cd", fileOf(t));
  expect(saved).toEqual({ ok: true, branch: "edit/ab12cd", lines: [`no change to ${CH1}`] });
  expect(git(vault, "rev-parse", "edit/ab12cd")).toBe(before);
  expect(onEdit(vault)).toBe(BASE);
});

test("an edit whose text the author has since changed no longer matches: accept leaves the text and says so", async () => {
  const { pane } = await setup();
  // The author rewrites the first sentence before deciding.
  const t = apply(pane, (b) => { b.deleteRange({ row: 0, col: 4 }, { row: 0, col: 8 }); b.insert("ice"); });
  expect(t.buffer.text()).toStartWith("The ice rang");
  expect(shownHunks(t)[0]!.matches).toBe(false);
  const after = acceptHunk(t);
  expect(after.buffer.text()).toBe(t.buffer.text());
  expect(after.note).toContain("no longer matches");
  expect(pendingCount(after)).toBe(3);
  // It can still be rejected, and the other edits still apply.
  expect(currentHunk(after)?.hunk.id).toBe("revise/r1#edit:0");
  const rest = acceptHunk(rejectHunk(after));
  expect(rest.buffer.text()).toContain("the hour in the green ledger");
});

test("an edit accepted and saved in an earlier session is not offered again", async () => {
  const { session, pane, revs } = await setup();
  const t = acceptHunk(pane);
  expect((await session.save(CH1, "edit/ab12cd", fileOf(t))).ok).toBe(true);
  const reopened = await session.open(CH1);
  if (!reopened.ok) throw new Error(reopened.message);
  const again = withRevisions(openText(reopened.text, "sentences", 1), revs);
  expect(pendingCount(again)).toBe(2);
  expect(shownHunks(again).map((s) => s.hunk.id)).toEqual(["revise/r1#edit:1", "revise/r1#edit:2"]);
});

test("a merged or empty revise branch is not pending", async () => {
  const { vault, project } = await setup();
  git(vault, "branch", "revise/empty", "main");
  expect((await revisionsForPane(project, CH1)).map((r) => r.branch)).toEqual(["revise/r1"]);
  expect(readFileSync(join(project, CH1), "utf8")).toBe(BASE);
});
