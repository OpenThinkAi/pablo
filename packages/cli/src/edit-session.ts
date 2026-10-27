// Matt's own edits on the screen (AGT-1545) are always an `edit/<short-id>` branch (the screen doc's "Changes are
// branches"). `v e` edits in the screen's own pane (`screenEditPane`, at the end, AGT-2167); this launch path was `v e`'s
// before that and is still `e` in a review (AGT-1591). The editor opens on the file at the cursor's line inside that branch's worktree, so `main` is never touched;
// when it returns, what it left is committed as Matt. One open edit branch per work: a second `v e` goes back into the
// same worktree. Saving is not here: it is the review finish path (`screenFinisher`) run on the branch with nothing
// rejected, so the merge and its after-write steps are the ones every other branch gets.
//
// The editor launch (which command, how to say "open here") is copied from prview's editor.ts and adapted; prview is never
// a dependency. The tui cannot import this package, so cli.ts passes `screenEditor` in through runScreen's options.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { branchExists, branchIsEmpty, branchKind, createBranch, deleteBranch, ensureWorktree, listBranches, repoRoot, worktreePath } from "./branch";
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

/** How many commits `branch` holds that `main` does not; 0 when git cannot say. */
function unmergedCount(repo: string, branch: string): number {
  try { return Number(git(repo, ["rev-list", "--count", `main..${branch}`]).trim()) || 0; } catch { return 0; }
}

/**
 * The work's open edit branch: an `edit/` branch whose worktree exists under this slug, else (AGT-2173) one an earlier
 * session left with commits main does not have yet (autosaves never merged with `v s`), its worktree added back.
 */
function openEditBranch(repo: string, slug: string, env: Env): string | undefined {
  const listed = listBranches(repo);
  if (!listed.ok) return undefined;
  const live = listed.branches.edit.find((b) => existsSync(worktreePath(slug, b, env)));
  if (live !== undefined) return live;
  const left = listed.branches.edit.find((b) => unmergedCount(repo, b) > 0);
  return left !== undefined && ensureWorktree(repo, slug, left, env).ok ? left : undefined;
}

interface EditTree { readonly ok: true; readonly branch: string; readonly worktree: string; readonly inTree: string; readonly made: boolean; readonly discard: () => void }

/**
 * The work's open edit branch (made, with its worktree, if there is none) and where the project-relative `file` is in
 * that worktree. A file that is not on main yet is refused, and a branch made for it goes again.
 */
function editTree(projectPath: string, repo: string, slug: string, file: string, deps: EditDeps): EditTree | { ok: false; message: string } {
  const env = deps.env ?? process.env;
  if (insideDir(projectPath, file) === undefined) return { ok: false, message: `pablo: edit: "${file}" is not a path inside the project` };
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
  const open = branch;
  const worktree = worktreePath(slug, open, env);
  const inTree = resolve(worktree, relative(repo, realpathSync(projectPath)), file);
  const discard = () => { if (made) deleteBranch(repo, slug, open, { force: true, env }); };
  if (!existsSync(inTree)) {
    discard();
    return { ok: false, message: `pablo: edit: ${file} is not on main yet; commit it first` };
  }
  return { ok: true, branch: open, worktree, inTree, made, discard };
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
  const tree = editTree(projectPath, repo, marker.marker.slug, request.file, deps);
  if (!tree.ok) return tree;
  const { branch, worktree, inTree, made, discard } = tree;

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

// `v e` in place (AGT-2167, D-18/D-23): the screen's own editing pane edits the unit on the same `edit/` branch the editor
// launch above uses (one per work), so `v s` saves it the same way. `open` makes or reuses the branch and reads the file
// there (an earlier session's unmerged branch is reused, AGT-2173); `save` writes what the pane hands it and commits it as
// the author (Ctrl+S, and the pane's autosave after an idle pause: main moves only on `v s`); `close` takes a branch `open` made back out
// of the world when nothing was ever committed on it. No editor process runs.

/** `unmerged` (AGT-2173): the commits the branch already holds that main does not (an earlier session's autosaves), when there are any. */
export type PaneOpen = { readonly ok: true; readonly branch: string; readonly text: string; readonly unmerged?: number } | { readonly ok: false; readonly message: string };
export type PaneSave = { readonly ok: true; readonly branch: string; readonly lines: readonly string[] } | { readonly ok: false; readonly message: string };
export interface EditPaneSession {
  open(file: string): Promise<PaneOpen>;
  save(file: string, branch: string, text: string): Promise<PaneSave>;
  close(branch: string): Promise<void>;
}

function paneRepo(projectPath: string): { ok: true; repo: string; slug: string } | { ok: false; message: string } {
  const marker = readMarker(projectPath);
  if (!marker.ok) return { ok: false, message: marker.message };
  const repo = repoRoot(projectPath);
  if (repo === undefined) return { ok: false, message: `pablo: edit: ${projectPath} is not in a git repository` };
  return { ok: true, repo, slug: marker.marker.slug };
}

/** Reads the project-relative `file` on the work's edit branch, making the branch and its worktree if there is none. */
export async function openForPane(projectPath: string, file: string, deps: EditDeps = {}): Promise<PaneOpen> {
  const at = paneRepo(projectPath);
  if (!at.ok) return at;
  const tree = editTree(projectPath, at.repo, at.slug, file, deps);
  if (!tree.ok) return tree;
  try {
    const text = readFileSync(tree.inTree, "utf8");
    const unmerged = tree.made ? 0 : unmergedCount(at.repo, tree.branch);
    return { ok: true, branch: tree.branch, text, ...(unmerged > 0 ? { unmerged } : {}) };
  } catch (error) {
    tree.discard();
    return { ok: false, message: `pablo: edit: could not read ${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Writes `text` as the project-relative `file` in `branch`'s worktree and commits it as the author; an unchanged file commits nothing. */
export async function saveFromPane(projectPath: string, file: string, branch: string, text: string, deps: EditDeps = {}): Promise<PaneSave> {
  const env = deps.env ?? process.env;
  const at = paneRepo(projectPath);
  if (!at.ok) return at;
  if (branchKind(branch) !== "edit" || !branchExists(at.repo, branch)) return { ok: false, message: `pablo: edit: "${branch}" is not an edit branch` };
  if (insideDir(projectPath, file) === undefined) return { ok: false, message: `pablo: edit: "${file}" is not a path inside the project` };
  const worktree = worktreePath(at.slug, branch, env);
  if (!existsSync(worktree)) return { ok: false, message: `pablo: edit: ${branch} has no worktree; open it again with v e` };
  const inTree = resolve(worktree, relative(at.repo, realpathSync(projectPath)), file);
  const path = relative(worktree, inTree);
  // Never write through a link: a symlink in the worktree could point anywhere, main's checkout included.
  try {
    if (lstatSync(inTree, { throwIfNoEntry: false })?.isSymbolicLink()) return { ok: false, message: `pablo: edit: ${file} is a symbolic link; not writing through it; make it a plain file on the branch first` };
  } catch (error) {
    return { ok: false, message: `pablo: edit: could not check ${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    writeFileSync(inTree, text);
  } catch (error) {
    return { ok: false, message: `pablo: edit: could not write ${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
  let dirty: boolean;
  try {
    dirty = git(worktree, ["status", "--porcelain", "--", path]).trim() !== "";
  } catch (error) {
    return { ok: false, message: `pablo: edit: git status failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!dirty) return { ok: true, branch, lines: [`no change to ${file}`] };
  const committed = commitAs(worktree, { message: `edit ${file}`, author: authorOf(at.repo), paths: [path] });
  if (!committed.ok) return { ok: false, message: committed.notice };
  return { ok: true, branch, lines: [`committed ${file} on ${branch} (${(committed.sha ?? "").slice(0, 7)})`, "v s saves it into main"] };
}

/** The pane closed: an edit branch with nothing committed and nothing left in its worktree is deleted with its worktree. */
export async function closePane(projectPath: string, branch: string, deps: EditDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const at = paneRepo(projectPath);
  if (!at.ok || branchKind(branch) !== "edit" || !branchExists(at.repo, branch)) return;
  const worktree = worktreePath(at.slug, branch, env);
  try {
    if (existsSync(worktree) && git(worktree, ["status", "--porcelain"]).trim() !== "") return;
    if (git(at.repo, ["rev-list", "--count", `main..${branch}`]).trim() !== "0" || !branchIsEmpty(at.repo, branch)) return;
  } catch {
    return;
  }
  deleteBranch(at.repo, at.slug, branch, { force: true, env });
}

export function screenEditPane(projectPath: string, deps: EditDeps = {}): EditPaneSession {
  return {
    open: (file) => openForPane(projectPath, file, deps),
    save: (file, branch, text) => saveFromPane(projectPath, file, branch, text, deps),
    close: (branch) => closePane(projectPath, branch, deps),
  };
}
