// AGT-2097 (D-16): `pablo <verb> --help` and `pablo help <verb>` print one verb's usage, flags and an example.
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { ALL_VERBS } from "../src/cli";
import { usageFor, verbHelp } from "../src/help";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync(["bun", "run", CLI, ...args], { env: { ...process.env } });
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode };
}

test("every verb in ALL_VERBS has per-verb help with usage and an example", () => {
  for (const verb of ALL_VERBS) {
    const text = verbHelp(verb, ALL_VERBS);
    expect(text, verb).toBeDefined();
    expect(text, verb).toContain("Usage:");
    expect(text, verb).toContain("Example:");
    expect(usageFor(verb).length, `${verb} has a usage line`).toBeGreaterThan(0);
  }
});

test("resume, save, search, mcp and read each have a usage line", () => {
  for (const verb of ["resume", "save", "search", "mcp", "read"]) {
    expect(usageFor(verb)[0], verb).toContain(`pablo ${verb}`);
  }
  expect(usageFor("read")[0]).toContain("<path>");
  expect(usageFor("search")[0]).toContain("<phrase...>");
});

test("a verb's help holds only its own usage", () => {
  const text = verbHelp("write", ALL_VERBS)!;
  expect(text).toContain("pablo write --project");
  expect(text).not.toContain("pablo bind");
  expect(text).not.toContain("pablo voice new");
});

test("`pablo <verb> --help` and `pablo help <verb>` print the same per-verb help", () => {
  for (const verb of ["story", "research", "read", "gate"]) {
    const a = runCli([verb, "--help"]);
    const b = runCli(["help", verb]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).toContain(`pablo ${verb}`);
    expect(a.stdout).not.toContain("Verbs:");
  }
});

test("an unknown verb with --help or via help exits non-zero naming it", () => {
  for (const args of [["research2", "--help"], ["help", "nonesuch"]]) {
    const r = runCli(args);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout + r.stderr).toContain(args[0] === "help" ? "nonesuch" : "research2");
  }
});

test("`pablo help` alone still prints the global help", () => {
  const r = runCli(["help"]);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("Verbs:");
});

test("every verb named in --help is runnable, and dry-run is not a verb (AGT-2098)", () => {
  const help = runCli(["--help"]).stdout;
  const listed = help.split("Verbs:\n")[1]!.split("\n\n")[0]!.split("\n").map((l) => l.trim());
  expect(listed).toEqual([...ALL_VERBS]);
  expect(listed).toContain("describe_voice");
  expect(listed).not.toContain("dry-run");
  // Verbs that start servers, windows or provision the casting side are checked through their per-verb help instead.
  for (const verb of listed) {
    const r = runCli([verb, "--help"]);
    expect(r.exitCode, verb).toBe(0);
    expect(r.stdout + r.stderr, verb).not.toContain("unknown verb");
  }
  const dry = runCli(["dry-run"]);
  expect(dry.exitCode).not.toBe(0);
  expect(dry.stdout + dry.stderr).toContain("write --dry-run");
}, 60_000);

// AGT-2193: help text matches what the verbs do.
test("help save says it commits to the current branch and explains the outline #N convention", () => {
  const text = verbHelp("save", ALL_VERBS)!;
  expect(text).toContain("committed straight to the work's");
  expect(text).not.toContain("plan/ branch");
  expect(text).toContain("#2, #3");
});

test("help check names anachronism and claim-support", () => {
  const text = verbHelp("check", ALL_VERBS)!;
  expect(text).toContain("anachronism");
  expect(text).toContain("claim-support");
  expect(text).toContain("fact-accuracy");
});
