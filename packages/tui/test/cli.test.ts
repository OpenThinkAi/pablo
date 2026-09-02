import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { USAGE } from "../src/usage";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("the pablo bin prints usage and exits 0", async () => {
  const proc = Bun.spawn(["bun", CLI], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();

  expect(await proc.exited).toBe(0);
  expect(stdout).toBe(USAGE);
});

test("usage states the invariant, so nobody has to read the design doc to learn it", () => {
  expect(USAGE).toContain("The model has no write tool");
});
