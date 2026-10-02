import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter } from "@openthink/pablo-core";
import { listBranches, worktreePath } from "../src/branch";
import { editInProject, editorArgs, editorCommand, screenEditor } from "../src/edit-session";
import { screenFinisher } from "../src/review-finish";

/**
 * AGT-1545: `v e` edits on an `edit/<id>` branch in its own worktree, committed as the author; Save is the review
 * finish path. Temp git copy of the fixture vault, a fake editor (a script or an injected runner), a think-free PATH
 * and temp state/home dirs: no real editor, no `think`, nothing under ~/.config/pablo.
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
const BASE = ["---", "chapter: 1", "title: The Last Full Cut", "words: 40", "model: base-model", "---", "", "The pond rang under the horse.", "Odile heard it from the doorway.", "She wrote the time in the green book.", ""].join("\n");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pablo-edit-"));
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
  return { dir, vault, project, env };
}

/** A runner that stands in for the editor: records the argv and cwd, then rewrites a line of the file it was pointed at. */
function fakeEditor(replace?: [string, string]) {
  const calls: { argv: readonly string[]; cwd: string }[] = [];
  const run = async (argv: readonly string[], cwd: string) => {
    calls.push({ argv, cwd });
    if (replace) {
      const file = argv[argv.length - 1]!;
      writeFileSync(file, readFileSync(file, "utf8").replace(replace[0], replace[1]));
    }
    return 0;
  };
  return { run, calls };
}

test("the editor command is the config's, else $EDITOR, else hx; the line goes the way each editor takes it", () => {
  expect(editorCommand("vim -u NONE", { EDITOR: "nano" })).toEqual(["vim", "-u", "NONE"]);
  expect(editorCommand("", { EDITOR: "nano" })).toEqual(["nano"]);
  expect(editorCommand(undefined, {})).toEqual(["hx"]);
  expect(editorArgs(["hx"], "a.md", 12, "/wt")).toEqual(["hx", "+12", "--", "/wt/a.md"]);
  expect(editorArgs(["code"], "a.md", 12, "/wt")).toEqual(["code", "-g", "/wt/a.md:12", "--wait"]);
  expect(editorArgs(["nano"], "+:!touch x", 3, "/wt")).toEqual(["nano", "+3", "/wt/+:!touch x"]);
});

test("v e makes an edit/<id> branch with a worktree, opens the file in it at the line, and commits what the editor left as the author", async () => {
  const { project, vault, env } = setup();
  const editor = fakeEditor(["from the doorway", "from the scale house"]);
  const r = await editInProject(project, { file: CH1, line: 9, editor: "vim" }, { env, run: editor.run, shortId: () => "ab12cd" });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.branch).toBe("edit/ab12cd");
  const wt = worktreePath("ice-house", "edit/ab12cd", env);
  expect(editor.calls).toHaveLength(1);
  expect(editor.calls[0]!.cwd).toBe(wt);
  expect(editor.calls[0]!.argv).toEqual(["vim", "+9", "--", join(wt, "novels", "ice-house", CH1)]);
  expect(git(vault, "log", "-1", "--format=%an <%ae>", "edit/ab12cd")).toBe("Matt Test <matt@example.com>");
  expect(git(vault, "show", `edit/ab12cd:novels/ice-house/${CH1}`)).toContain("from the scale house");
  // main is untouched until Save.
  expect(readFileSync(join(project, CH1), "utf8")).toBe(BASE);
  expect(git(vault, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
});

test("one open edit branch per work: a second v e goes back into the same worktree", async () => {
  const { project, vault, env } = setup();
  const first = await editInProject(project, { file: CH1, line: 8, editor: "vim" }, { env, run: fakeEditor(["pond rang", "pond sang"]).run, shortId: () => "ab12cd" });
  const second = await editInProject(project, { file: CH1, line: 9, editor: "vim" }, { env, run: fakeEditor(["horse.", "mare."]).run, shortId: () => "ffffff" });
  expect(first.ok && second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.branch).toBe("edit/ab12cd");
  const listed = listBranches(vault);
  expect(listed.ok && listed.branches.edit).toEqual(["edit/ab12cd"]);
  expect(git(vault, "rev-list", "--count", "main..edit/ab12cd")).toBe("2");
});

test("an editor that changes nothing leaves no branch behind", async () => {
  const { project, vault, env } = setup();
  const r = await editInProject(project, { file: CH1, line: 8, editor: "vim" }, { env, run: fakeEditor().run, shortId: () => "ab12cd" });
  expect(r).toEqual({ ok: true, branch: null, lines: ["no change"] });
  expect(existsSync(worktreePath("ice-house", "edit/ab12cd", env))).toBe(false);
  const listed = listBranches(vault);
  expect(listed.ok && listed.branches.edit).toEqual([]);
});

test("refusals: a path outside the project, a file main does not have, an editor that cannot run", async () => {
  const { project, env } = setup();
  const never = fakeEditor();
  expect((await editInProject(project, { file: "../outside.md", line: 1, editor: "vim" }, { env, run: never.run })).ok).toBe(false);
  const missing = await editInProject(project, { file: "chapters/99-nope.md", line: 1, editor: "vim" }, { env, run: never.run, shortId: () => "aaaaaa" });
  expect(missing.ok).toBe(false);
  expect(never.calls).toEqual([]);
  expect(existsSync(worktreePath("ice-house", "edit/aaaaaa", env))).toBe(false);
  const broken = await editInProject(project, { file: CH1, line: 1, editor: "vim" }, { env, run: async () => { throw new Error("spawn ENOENT"); }, shortId: () => "bbbbbb" });
  expect(broken.ok).toBe(false);
  if (!broken.ok) expect(broken.message).toContain("could not run vim");
  expect(existsSync(worktreePath("ice-house", "edit/bbbbbb", env))).toBe(false);
});

test("a real editor process: a script on the command line is run in the worktree with +line and the absolute path", async () => {
  const { dir, project, env } = setup();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const script = join(bin, "vim");
  writeFileSync(script, `#!/bin/sh\necho "$@" > "${dir}/args.txt"\nfor last; do :; done\nsed -i.bak 's/horse/mare/' "$last"\nrm -f "$last.bak"\n`);
  chmodSync(script, 0o755);
  const r = await screenEditor(project, { env, shortId: () => "c0ffee" })({ file: CH1, line: 8, editor: script });
  expect(r.ok).toBe(true);
  expect(readFileSync(join(dir, "args.txt"), "utf8")).toContain(`+8 -- ${join(worktreePath("ice-house", "edit/c0ffee", env), "novels", "ice-house", CH1)}`);
  expect(git(project, "show", `edit/c0ffee:novels/ice-house/${CH1}`)).toContain("under the mare");
});

test("Save: the edit branch merges into main through the review finish path, its worktree and branch go, the after-write steps run", async () => {
  const { project, vault, env } = setup();
  const edited = await editInProject(project, { file: CH1, line: 9, editor: "vim" }, { env, run: fakeEditor(["from the doorway", "from the scale house"]).run, shortId: () => "ab12cd" });
  expect(edited.ok).toBe(true);
  const extractor: Adapter = { async *complete() { yield { type: "text", text: "{}" } as never; } } as unknown as Adapter;
  const saved = await screenFinisher(project, { env, extractor, now: () => new Date("2026-10-02T12:00:00.000Z") })("edit/ab12cd", { removed: [], added: [] });
  expect(saved.ok).toBe(true);
  if (saved.ok) expect(saved.lines[0]).toContain("merged edit/ab12cd into main");
  expect(readFileSync(join(project, CH1), "utf8")).toContain("from the scale house");
  expect(git(vault, "branch", "--list", "edit/*")).toBe("");
  expect(existsSync(worktreePath("ice-house", "edit/ab12cd", env))).toBe(false);
  // The merged work's author stays Matt.
  expect(git(vault, "log", "--no-merges", "-1", "--format=%an", "main")).toBe("Matt Test");
});
