import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";
import { initAdopt, initNovel } from "../src/init";
import { readMarker } from "../src/marker";

/**
 * Every test below works on a throwaway copy of the synthetic fixture vault
 * under a temp directory — never `~/writing`. See `CLAUDE.md`'s
 * "never write into ~/writing" rule.
 */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));

const cleanupDirs: string[] = [];

function tempVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-init-test-"));
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  cleanupDirs.push(dir);
  return vault;
}

function git(vault: string, ...args: string[]): string {
  return execFileSync("git", ["-C", vault, "-c", "user.email=t@t.example", "-c", "user.name=Test", ...args], {
    encoding: "utf8",
  });
}

function initGitVault(): string {
  const vault = tempVault();
  git(vault, "init", "-q");
  git(vault, "add", "--", ".");
  git(vault, "commit", "-qm", "base");
  return vault;
}

/** Recursively lists every file under `dir`, as paths relative to `root`. */
function walk(root: string, dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(root, full));
    else out.push(relative(root, full));
  }
  return out.sort();
}

function fileBytes(dir: string, relPath: string): Buffer {
  return readFileSync(join(dir, relPath));
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("initNovel scaffolds every template file with placeholders replaced, writes .brief.md, adds a README row, writes pablo.json, and updates .gitignore", () => {
  const vault = initGitVault();

  const result = initNovel(vault, "salt-road", "The Salt Road", { now: () => new Date("2026-03-14T00:00:00Z") });

  expect(result.ok).toBe(true);
  if (!result.ok) return;

  const dest = join(vault, "novels", "salt-road");
  expect(existsSync(dest)).toBe(true);

  for (const relFile of [
    "README.md",
    "QWEN.md",
    "continuity.md",
    "bible/overview.md",
    "bible/timeline.md",
    "bible/places.md",
    "bible/characters/_template.md",
    "bible/characters/.keep",
    "chapters/.keep",
    "notes/.keep",
    "outline/chapters.md",
    "research/.keep",
  ]) {
    expect(existsSync(join(dest, relFile))).toBe(true);
  }

  const readme = readFileSync(join(dest, "README.md"), "utf8");
  expect(readme).toContain("The Salt Road");
  expect(readme).toContain("2026-03-14");
  expect(readme).not.toContain("{{TITLE}}");
  expect(readme).not.toContain("{{DATE}}");

  const qwen = readFileSync(join(dest, "QWEN.md"), "utf8");
  expect(qwen).toContain("salt-road");
  expect(qwen).not.toContain("{{SLUG}}");

  // The character template's own {{NAME}} placeholder is untouched — it is
  // filled in per-character later, not at init time.
  const charTemplate = readFileSync(join(dest, "bible/characters/_template.md"), "utf8");
  expect(charTemplate).toContain("{{NAME}}");

  expect(readFileSync(join(dest, ".brief.md"), "utf8")).toContain("Brief from think");

  const marker = readMarker(dest);
  expect(marker.ok).toBe(true);
  if (marker.ok) {
    expect(marker.marker).toEqual({
      format: "novel",
      title: "The Salt Road",
      slug: "salt-road",
      author: "matt",
      voice: ["../../style", "QWEN.md"],
      neverSend: ["research/", "notes/"],
      publish: {},
    });
  }

  const vaultReadme = readFileSync(join(vault, "README.md"), "utf8");
  expect(vaultReadme).toContain("[The Salt Road](novels/salt-road/)");

  const gitignore = readFileSync(join(vault, ".gitignore"), "utf8");
  expect(gitignore.split("\n")).toContain(".pablo/");

  expect(result.committed).toBe(true);
});

test("initNovel commits only the created/changed paths, never a pre-existing dirty file", () => {
  const vault = initGitVault();

  // Plant an untracked dirty file that must NOT be swept into the commit.
  writeFileSync(join(vault, "unrelated-scratch.txt"), "do not commit me\n");

  const result = initNovel(vault, "salt-road", "The Salt Road", { now: () => new Date("2026-03-14T00:00:00Z") });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.committed).toBe(true);

  const committedFiles = git(vault, "log", "-1", "--name-only", "--pretty=format:")
    .trim()
    .split("\n")
    .filter(Boolean);

  expect(committedFiles).not.toContain("unrelated-scratch.txt");
  expect(committedFiles.some((f) => f.startsWith("novels/salt-road/"))).toBe(true);
  expect(committedFiles).toContain("README.md");
  expect(committedFiles).toContain(".gitignore");

  // The dirty file is still on disk, just not committed.
  expect(existsSync(join(vault, "unrelated-scratch.txt"))).toBe(true);
});

test("initNovel into a non-git vault succeeds with a notice instead of throwing", () => {
  const vault = tempVault(); // no `git init`

  const result = initNovel(vault, "salt-road", "The Salt Road", { now: () => new Date("2026-03-14T00:00:00Z") });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.committed).toBe(false);
  expect(result.notice).toBeDefined();
  expect(existsSync(join(vault, "novels", "salt-road", "pablo.json"))).toBe(true);
});

test("initNovel onto an existing slug refuses with exit code 2", () => {
  const vault = tempVault();

  const result = initNovel(vault, "ice-house", "Ice House Again");

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(2);
  expect(result.message).toContain("already exists");
});

test("initNovel refuses a slug that would path-traverse out of the vault", () => {
  const vault = tempVault();

  for (const slug of ["../evil", "../../tmp/evil", "novels/../../evil", "a/b"]) {
    const result = initNovel(vault, slug, "Evil Title");
    expect(result.ok).toBe(false);
    if (result.ok) continue;
    expect(result.code).toBe(2);
    expect(result.message).toContain("invalid slug");
  }

  // Nothing was written outside the vault.
  expect(existsSync(join(vault, "..", "evil"))).toBe(false);
  expect(existsSync(join(vault, "..", "..", "tmp", "evil"))).toBe(false);
});

test("a .gitignore that already ignores .brief.md does not fail the commit — .brief.md is written but simply not tracked", () => {
  const vault = tempVault();
  writeFileSync(join(vault, ".gitignore"), ".brief.md\n");
  git(vault, "init", "-q");
  git(vault, "add", "--", ".");
  git(vault, "commit", "-qm", "base");

  const result = initNovel(vault, "salt-road", "The Salt Road", { now: () => new Date("2026-03-14T00:00:00Z") });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.committed).toBe(true);

  const dest = join(vault, "novels", "salt-road");
  expect(existsSync(join(dest, ".brief.md"))).toBe(true); // on disk

  const tracked = git(vault, "ls-files", "--", "novels/salt-road").trim().split("\n").filter(Boolean);
  expect(tracked).not.toContain("novels/salt-road/.brief.md");
  expect(tracked.some((f) => f.endsWith("README.md"))).toBe(true);
});

test("initAdopt writes only pablo.json (title from the README heading) and leaves every other file byte-identical", () => {
  const vault = tempVault();
  const projectDir = join(vault, "novels", "no-marker");

  const before = walk(projectDir, projectDir);
  const beforeBytes = new Map(before.map((f) => [f, fileBytes(projectDir, f)]));

  const result = initAdopt(vault, projectDir, "no-marker");

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.title).toBe("The Ice House");
  expect(result.committed).toBe(false);

  const marker = readMarker(projectDir);
  expect(marker.ok).toBe(true);
  if (marker.ok) {
    expect(marker.marker.format).toBe("novel");
    expect(marker.marker.slug).toBe("no-marker");
    expect(marker.marker.title).toBe("The Ice House");
  }

  const after = walk(projectDir, projectDir).filter((f) => f !== "pablo.json");
  expect(after).toEqual(before);
  for (const f of after) {
    expect(fileBytes(projectDir, f).equals(beforeBytes.get(f)!)).toBe(true);
  }
});

test("initAdopt twice refuses the second time with exit code 2", () => {
  const vault = tempVault();
  const projectDir = join(vault, "novels", "no-marker");

  const first = initAdopt(vault, projectDir, "no-marker");
  expect(first.ok).toBe(true);

  const second = initAdopt(vault, projectDir, "no-marker");
  expect(second.ok).toBe(false);
  if (second.ok) return;
  expect(second.code).toBe(2);
  expect(second.message).toContain("already has a pablo.json");
});
