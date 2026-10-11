// The beats and continuity shims (AGT-1666): the new name wins when it exists, else the old one.

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beatsFile, continuityFile } from "../src";

test("an unmigrated work (or an empty one) resolves to the old names", () => {
  const work = mkdtempSync(join(tmpdir(), "pablo-work-paths-"));
  expect(beatsFile(work)).toBe("outline/chapters.md");
  expect(continuityFile(work)).toBe("continuity.md");
  mkdirSync(join(work, "outline"));
  writeFileSync(join(work, "outline", "chapters.md"), "x");
  writeFileSync(join(work, "continuity.md"), "x");
  expect(beatsFile(work)).toBe("outline/chapters.md");
  expect(continuityFile(work)).toBe("continuity.md");
  rmSync(work, { recursive: true, force: true });
});

test("a migrated work resolves to outline/beats.md and outputs/novel/continuity.md", () => {
  const work = mkdtempSync(join(tmpdir(), "pablo-work-paths-"));
  mkdirSync(join(work, "outline"));
  mkdirSync(join(work, "outputs", "novel"), { recursive: true });
  writeFileSync(join(work, "outline", "beats.md"), "x");
  writeFileSync(join(work, "outputs", "novel", "continuity.md"), "x");
  expect(beatsFile(work)).toBe("outline/beats.md");
  expect(continuityFile(work)).toBe("outputs/novel/continuity.md");
  rmSync(work, { recursive: true, force: true });
});
