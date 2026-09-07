/**
 * `pablo init` — the only verb that runs without a marker, because its job
 * is to write one.
 *
 * Two forms:
 *  - `initNovel(vault, slug, title)` scaffolds a brand-new work from
 *    `<vault>/templates/novel` (the port of `~/writing/bin/new-work`).
 *  - `initAdopt(vault, projectDir, slug)` writes only the marker into a work
 *    that already exists on disk, touching nothing else.
 *
 * Git is best-effort: a failure to add/commit is returned as a `notice`
 * string on an otherwise-successful result, never thrown — files already
 * written to disk are never rolled back because git objected afterward.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DEFAULT_AUTHOR, DEFAULT_NEVER_SEND, DEFAULT_PUBLISH, DEFAULT_VOICE, markerPath, writeMarker } from "./marker";
import type { Marker } from "./marker";
import type { Refusal } from "./project";

/**
 * A vault-safe directory-name shape: lowercase letters, digits, and hyphens,
 * starting with a letter or digit. `slug` comes from CLI positionals (an
 * agent's model-suggested `pablo init <format> <slug> ...` call, ultimately),
 * and is joined into a vault path with `node:path.join` — which silently
 * resolves `..` segments. Validating against this pattern before any join
 * is what keeps a slug like `../../tmp/evil` from writing outside the vault.
 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface InitOk {
  readonly ok: true;
  readonly path: string;
  readonly format: string;
  readonly slug: string;
  readonly title: string;
  readonly committed: boolean;
  readonly notice?: string;
}

export type InitResult = InitOk | Refusal;

function refuse(message: string, tried: readonly string[]): Refusal {
  return { ok: false, code: 2, message, tried };
}

function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Recursively lists every file (not directory) under `dir`, depth-first. */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

/** Recursively copies `src` to `dest` (dest must not already exist). */
function copyTree(src: string, dest: string): void {
  cpSync(src, dest, { recursive: true, errorOnExist: true });
}

/** Replaces `{{KEY}}` tokens in every `.md` file under `dir`, in place. */
function replacePlaceholders(dir: string, vars: Readonly<Record<string, string>>): void {
  for (const file of walkFiles(dir)) {
    if (!file.endsWith(".md")) continue;
    let content = readFileSync(file, "utf8");
    for (const [key, value] of Object.entries(vars)) {
      content = content.split(`{{${key}}}`).join(value);
    }
    writeFileSync(file, content, "utf8");
  }
}

/**
 * Inserts a work's row into `<vault>/README.md`'s works table, after the
 * last row of the table whose separator line starts with `|------` — the
 * same insertion rule `bin/new-work` used. If the file has no such table,
 * appends a note instead of failing.
 */
function addReadmeRow(vault: string, title: string, kind: string, dirName: string, slug: string, date: string): void {
  const readmePath = join(vault, "README.md");
  const row = `| [${title}](${dirName}/${slug}/) | ${kind} | ${date} | created |`;

  if (!existsSync(readmePath)) {
    writeFileSync(readmePath, `# Works\n\n${row}\n`, "utf8");
    return;
  }

  const content = readFileSync(readmePath, "utf8");
  const lines = content.split("\n");
  const sepIndex = lines.findIndex((l) => l.startsWith("|------"));

  if (sepIndex === -1) {
    const sep = content.endsWith("\n") ? "" : "\n";
    writeFileSync(readmePath, `${content}${sep}\n- ${date}: [${title}](${dirName}/${slug}/) (${kind}) created.\n`, "utf8");
    return;
  }

  let insertAt = sepIndex + 1;
  while (insertAt < lines.length && lines[insertAt]!.startsWith("|")) insertAt++;
  lines.splice(insertAt, 0, row);
  writeFileSync(readmePath, lines.join("\n"), "utf8");
}

/** Appends `entry` to `<vault>/.gitignore` if not already present (as its own line). Returns whether it changed the file. */
function ensureGitignoreEntry(vault: string, entry: string): boolean {
  const gitignorePath = join(vault, ".gitignore");

  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${entry}\n`, "utf8");
    return true;
  }

  const content = readFileSync(gitignorePath, "utf8");
  if (content.split("\n").some((l) => l.trim() === entry)) return false;

  const sep = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  writeFileSync(gitignorePath, `${content}${sep}${entry}\n`, "utf8");
  return true;
}

/**
 * True if `git check-ignore` says `relPath` (relative to `vault`) is
 * ignored there. Fails closed to "not ignored" on any non-zero exit
 * (no-match, or a git error such as "not a repository") so a non-repo
 * vault surfaces its real failure at `git add` instead of silently
 * skipping every path.
 */
function isIgnored(vault: string, relPath: string): boolean {
  try {
    execFileSync("git", ["-C", vault, "check-ignore", "-q", "--", relPath], { stdio: "pipe" });
    return true; // exit 0 => ignored
  } catch {
    return false;
  }
}

function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    if (stderr) return stderr.toString().trim().split("\n")[0] ?? String(err);
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * `git -C vault add -- <paths>` then `git -C vault commit -m <message> -- <paths>`,
 * where `paths` are relative to `vault`. Paths `git check-ignore` flags are
 * dropped before either call so a gitignored file (e.g. `.brief.md`) never
 * fails the add. Any git failure (not a repo, nothing to commit, etc.) comes
 * back as `{committed: false, notice}` — never a thrown exception.
 */
function gitCommit(vault: string, message: string, absPaths: readonly string[]): { committed: boolean; notice?: string } {
  const relPaths = absPaths.map((p) => relative(vault, p));
  const trackablePaths = relPaths.filter((p) => !isIgnored(vault, p));

  if (trackablePaths.length === 0) {
    return { committed: false, notice: "pablo: nothing to commit (all created paths are gitignored)" };
  }

  try {
    execFileSync("git", ["-C", vault, "add", "--", ...trackablePaths], { stdio: "pipe" });
  } catch (err) {
    return { committed: false, notice: `pablo: git add failed: ${errMessage(err)}` };
  }

  try {
    execFileSync("git", ["-C", vault, "commit", "-m", message, "--", ...trackablePaths], { stdio: "pipe" });
  } catch (err) {
    return { committed: false, notice: `pablo: git commit failed: ${errMessage(err)}` };
  }

  return { committed: true };
}

/**
 * `pablo init novel <slug> "<Title>"`: copies `<vault>/templates/novel` to
 * `<vault>/novels/<slug>`, fills `{{TITLE}}`/`{{DATE}}`/`{{SLUG}}`, writes
 * `.brief.md` and `pablo.json`, adds the work's row to `<vault>/README.md`,
 * adds `.pablo/` to `<vault>/.gitignore` if absent, then commits every
 * created/changed path by pathspec. `now` is injectable for deterministic
 * tests.
 */
export function initNovel(vault: string, slug: string, title: string, opts: { now?: () => Date } = {}): InitResult {
  if (!SLUG_PATTERN.test(slug)) {
    return refuse(`pablo: init: invalid slug "${slug}" (only lowercase letters, digits, and hyphens are allowed)`, []);
  }

  const now = opts.now ?? (() => new Date());
  const templateDir = join(vault, "templates", "novel");
  const destDir = join(vault, "novels", slug);

  if (!existsSync(templateDir)) {
    return refuse(`pablo: init: no template at ${templateDir}`, [templateDir]);
  }
  if (existsSync(destDir)) {
    return refuse(`pablo: init: ${destDir} already exists`, [destDir]);
  }

  copyTree(templateDir, destDir);

  const date = formatDate(now());
  replacePlaceholders(destDir, { TITLE: title, DATE: date, SLUG: slug });

  writeFileSync(join(destDir, ".brief.md"), `# Brief from think\n\n(generated by \`write ${slug}\` at session start)\n`, "utf8");

  const marker: Marker = {
    format: "novel",
    title,
    slug,
    author: DEFAULT_AUTHOR,
    voice: DEFAULT_VOICE,
    neverSend: DEFAULT_NEVER_SEND,
    publish: DEFAULT_PUBLISH,
  };
  writeMarker(destDir, marker);

  addReadmeRow(vault, title, "novel", "novels", slug, date);
  ensureGitignoreEntry(vault, ".pablo/");

  const createdPaths = [...walkFiles(destDir), join(vault, "README.md"), join(vault, ".gitignore")];
  const { committed, notice } = gitCommit(vault, `novel: create ${slug}`, createdPaths);

  return {
    ok: true,
    path: destDir,
    format: "novel",
    slug,
    title,
    committed,
    ...(notice ? { notice } : {}),
  };
}

/**
 * `pablo init --adopt --project <slug>`: writes only `pablo.json` (title
 * taken from the work's `README.md` first `# ` heading, minus a trailing
 * " (working title)"; everything else defaulted) plus the `.gitignore` line
 * if absent — nothing else in the work changes, and this never git-commits
 * (the AC calls that the author's/agent's own decision).
 */
export function initAdopt(vault: string, projectDir: string, slug: string): InitResult {
  if (existsSync(markerPath(projectDir))) {
    return refuse(`pablo: init --adopt: ${projectDir} already has a pablo.json`, [markerPath(projectDir)]);
  }

  let title = slug;
  const readmePath = join(projectDir, "README.md");
  if (existsSync(readmePath)) {
    const content = readFileSync(readmePath, "utf8");
    const match = content.match(/^#\s+(.+?)\s*$/m);
    if (match?.[1]) {
      title = match[1].replace(/\s*\(working title\)\s*$/i, "").trim();
    }
  }

  const marker: Marker = {
    format: "novel",
    title,
    slug,
    author: DEFAULT_AUTHOR,
    voice: DEFAULT_VOICE,
    neverSend: DEFAULT_NEVER_SEND,
    publish: DEFAULT_PUBLISH,
  };
  writeMarker(projectDir, marker);

  const gitignoreChanged = ensureGitignoreEntry(vault, ".pablo/");

  return {
    ok: true,
    path: projectDir,
    format: "novel",
    slug,
    title,
    committed: false,
    notice: `pablo: adopt does not commit; commit pablo.json${gitignoreChanged ? " and .gitignore" : ""} yourself`,
  };
}
