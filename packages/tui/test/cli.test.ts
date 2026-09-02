import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/cli";
import { USAGE } from "../src/usage";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const directory = mkdtempSync(join(tmpdir(), "pablo-cli-"));
const chapter = join(directory, "chapter-01.md");
writeFileSync(chapter, "# One\n\nThe cellar.\n", "utf8");

afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function run(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

test("the pablo bin prints usage and exits 0", async () => {
  const { code, stdout } = await run([]);

  expect(code).toBe(0);
  expect(stdout).toBe(USAGE);
});

test("usage states the invariant, so nobody has to read the design doc to learn it", () => {
  expect(USAGE).toContain("The model has no write tool");
});

test("usage documents the keys, and none of them is a function key", () => {
  expect(USAGE).toContain("pablo chapter.md   open the manuscript view");
  expect(USAGE).toContain("no action needs a function key or a number key");
  expect(USAGE).not.toMatch(/\bF\d{1,2}\b/);
});

test("parseArgs routes the three forms", () => {
  expect(parseArgs([])).toEqual({ kind: "usage" });
  expect(parseArgs(["--help"])).toEqual({ kind: "usage" });
  expect(parseArgs([chapter])).toEqual({ kind: "open", path: chapter });
  expect(parseArgs([chapter, chapter]).kind).toBe("error");
  expect(parseArgs(["--colour"]).kind).toBe("error");
  expect(parseArgs([join(directory, "nope.md")]).kind).toBe("error");
  expect(parseArgs([directory]).kind).toBe("error");
});

test("a missing file is an error, not an empty view", async () => {
  const { code, stderr } = await run([join(directory, "nope.md")]);

  expect(code).toBe(2);
  expect(stderr).toContain("no such file");
});

test("the view refuses to open without a terminal instead of hanging", async () => {
  const { code, stderr } = await run([chapter]);

  expect(code).toBe(1);
  expect(stderr).toContain("needs a terminal");
});
