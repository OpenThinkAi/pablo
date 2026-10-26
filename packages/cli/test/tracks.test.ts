import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_STAGE_IDS, coreStages, readCoreState } from "../src/core/machine";
import { readMarker, trackOf, writeMarker } from "../src/marker";
import { buildResume, formatResumeProse } from "../src/resume";
import { DEFAULT_TRACK, TRACKS, isTrackId, trackDefinition, trackIds } from "../src/tracks/registry";
import { formatStatusProse, readWorkStatus } from "../src/work-state";

/** The synthetic fixture novel (no `track` in its pablo.json). */
const WORK = fileURLToPath(new URL("./fixtures/vault/novels/ice-house", import.meta.url));
const NO_THINK = { env: { PATH: "/nonexistent-bin-for-tracks-test" } };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pablo-tracks-test-"));
}

function tempWork(): { root: string; work: string } {
  const root = tempDir();
  const work = join(root, "ice-house");
  cpSync(WORK, work, { recursive: true });
  return { root, work };
}

function setTrack(work: string, track: unknown): void {
  const path = join(work, "pablo.json");
  const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...data, track }));
}

test("TRACKS has fiction, historical-fiction and nonfiction, each row keyed by its own id", () => {
  expect(trackIds()).toEqual(["fiction", "historical-fiction", "nonfiction"]);
  for (const id of trackIds()) {
    const def = trackDefinition(id);
    expect(def.id).toBe(id);
    expect(def.coreStages.length).toBeGreaterThan(0);
    expect(def.policy).toBe(id);
    expect(def.checks.length).toBeGreaterThan(0);
    expect(def.outputs.length).toBeGreaterThan(0);
  }
  expect(DEFAULT_TRACK).toBe("fiction");
});

test("fiction's core stages are today's core machine's stages", () => {
  expect([...TRACKS.fiction.coreStages]).toEqual([...CORE_STAGE_IDS]);
  expect(coreStages(readCoreState(WORK)).map((s) => s.id)).toEqual([...TRACKS.fiction.coreStages]);
});

test("the track rows follow the design table (D-5, D-7)", () => {
  const hist = TRACKS["historical-fiction"];
  expect(hist.coreStages).toEqual(["premise", "period", "research", "period-facts", "bible", "acts", "beats", "facts"]);
  expect(hist.checks).toEqual(["continuity", "story-time", "unknown-name", "fact-accuracy", "anachronism"]);
  expect(TRACKS.nonfiction.coreStages).toEqual(["thesis", "research", "claims", "outline"]);
  expect(TRACKS.nonfiction.checks).toEqual(["claim-support", "citations"]);
  for (const id of trackIds()) {
    expect(trackDefinition(id).outputs).toContain("essay");
    expect(trackDefinition(id).outputs).toContain("narrated");
  }
  expect(TRACKS.nonfiction.outputs).not.toContain("novel");
  expect(TRACKS.fiction.outputs).toContain("novel");
  expect(hist.outputs).toContain("radio");
});

test("isTrackId accepts the ids and nothing else", () => {
  expect(isTrackId("fiction")).toBe(true);
  expect(isTrackId("historical-fiction")).toBe(true);
  expect(isTrackId("nonfiction")).toBe(true);
  expect(isTrackId("poetry")).toBe(false);
  expect(isTrackId("toString")).toBe(false);
  expect(isTrackId(3)).toBe(false);
});

test("a marker without track reads as fiction, and a rewrite leaves it without one", () => {
  const { root, work } = tempWork();
  const result = readMarker(work);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.marker.track).toBeUndefined();
    expect(trackOf(result.marker)).toBe("fiction");
    writeMarker(work, result.marker);
    expect(JSON.parse(readFileSync(join(work, "pablo.json"), "utf8"))).not.toHaveProperty("track");
  }
  rmSync(root, { recursive: true, force: true });
});

test("a marker's track is read as written for every known id", () => {
  const { root, work } = tempWork();
  for (const id of trackIds()) {
    setTrack(work, id);
    const result = readMarker(work);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.marker.track).toBe(id);
      expect(trackOf(result.marker)).toBe(id);
    }
  }
  rmSync(root, { recursive: true, force: true });
});

test("an unknown track is a refusal naming the allowed ids", () => {
  const { root, work } = tempWork();
  for (const bad of ["poetry", 3, null, ""]) {
    setTrack(work, bad);
    const result = readMarker(work);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(2);
      expect(result.message).toContain(`unknown track ${JSON.stringify(bad)}`);
      expect(result.message).toContain("allowed: fiction, historical-fiction, nonfiction");
    }
  }
  rmSync(root, { recursive: true, force: true });
});

test("status and resume report the work's track (fiction by default)", async () => {
  const status = readWorkStatus(WORK);
  expect(status.track).toBe("fiction");
  expect(formatStatusProse(status).split("\n")).toContain("track: fiction");

  const resume = await buildResume(WORK, "ice-house", NO_THINK);
  expect(resume.track).toBe("fiction");
  const lines = formatResumeProse(resume).split("\n");
  expect(lines[lines.indexOf("novel: 1 of 4 chapters drafted") + 1]).toBe("track: fiction");
});

test("status and resume report a declared track", async () => {
  const { root, work } = tempWork();
  setTrack(work, "historical-fiction");

  const status = readWorkStatus(work);
  expect(status.track).toBe("historical-fiction");
  expect(formatStatusProse(status)).toContain("track: historical-fiction");

  const resume = await buildResume(work, "ice-house", NO_THINK);
  expect(resume.track).toBe("historical-fiction");
  expect(formatResumeProse(resume)).toContain("track: historical-fiction");

  rmSync(root, { recursive: true, force: true });
});
