import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTool, searchTool, SEARCH_LIMIT } from "../src/harness-tools";
import { VERBS } from "../src/verbs";

const FIXTURE = fileURLToPath(new URL("./fixtures/vault/novels/ice-house", import.meta.url));
const dirs: string[] = [];

/** A temp COPY of the fixture work, so a test can add files without touching the repo. */
function work(): string {
  const root = mkdtempSync(join(tmpdir(), "pablo-harness-tools-"));
  dirs.push(root);
  const dir = join(root, "ice-house");
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("read returns a chapter joined into paragraphs, frontmatter apart", () => {
  const dir = work();
  // One sentence per line on disk, as AGT-1531 will write it.
  writeFileSync(
    join(dir, "chapters", "02-thaw.md"),
    "---\nchapter: 2\ntitle: Thaw\n---\n\nThe ice sang.\nOdile counted the cakes.\n\nWilfred said nothing.\n",
  );
  const result = readTool(dir, "chapters/02-thaw.md");
  expect(result).toEqual({
    ok: true,
    path: "chapters/02-thaw.md",
    kind: "chapter",
    frontmatter: "chapter: 2\ntitle: Thaw",
    text: "The ice sang. Odile counted the cakes.\n\nWilfred said nothing.",
  });
});

test("read joins the wrapped fixture chapter too", () => {
  const result = readTool(FIXTURE, "chapters/01-the-last-full-cut.md");
  expect(result.ok && result.kind === "chapter" && result.text.startsWith("The pond rang under the horse")).toBe(true);
  if (result.ok && result.kind === "chapter") expect(result.text.split("\n\n").length).toBeGreaterThan(1);
});

test("read returns bible, outline, continuity and research files as written", () => {
  const dir = work();
  writeFileSync(join(dir, "research", "ice.md"), "# Ice\n\nCut in January.\n");
  for (const [path, kind] of [
    ["bible/overview.md", "bible"],
    ["outline/chapters.md", "outline"],
    ["continuity.md", "continuity"],
    ["research/ice.md", "research"],
  ] as const) {
    const result = readTool(dir, path);
    expect(result.ok && "text" in result && result.kind === kind).toBe(true);
  }
});

test("read lists a directory and reports a missing file as a refusal", () => {
  const dir = work();
  const list = readTool(dir, "chapters");
  expect(list.ok && "entries" in list && list.entries).toEqual(["01-the-last-full-cut.md"]);
  const missing = readTool(dir, "bible/nope.md");
  expect(missing.ok).toBe(false);
});

test("read refuses paths outside the work and outside the readable areas", () => {
  const dir = work();
  for (const path of [
    "../../style/prose.md",
    "/etc/passwd",
    "bible/../../../README.md",
    "pablo.json",
    ".pablo/receipts.jsonl",
    "notes/1929-01-09-first-session.md",
    "QWEN.md",
    ".",
  ]) {
    const result = readTool(dir, path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(2);
  }
});

test("read and search do not follow a symlink out of the work", () => {
  const dir = work();
  const away = mkdtempSync(join(tmpdir(), "pablo-harness-away-"));
  dirs.push(away);
  writeFileSync(join(away, "secret.md"), "the ledger of Odile\n");
  symlinkSync(join(away, "secret.md"), join(dir, "bible", "leak.md"));
  rmSync(join(dir, "research"), { recursive: true });
  symlinkSync(away, join(dir, "research"), "dir");
  expect(readTool(dir, "bible/leak.md").ok).toBe(false);
  const found = searchTool(dir, "ledger of Odile");
  expect(found.ok && found.matches).toEqual([]);
});

test("search returns file, line and the matching sentence, case-insensitively", () => {
  const dir = work();
  writeFileSync(
    join(dir, "chapters", "02-thaw.md"),
    "---\nchapter: 2\n---\n\nThe ice sang.\nOdile counted the cakes. Then the water door groaned.\n\nWilfred said nothing.\n",
  );
  const result = searchTool(dir, "WATER DOOR");
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const hit = result.matches.find((m) => m.file === "chapters/02-thaw.md");
  expect(hit).toEqual({ file: "chapters/02-thaw.md", line: 6, sentence: "Then the water door groaned." });
});

test("search finds a phrase wrapped across lines and reports the line it starts on", () => {
  const result = searchTool(FIXTURE, "scale house doorway");
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const hit = result.matches.find((m) => m.file === "chapters/01-the-last-full-cut.md");
  expect(hit?.line).toBe(11);
  expect(hit?.sentence).toContain("scale house doorway");
});

test("search covers the bible and research, not notes or the marker", () => {
  const dir = work();
  writeFileSync(join(dir, "research", "ice.md"), "Marker phrase zebra here.\n");
  writeFileSync(join(dir, "notes", "n.md"), "zebra in notes\n");
  const result = searchTool(dir, "zebra");
  expect(result.ok && result.matches.map((m) => m.file)).toEqual(["research/ice.md"]);
});

test("search refuses an empty phrase and caps its results", () => {
  const dir = work();
  expect(searchTool(dir, "  ").ok).toBe(false);
  mkdirSync(join(dir, "research"), { recursive: true });
  writeFileSync(join(dir, "research", "many.md"), "alpha beta\n".repeat(SEARCH_LIMIT + 5));
  const result = searchTool(dir, "alpha");
  expect(result.ok && result.matches.length).toBe(SEARCH_LIMIT);
  expect(result.ok && result.truncated).toBe(true);
});

test("the read and search verbs resolve the project and carry refusals as exit 2", async () => {
  const vault = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
  const ctx = { cwd: vault, env: { PABLO_VAULT: vault }, stderr: { write: () => {} } };
  const read = VERBS.find((v) => v.name === "read")!;
  const search = VERBS.find((v) => v.name === "search")!;
  const ok = await read.run({ project: "ice-house", path: "outline/chapters.md" }, ctx);
  expect(ok.exitCode).toBe(0);
  const refused = await read.run({ project: "ice-house", path: "../../style/prose.md" }, ctx);
  expect(refused.exitCode).toBe(2);
  const found = await search.run({ project: "ice-house", phrase: "Odile" }, ctx);
  expect(found.exitCode).toBe(0);
});
