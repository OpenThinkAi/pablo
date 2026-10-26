/**
 * The output registry (AGT-1668): every registered type passes the
 * conformance run over a four-beat fixture with a fake writer; a type missing
 * a field fails naming it; `OUTPUTS.novel` is today's novel; and no file
 * under `packages/cli/src` outside `outputs/novel/` names the novel's
 * artifact directory itself.
 */

import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { readMarker } from "../src/marker";
import { ConformanceError, missingFields, runConformance } from "../src/outputs/conformance";
import { NOVEL } from "../src/outputs/novel";
import { OUTPUTS, outputDefinition, outputForWork, outputIds, workOutput } from "../src/outputs/registry";
import type { OutputDefinition } from "../src/outputs/types";
import { isTrackId, TRACKS, trackIds } from "../src/tracks/registry";

const FIXTURE = join(import.meta.dir, "fixtures", "conformance");
const SRC = join(import.meta.dir, "..", "src");
const NO_THINK_PATH = "/usr/bin:/bin";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
}

/** The fixture vault copied to a temp git repository; returns the vault and the work. */
function fixture(): { vault: string; work: string } {
  const vault = mkdtempSync(join(tmpdir(), "pablo-outputs-"));
  dirs.push(vault);
  cpSync(FIXTURE, vault, { recursive: true });
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "pablo-test@example.com");
  git(vault, "config", "user.name", "Pablo Test");
  git(vault, "config", "commit.gpgsign", "false");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  return { vault, work: join(vault, "novels", "four-beats") };
}

const fakeWriter = (prompt: string, unit: number): string => `Unit ${unit} begins.\nThe prompt ran ${prompt.length} characters.`;

async function conform(def: unknown) {
  const { vault, work } = fixture();
  const marker = readMarker(work);
  if (!marker.ok) throw new Error(marker.message);
  return runConformance(def, {
    vaultRoot: vault,
    workDir: work,
    marker: marker.marker,
    writer: fakeWriter,
    env: { PATH: NO_THINK_PATH },
    now: () => new Date("2026-10-10T12:00:00Z"),
  });
}

for (const id of outputIds()) {
  test(`OUTPUTS.${id} passes the conformance run over the four-beat fixture`, async () => {
    const report = await conform(outputDefinition(id));
    expect(report.units).toEqual(id === "story" ? [1] : [1, 2, 3, 4]);
    expect(existsSync(report.published)).toBe(true);
  });
}

test("the conformance run leaves the novel's units, rituals and publish where today's novel does", async () => {
  const { vault, work } = fixture();
  const marker = readMarker(work);
  if (!marker.ok) throw new Error(marker.message);
  const report = await runConformance(OUTPUTS.novel, {
    vaultRoot: vault,
    workDir: work,
    marker: marker.marker,
    writer: fakeWriter,
    env: { PATH: NO_THINK_PATH },
    now: () => new Date("2026-10-10T12:00:00Z"),
  });
  expect(readdirSync(join(work, "chapters")).sort()).toEqual(["01-the-letter.md", "02-the-engineer.md", "03-the-storm.md", "04-the-last-watch.md"]);
  expect(report.rituals.map((r) => `${r.name}:${r.status}`).slice(0, 6)).toEqual([
    "outline:ran",
    "note:ran",
    "readme:ran",
    "continuity:skipped",
    "git:ran",
    "think:skipped",
  ]);
  expect(readFileSync(join(work, "outline", "beats.md"), "utf8")).not.toContain("| outline |");
  expect(report.published).toBe(join(work, ".pablo", "out", "four-beats-draft.md"));
  expect(readFileSync(report.published, "utf8")).toContain("## Chapter 4");
});

test("a deliberately incomplete type fails conformance naming the missing field", async () => {
  const { pack: _pack, ...noPack } = NOVEL;
  expect(missingFields(noPack)).toEqual(["pack"]);
  await expect(conform({ ...noPack, id: "half" })).rejects.toThrow(ConformanceError);
  await expect(conform({ ...noPack, id: "half" })).rejects.toThrow(/output type "half" fails conformance at "pack"/);

  const noAfterMerge = { ...NOVEL, id: "half", rituals: { afterRevision: NOVEL.rituals.afterRevision } };
  await expect(conform(noAfterMerge)).rejects.toThrow(/at "rituals\.afterMerge"/);
  expect(missingFields({ ...NOVEL, artifactDir: "" })).toEqual(["artifactDir"]);
  expect(missingFields({ ...NOVEL, tracks: [] })).toEqual(["tracks"]);
  expect(missingFields({ ...NOVEL, publish: { targets: [], run: NOVEL.publish.run } })).toEqual(["publish.targets"]);
});

test("a type whose steps misbehave fails conformance naming the step", async () => {
  const neverReady: OutputDefinition = { ...NOVEL, id: "stuck", preconditions: () => ({ ready: false, missing: ["never"] }) };
  await expect(conform(neverReady)).rejects.toThrow(/"stuck" fails conformance at "preconditions"/);
  const badBranch: OutputDefinition = { ...NOVEL, id: "lost", unitOfBranch: () => undefined };
  await expect(conform(badBranch)).rejects.toThrow(/"lost" fails conformance at "unitOfBranch"/);
});

test("OUTPUTS.novel is today's novel: chapters/, one chapter per beat, draft/chNN, the three publish targets", () => {
  const { work } = fixture();
  expect(OUTPUTS.novel).toBe(NOVEL);
  expect(NOVEL.id).toBe("novel");
  expect(NOVEL.artifactDir).toBe("chapters");
  expect(NOVEL.noun).toBe("chapter");
  expect(NOVEL.plural).toBe("chapters");
  expect(NOVEL.publish.targets).toEqual(["draft", "review", "final"]);
  expect(NOVEL.branch(3)).toBe("draft/ch03");
  expect(NOVEL.unitOfBranch("draft/ch12-v2")).toBe(12);
  expect(NOVEL.unitOfBranch("revise/ch02-tighten")).toBeUndefined();
  expect(NOVEL.unitOfPath("novels/x/chapters/07-the-well.md")).toBe(7);
  expect(NOVEL.unitOfPath("novels/x/bible/07-the-well.md")).toBeUndefined();
  expect(NOVEL.unitFileName(2, "The Engineer!")).toBe("02-the-engineer.md");
  expect(NOVEL.plan(work)).toEqual([
    { unit: 1, title: "The Letter", beats: [1], status: "beat" },
    { unit: 2, title: "The Engineer", beats: [2], status: "beat" },
    { unit: 3, title: "The Storm", beats: [3], status: "beat" },
    { unit: 4, title: "The Last Watch", beats: [4], status: "beat" },
  ]);
  expect(NOVEL.preconditions(work, 2)).toEqual({ ready: false, missing: ["chapter 1 is not written"] });
  expect(NOVEL.rulesTemplate.startsWith("# Novel rules")).toBe(true);
});

test("the work's output is the one its marker declares, and the novel for a work that declares none", () => {
  expect(workOutput({ novel: { added: "2026-10-10" } })).toBe(OUTPUTS.novel);
  expect(workOutput({})).toBe(OUTPUTS.novel);
  const { work } = fixture();
  expect(outputForWork(work)).toBe(OUTPUTS.novel);
  expect(outputForWork(join(work, "no-such-work"))).toBe(OUTPUTS.novel);
});

test("nothing under packages/cli/src outside outputs/novel/ names the novel's chapter directory", () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(SRC, path).split(sep).join("/");
      if (statSync(path).isDirectory()) {
        if (rel !== "outputs/novel") walk(path);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((line, i) => {
          // `chapters/` as written, or regex-escaped (`chapters\/`), or the bare directory joined into a path.
          if (/chapters\\?\//.test(line) || /join\([^)]*["'`]chapters["'`]/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
  };
  walk(SRC);
  expect(offenders).toEqual([]);
});

test("every output declares at least one track, each a known track, and the track registry agrees (D-7)", () => {
  for (const id of outputIds()) {
    const def = outputDefinition(id) as OutputDefinition;
    expect(def.tracks.length).toBeGreaterThan(0);
    for (const track of def.tracks) expect(isTrackId(track)).toBe(true);
    for (const track of trackIds()) expect((TRACKS[track].outputs as readonly string[]).includes(id)).toBe(def.tracks.includes(track));
  }
  for (const id of ["novel", "story", "radio"]) expect(outputDefinition(id)?.tracks).toEqual(["fiction", "historical-fiction"]);
});
