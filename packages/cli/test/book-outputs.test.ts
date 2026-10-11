/**
 * AGT-1672: the screen's table of contents is the core's stages, then one group per output the work declares.
 * A stub `radio` output stands in for pablo-casting's (registerOutput); everything runs on a temp copy of the
 * synthetic fixture work. Nothing here draws the screen or reaches a model.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bookRail, writeArgv, writeRequest } from "@openthink/pablo-tui";
import { workBookStages } from "../src/book";
import { NOVEL } from "../src/outputs/novel";
import { registerOutput } from "../src/outputs/registry";
import type { OutputDefinition } from "../src/outputs/types";

const FIXTURE = fileURLToPath(new URL("./fixtures/vault/novels/ice-house", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pablo-book-outputs-"));

/** A second output on the novel's machinery: one episode per core beat, none drafted, only episode 1 ready. */
const RADIO: OutputDefinition = {
  ...NOVEL,
  id: "radio",
  noun: "episode",
  plural: "episodes",
  artifactDir: "outputs/radio/episodes",
  branch: (n) => `draft/radio-ep${String(n).padStart(2, "0")}`,
  unitOfBranch: (b) => {
    const m = /^draft\/radio-ep(\d+)$/.exec(b);
    return m ? Number(m[1]) : undefined;
  },
  preconditions: (_workDir, unit) => (unit === 1 ? { ready: true, missing: [] } : { ready: false, missing: [`episode ${unit - 1} does not exist`] }),
  report: (_workDir, core) => {
    const units = core.beats.map((b) => ({ unit: b.chapter, title: b.title, status: "beat" }));
    return { noun: "episode", plural: "episodes", dir: "outputs/radio/episodes", units, drafted: 0, total: units.length };
  },
};

let off: () => void;
beforeAll(() => { off = registerOutput(RADIO); });
afterAll(() => { off(); rmSync(root, { recursive: true, force: true }); });

function work(name: string, outputs: Record<string, unknown> | undefined): string {
  const dir = join(root, name);
  cpSync(FIXTURE, dir, { recursive: true });
  if (outputs !== undefined) {
    const marker = JSON.parse(readFileSync(join(dir, "pablo.json"), "utf8")) as Record<string, unknown>;
    delete marker["format"];
    writeFileSync(join(dir, "pablo.json"), `${JSON.stringify({ ...marker, outputs }, null, 2)}\n`);
  }
  return dir;
}

const TWO = { novel: { dir: "chapters", added: "2026-09-01" }, radio: { added: "2026-10-12" } };

test("a two-output work's rail is the core's stages, then a group per output with its units", () => {
  const stages = workBookStages(work("two", TWO));
  const roots = stages.filter((s) => s.depth === 0).map((s) => s.id);
  expect(roots).toEqual(["premise", "research", "bible", "acts", "beats", "chapters", "output:radio"]);
  expect(stages.filter((s) => s.output === "radio" && s.depth === 1).map((s) => [s.id, s.status])).toEqual([
    ["unit:radio:1", "ready"], ["unit:radio:2", "missing"], ["unit:radio:3", "missing"], ["unit:radio:4", "missing"],
  ]);
  const rail = bookRail(stages);
  expect(rail.rows.map((r) => r.id)).toContain("output:radio");
  expect(rail.outputOf["chapter:2"]).toBe("novel");
  expect(rail.outputOf["unit:radio:3"]).toBe("radio");
  expect(rail.outputOf["beats"]).toBeUndefined();
  expect(rail.counts["radio"]).toEqual({ drafted: 0, total: 4 });
  expect(rail.counts["novel"]).toEqual({ drafted: 1, total: 4 });
});

test("a radio unit waiting on its draft branch shows as waiting, and a missing one says why", () => {
  const stages = workBookStages(work("waiting", TWO), ["draft/radio-ep03"]);
  expect(stages.find((s) => s.id === "unit:radio:3")).toMatchObject({ status: "waiting", branch: "draft/radio-ep03" });
  expect(stages.find((s) => s.id === "unit:radio:2")).toMatchObject({ status: "missing", missing: ["episode 1 does not exist"] });
});

test("a work declaring only radio has no chapters group; one declaring nothing shows the novel's", () => {
  expect(workBookStages(work("radio-only", { radio: { added: "2026-10-12" } })).filter((s) => s.depth === 0).map((s) => s.id))
    .toEqual(["premise", "research", "bible", "acts", "beats", "output:radio"]);
  expect(workBookStages(work("legacy", undefined)).some((s) => s.id === "chapters")).toBe(true);
});

test("`a w` on radio › 3 is `write --output radio --unit 3`; on the novel's chapter 2 it is the novel's unit 2; on a core stage or group it is nothing", () => {
  const rail = bookRail(workBookStages(work("write", TWO)));
  const request = writeRequest(rail, "unit:radio:3");
  expect(request).toEqual({ output: "radio", unit: 3 });
  expect(writeArgv(request!)).toEqual(["write", "--output", "radio", "--unit", "3"]);
  expect(writeRequest(rail, "chapter:2")).toEqual({ output: "novel", unit: 2 });
  expect(writeRequest(rail, "premise")).toBeUndefined();
  expect(writeRequest(rail, "output:radio")).toBeUndefined();
  expect(writeRequest(rail, undefined)).toBeUndefined();
});
