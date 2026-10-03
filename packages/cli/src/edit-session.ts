// `v e` on the screen (AGT-1545): Matt's own edits are always an `edit/<short-id>` branch (the screen doc's "Changes are
// branches"). The editor opens on the file at the cursor's line inside that branch's worktree, so `main` is never touched;
// when it returns, what it left is committed as Matt. One open edit branch per work: a second `v e` goes back into the
// same worktree. Saving is not here: it is the review finish path (`screenFinisher`) run on the branch with nothing
// rejected, so the merge and its after-write steps are the ones every other branch gets.
//
// The editor launch (which command, how to say "open here") is copied from prview's editor.ts and adapted; prview is never
// a dependency. The tui cannot import this package, so cli.ts passes `screenEditor` in through runScreen's options.

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { branchExists, branchKind, createBranch, deleteBranch, ensureWorktree, listBranches, repoRoot, worktreePath } from "./branch";
import type { Author } from "./branch";
import { commitAs } from "./branch";
import { readMarker } from "./marker";
import { insideDir } from "./review-finish";

type Env = Record<string, string | undefined>;

/** The editor command, split into words: the config's `editor` (the settings screen sets it), else $EDITOR, else hx. */
export function editorCommand(configured: string | undefined, env: Env = process.env): string[] {
  return (configured?.trim() || env["EDITOR"] || "hx").split(/\s+/).filter(Boolean);
}

/** Editors that end their options at `--` (and still take `+N` before it). */
const DASHDASH = /^(hx|helix|vi|vim|nvim|gvim|mvim|view|vimdiff|ex)$/;

/**
 * `hx +12 -- /wt/file`, `vim +12 -- /wt/file`, `code -g /wt/file:12 --wait`, `zed /wt/file:12`. The path is made absolute
 * against `root` (the worktree) first, so it starts with `/` and no editor can read it as an option or a command (vim runs
 * `+cmd` and `-c cmd`). An editor that does not know `--` gets the absolute path alone.
 */
export function editorArgs(cmd: readonly string[], path: string, line: number, root: string): string[] {
  const bin = cmd[0]!.split("/").pop()!;
  const p = resolve(root, path);
  if (/^(code|cursor|codium)$/.test(bin)) return [...cmd, "-g", `${p}:${line}`, "--wait"];
  if (/^(zed|subl)$/.test(bin)) return [...cmd, `${p}:${line}`];
  return [...cmd, `+${line}`, ...(DASHDASH.test(bin) ? ["--"] : []), p];
}

/** What the screen gets back: the branch the change is on (null when nothing changed) and lines to show, or why it could not run. */
export type ScreenEditResult =
  | { readonly ok: true; readonly branch: string | null; readonly lines: readonly string[] }
  | { readonly ok: false; readonly message: string };
export interface ScreenEditRequest {
  readonly file: string;
  readonly line: number;
  readonly editor: string;
  /** `e` in a review (AGT-1591): the review branch to edit in its own worktree; `file` is then repo-relative, as the branch's diff names it. */
  readonly branch?: string;
}
export type ScreenEditor = (request: ScreenEditRequest) => Promise<ScreenEditResult>;

export interface EditDeps {
  readonly env?: Env;
  /** Runs the editor in `cwd` with the terminal and resolves with its exit code. Tests inject a fake; the default inherits stdio. */
  readonly run?: (argv: readonly string[], cwd: string) => Promise<number>;
  /** The short id of a new edit branch. */
  readonly shortId?: () => string;
}

const defaultRun = async (argv: readonly string[], cwd: string): Promise<number> => {
  const proc = Bun.spawn([...argv], { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await proc.exited;
};

const defaultShortId = () => Math.random().toString(16).slice(2, 8).padEnd(6, "0");

function git(dir: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", encoding: "utf8" });
}

/** Matt, as git knows him in this repository; a repo with no identity falls back to a name that says so. */
function authorOf(repo: string): Author {
  const get = (key: string) => { try { return git(repo, ["config", key]).trim(); } catch { return ""; } };
  return { name: get("user.name") || "author", email: get("user.email") || "author@localhost" };
}

/** The work's open edit branch: an `edit/` branch whose worktree exists under this slug. */
function openEditBranch(repo: string, slug: string, env: Env): string | undefined {
  const listed = listBranches(repo);
  return listed.ok ? listed.branches.edit.find((b) => existsSync(worktreePath(slug, b, env))) : undefined;
}

/**
 * Opens `request.file` of the project at `request.line` in the editor, in the open edit branch's worktree (made if there
 * is none), then commits what the editor left as the author. A launch that changes nothing leaves a branch it just made
 * out of the world again.
 */
export async function editInProject(projectPath: string, request: ScreenEditRequest, deps: EditDeps = {}): Promise<ScreenEditResult> {
  const env = deps.env ?? process.env;
  const marker = readMarker(projectPath);
  if (!marker.ok) return { ok: false, message: marker.message };
  const repo = repoRoot(projectPath);
  if (repo === undefined) return { ok: false, message: `pablo: edit: ${projectPath} is not in a git repository` };
  if (request.branch !== undefined) return editOnReviewBranch(repo, marker.marker.slug, request.branch, request, deps);
  if (insideDir(projectPath, request.file) === undefined) return { ok: false, message: `pablo: edit: "${request.file}" is not a path inside the project` };
  const slug = marker.marker.slug;

  let branch = openEditBranch(repo, slug, env);
  let made = false;
  if (branch === undefined) {
    const id = (deps.shortId ?? defaultShortId)();
    branch = `edit/${id}`;
    if (branchExists(repo, branch)) return { ok: false, message: `pablo: edit: ${branch} already exists without a worktree; finish or delete it first` };
    const created = createBranch(repo, slug, branch, env);
    if (!created.ok) return { ok: false, message: created.notice };
    made = true;
  }
  const worktree = worktreePath(slug, branch, env);
  const inTree = resolve(worktree, relative(repo, realpathSync(projectPath)), request.file);
  const discard = () => { if (made) deleteBranch(repo, slug, branch, { force: true, env }); };
  if (!existsSync(inTree)) {
    discard();
    return { ok: false, message: `pablo: edit: ${request.file} is not on main yet; commit it first` };
  }

  const argv = editorArgs(editorCommand(request.editor, env), inTree, request.line, worktree);
  let code: number;
  try {
    code = await (deps.run ?? defaultRun)(argv, worktree);
  } catch (error) {
    discard();
    return { ok: false, message: `pablo: edit: could not run ${argv[0]}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const lines: string[] = code === 0 ? [] : [`the editor exited with ${code}; what it saved is kept`];

  let dirty: boolean;
  try {
    dirty = git(worktree, ["status", "--porcelain"]).trim() !== "";
  } catch (error) {
    return { ok: false, message: `pablo: edit: git status failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!dirty) {
    discard();
    return { ok: true, branch: made ? null : branch, lines: [...lines, made ? "no change" : `no new change; ${branch} is still open`] };
  }
  const committed = commitAs(worktree, { message: `edit ${request.file}`, author: authorOf(repo) });
  if (!committed.ok) return { ok: false, message: committed.notice };
  return { ok: true, branch, lines: [...lines, `committed ${request.file} on ${branch} (${(committed.sha ?? "").slice(0, 7)})`, "v s saves it into main"] };
}

/**
 * `e` in a review (AGT-1591): opens `request.file` at `request.line` in the review branch's own worktree (the branch's
 * diff names the file repo-relative), then commits what the editor left as the author, "(edited)" in the subject. A file
 * the editor left alone commits nothing. The branch is the one under review, so it is never made or deleted here.
 */
async function editOnReviewBranch(repo: string, slug: string, branch: string, request: ScreenEditRequest, deps: EditDeps): Promise<ScreenEditResult> {
  const env = deps.env ?? process.env;
  if (!branchKind(branch) || !branchExists(repo, branch)) return { ok: false, message: `pablo: edit: "${branch}" is not a change branch` };
  const tree = ensureWorktree(repo, slug, branch, env);
  if (!tree.ok) return { ok: false, message: tree.notice };
  const worktree = tree.path ?? worktreePath(slug, branch, env);
  if (insideDir(worktree, request.file) === undefined) return { ok: false, message: `pablo: edit: "${request.file}" is not a path inside the repository` };
  const inTree = resolve(worktree, request.file);
  if (!existsSync(inTree)) return { ok: false, message: `pablo: edit: ${request.file} is not on ${branch}` };

  const argv = editorArgs(editorCommand(request.editor, env), inTree, request.line, worktree);
  let code: number;
  try {
    code = await (deps.run ?? defaultRun)(argv, worktree);
  } catch (error) {
    return { ok: false, message: `pablo: edit: could not run ${argv[0]}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const lines: string[] = code === 0 ? [] : [`the editor exited with ${code}; what it saved is kept`];
  let dirty: boolean;
  try {
    dirty = git(worktree, ["status", "--porcelain", "--", request.file]).trim() !== "";
  } catch (error) {
    return { ok: false, message: `pablo: edit: git status failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!dirty) return { ok: true, branch: null, lines: [...lines, `no change to ${request.file}`] };
  const committed = commitAs(worktree, { message: `edit ${request.file} (edited)`, author: authorOf(repo), paths: [request.file] });
  if (!committed.ok) return { ok: false, message: committed.notice };
  return { ok: true, branch, lines: [...lines, `committed ${request.file} on ${branch} (${(committed.sha ?? "").slice(0, 7)})`] };
}

export function screenEditor(projectPath: string, deps: EditDeps = {}): ScreenEditor {
  return (request) => editInProject(projectPath, request, deps);
}
