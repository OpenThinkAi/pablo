import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";
import { initAdopt, initNovel, initTrack, vaultAuthor } from "../src/init";
import { coreStages, readCoreState } from "../src/core/machine";
import { captureConsoleLog } from "../src/verbs";
import { main } from "../src/cli";
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
    "STYLE.md",
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

  const qwen = readFileSync(join(dest, "STYLE.md"), "utf8");
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
    // A new work is born in the story-core shape (AGT-1666): `outputs`, never the deprecated `format`.
    expect(marker.marker).toEqual({
      title: "The Salt Road",
      slug: "salt-road",
      author: "author",
      voice: ["../../style", "STYLE.md"],
      neverSend: ["research/", "notes/"],
      publish: {},
      outputs: { novel: { dir: "chapters", added: "2026-03-14" } },
    });
    expect(marker.deprecated).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dest, "pablo.json"), "utf8"))).not.toHaveProperty("format");
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

test("init records the author it is given, and vaultAuthor reads the vault's own git user.name", () => {
  const vault = initGitVault();
  git(vault, "config", "user.name", "Ada Writer");
  expect(vaultAuthor(vault)).toBe("Ada Writer");

  const created = initNovel(vault, "salt-road", "The Salt Road", { author: vaultAuthor(vault) });
  expect(created.ok).toBe(true);
  const marker = readMarker(join(vault, "novels", "salt-road"));
  expect(marker.ok && marker.marker.author).toBe("Ada Writer");

  const adopted = initAdopt(vault, join(vault, "novels", "no-marker"), "no-marker", { author: "Ada Writer" });
  expect(adopted.ok).toBe(true);
  const adoptedMarker = readMarker(join(vault, "novels", "no-marker"));
  expect(adoptedMarker.ok && adoptedMarker.marker.author).toBe("Ada Writer");
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
    expect(marker.marker.outputs.novel).toMatchObject({ dir: "chapters" });
    expect(marker.deprecated).toBeUndefined();
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

// ---------------------------------------------------------------------------
// AGT-2103: init --track
// ---------------------------------------------------------------------------

test("initNovel with track historical-fiction writes track and adds the period core files beside the template", () => {
  const vault = initGitVault();
  const result = initNovel(vault, "salt-road", "The Salt Road", { now: () => new Date("2026-03-14T00:00:00Z"), track: "historical-fiction" });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.track).toBe("historical-fiction");
  const dest = join(vault, "novels", "salt-road");
  const marker = readMarker(dest);
  expect(marker.ok && marker.marker.track).toBe("historical-fiction");
  expect(existsSync(join(dest, "bible", "period.md"))).toBe(true);
  expect(existsSync(join(dest, "facts", "period.md"))).toBe(true);
  // The template's own files are untouched by the track's.
  expect(fileBytes(dest, "bible/overview.md").toString()).not.toContain("# Period");
  const tracked = git(vault, "ls-files", "--", "novels/salt-road").split("\n");
  expect(tracked).toContain("novels/salt-road/bible/period.md");
  expect(tracked).toContain("novels/salt-road/facts/period.md");
  // Headings alone satisfy nothing: the period stages are still open.
  const open = coreStages(readCoreState(dest, "historical-fiction")).filter((s) => !s.done).map((s) => s.id);
  expect(open).toContain("period");
  expect(open).toContain("period-facts");
});

test("initNovel refuses an unknown track and a track the novel output does not allow, writing nothing", () => {
  const vault = initGitVault();
  const unknown = initNovel(vault, "salt-road", "The Salt Road", { track: "memoir" });
  expect(unknown.ok).toBe(false);
  if (!unknown.ok) expect(unknown.message).toContain('unknown track "memoir"');
  const nonfiction = initNovel(vault, "salt-road", "The Salt Road", { track: "nonfiction" });
  expect(nonfiction.ok).toBe(false);
  if (!nonfiction.ok) expect(nonfiction.message).toContain("pablo init --track nonfiction");
  expect(existsSync(join(vault, "novels", "salt-road"))).toBe(false);
});

test("initTrack nonfiction scaffolds a core-only work under essays/ with the nonfiction core and commits it", () => {
  const vault = initGitVault();
  const result = initTrack(vault, "the-press", "The Press", "nonfiction", { now: () => new Date("2026-03-14T00:00:00Z"), author: "Test Author" });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const dest = join(vault, "essays", "the-press");
  expect(result.path).toBe(dest);
  expect(result.format).toBeUndefined();
  expect(walk(dest, dest)).toEqual(["README.md", "STYLE.md", "core/claims.md", "core/outline.md", "core/thesis.md", "notes/.keep", "pablo.json", "research/.keep"]);
  const marker = readMarker(dest);
  expect(marker.ok).toBe(true);
  if (!marker.ok) return;
  expect(marker.marker.track).toBe("nonfiction");
  expect(marker.marker.outputs).toEqual({});
  expect(marker.marker.author).toBe("Test Author");
  expect(readFileSync(join(vault, "README.md"), "utf8")).toContain("| [The Press](essays/the-press/) | nonfiction | 2026-03-14 | created |");
  expect(result.committed).toBe(true);
  expect(git(vault, "status", "--porcelain")).toBe("");
  expect(coreStages(readCoreState(dest, "nonfiction")).every((s) => !s.done)).toBe(true);
});

test("initTrack on a fiction track puts the work under stories/; an unknown track is refused", () => {
  const vault = initGitVault();
  const result = initTrack(vault, "harbour", "Harbour", "historical-fiction");
  expect(result.ok && result.path).toBe(join(vault, "stories", "harbour"));
  expect(existsSync(join(vault, "stories", "harbour", "bible", "period.md"))).toBe(true);
  const bad = initTrack(vault, "harbour-2", "Harbour", "memoir");
  expect(bad.ok).toBe(false);
});

test("pablo init --track <t> <slug> <Title> and pablo init novel ... --track <t> through the CLI", async () => {
  const vault = initGitVault();
  const core = await captureConsoleLog(() => main(["init", "--track", "nonfiction", "the-press", "The Press", "--json"], vault));
  expect(core.exitCode).toBe(0);
  const coreBody = JSON.parse(core.text) as Record<string, unknown>;
  expect(coreBody["track"]).toBe("nonfiction");
  expect(coreBody["format"]).toBeNull();

  const novel = await captureConsoleLog(() => main(["init", "novel", "salt-road", "The Salt Road", "--track", "historical-fiction", "--json"], vault));
  expect(novel.exitCode).toBe(0);
  const novelBody = JSON.parse(novel.text) as Record<string, unknown>;
  expect(novelBody["format"]).toBe("novel");
  expect(novelBody["track"]).toBe("historical-fiction");
});
