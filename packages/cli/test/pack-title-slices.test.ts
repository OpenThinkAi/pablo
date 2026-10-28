/**
 * AGT-2189: a pack's working title is `pablo.json`'s, a screenplay pack drops the prose-only slices, a plain
 * fiction track sends no period slice, and an essay pack leaves out `<!-- fiction-only -->` style rules.
 */
import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readMarker } from "../src/marker";
import { buildChapterPack } from "../src/novel/pack";
import { buildScreenplayPack } from "../src/outputs/screenplay/pack";

const FIXTURE = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FICTION_ONLY = "Dialogue tags are said, never hissed.";

function setup(track?: string): { vault: string; work: string } {
  const root = mkdtempSync(join(tmpdir(), "pablo-title-slices-"));
  dirs.push(root);
  const vault = join(root, "vault");
  cpSync(FIXTURE, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  const rules = join(work, "QWEN.md");
  const text = readFileSync(rules, "utf8")
    .replace(/^# .*$/m, "# Ice House: the work's rules")
    .replace("## Point of view and voice", `## Dialogue\n\n<!-- fiction-only -->\n${FICTION_ONLY}\n<!-- /fiction-only -->\n\n## Point of view and voice`);
  writeFileSync(rules, text);
  if (track !== undefined) {
    const markerPath = join(work, "pablo.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    marker.track = track;
    writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  }
  return { vault, work };
}

function markerOf(work: string) {
  const result = readMarker(work);
  if (!result.ok) throw new Error(result.message);
  return result.marker;
}

test("AC1: the working title is pablo.json's title, not STYLE.md's heading", () => {
  const { vault, work } = setup();
  const packed = buildChapterPack(vault, work, 2, { marker: markerOf(work) });
  if (!packed.ok) throw new Error(packed.message);
  expect(packed.pack.prompt).toContain('working title "The Ice House"');
  expect(packed.pack.prompt).not.toContain("the work's rules");
});

test("AC2: a screenplay pack has no POV line or chapter wording, and asks for one scene", () => {
  const { vault, work } = setup("historical-fiction");
  mkdirSync(join(work, "outputs", "screenplay"), { recursive: true });
  const packed = buildScreenplayPack(vault, work, 1, { marker: markerOf(work), output: "screenplay" });
  if (!packed.ok) throw new Error(packed.message);
  const prompt = packed.pack.prompt;
  // The author's own rule text may say "point of view"; pablo's wording in its slices may not.
  const own = packed.pack.slices.filter((s) => ["brief", "chapter", "direction", "timeline", "previousTail", "task"].includes(s.name));
  const text = [...own.map((s) => `${s.heading}\n${s.text}`)].join("\n");
  expect(text).not.toMatch(/point of view/i);
  expect(text).not.toMatch(/\bchapter\b/i);
  // The period slice is the period section alone, not every rule after it.
  expect(packed.pack.slices.find((s) => s.name === "period")?.text ?? "").not.toMatch(/point of view/i);
  expect(prompt).not.toMatch(/at least \d+ scenes/);
  expect(prompt).toContain("Write the scene now: one scene");
});

test("AC3: an explicit fiction track sends no period slice; historical-fiction and track-less works keep it", () => {
  const plain = setup("fiction");
  const fiction = buildChapterPack(plain.vault, plain.work, 2, { marker: markerOf(plain.work) });
  if (!fiction.ok) throw new Error(fiction.message);
  expect(fiction.pack.slices.map((s) => s.name)).not.toContain("period");

  // A marker with no `track` key predates tracks: its period section keeps going out.
  const legacy = setup();
  const old = buildChapterPack(legacy.vault, legacy.work, 2, { marker: markerOf(legacy.work) });
  if (!old.ok) throw new Error(old.message);
  expect(old.pack.slices.map((s) => s.name)).toContain("period");

  const historical = setup("historical-fiction");
  const kept = buildChapterPack(historical.vault, historical.work, 2, { marker: markerOf(historical.work) });
  if (!kept.ok) throw new Error(kept.message);
  expect(kept.pack.slices.map((s) => s.name)).toContain("period");
});

test("AC4: fiction-only style rules reach the novel (fence lines stripped) but never an essay pack", () => {
  const { vault, work } = setup();
  const novel = buildChapterPack(vault, work, 2, { marker: markerOf(work) });
  if (!novel.ok) throw new Error(novel.message);
  expect(novel.pack.prompt).toContain(FICTION_ONLY);
  expect(novel.pack.prompt).not.toContain("fiction-only");

  const essay = buildChapterPack(vault, work, 2, { marker: markerOf(work), output: "essay" });
  if (!essay.ok) throw new Error(essay.message);
  expect(essay.pack.prompt).not.toContain(FICTION_ONLY);
  expect(essay.pack.prompt).not.toContain("fiction-only");
  expect(essay.pack.prompt).toContain("Point of view");
});
