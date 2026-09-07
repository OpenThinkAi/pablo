import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveCliOptions, parseForChapter, VERBS } from "../src/verbs";
import type { VerbContext } from "../src/verbs";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));

/** No `think` on PATH — `resume` shells out to it and this suite never wants a real network call. */
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");

function tempVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-verbs-test-"));
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  return vault;
}

function ctxFor(vault: string): VerbContext {
  return { cwd: vault, env: { PABLO_VAULT: vault, PATH: NO_THINK_PATH }, stderr: { write: () => {} } };
}

function verb(name: string) {
  const found = VERBS.find((v) => v.name === name);
  if (found === undefined) throw new Error(`no such verb: ${name}`);
  return found;
}

test("VERBS exposes exactly the five MCP verbs, each requiring project", () => {
  expect(VERBS.map((v) => v.name).sort()).toEqual(["check", "resume", "save", "status", "write"]);
  for (const v of VERBS) {
    const parsed = v.args.safeParse({});
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path[0] === "project")).toBe(true);
    }
  }
});

// Pinned explicitly (per the ticket) so any future verb.ts change that adds,
// renames, or retypes an option is caught here rather than silently drifting
// cli.ts's argv table away from what pablo mcp's tool schemas accept.
test("deriveCliOptions matches the exact option set cli.ts accepted before this ticket", () => {
  expect(deriveCliOptions()).toEqual({
    project: { type: "string" },
    for: { type: "string" },
    chapter: { type: "string" },
    words: { type: "string" },
    scenes: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    stage: { type: "string" },
    file: { type: "string" },
  });
});

test("parseForChapter accepts chapter N, chapter-N, ch N and a bare N", () => {
  expect(parseForChapter("chapter 3")).toBe(3);
  expect(parseForChapter("chapter-3")).toBe(3);
  expect(parseForChapter("ch 3")).toBe(3);
  expect(parseForChapter("3")).toBe(3);
  expect(parseForChapter("bogus")).toBeUndefined();
});

test("resume.run on an unknown project returns a refusal body, not a throw", async () => {
  const vault = tempVault();

  const outcome = await verb("resume").run({ project: "nope" }, ctxFor(vault));

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });
  expect((outcome.body as { tried: unknown[] }).tried).toBeInstanceOf(Array);

  rmSync(vault, { recursive: true, force: true });
});

test("resume.run on ice-house returns the resume summary shape, exit 0", async () => {
  const vault = tempVault();

  const outcome = await verb("resume").run({ project: "ice-house" }, ctxFor(vault));

  expect(outcome.exitCode).toBe(0);
  expect(outcome.body).toMatchObject({ format: "novel", title: "The Ice House" });

  rmSync(vault, { recursive: true, force: true });
});

test("status.run with no for returns the novel machine's state, exit 0", async () => {
  const vault = tempVault();

  const outcome = await verb("status").run({ project: "ice-house" }, ctxFor(vault));

  expect(outcome.exitCode).toBe(0);
  expect(outcome.body).toMatchObject({ premise: true });

  rmSync(vault, { recursive: true, force: true });
});

test('status.run with for "chapter 3" returns {ready:false, missing[]}, exit 2', async () => {
  const vault = tempVault();

  const outcome = await verb("status").run({ project: "ice-house", for: "chapter 3" }, ctxFor(vault));

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toEqual({
    ready: false,
    missing: ["chapter 2 is not written", "Mrs. Frayne still has a [pick] in bible/characters/family-tree.md"],
  });

  rmSync(vault, { recursive: true, force: true });
});

test("status.run on an unknown project refuses before touching for", async () => {
  const vault = tempVault();

  const outcome = await verb("status").run({ project: "nope" }, ctxFor(vault));

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });

  rmSync(vault, { recursive: true, force: true });
});

test("check.run on ice-house returns {ok:true, hits[], unprovenanced[]}, exit 0", async () => {
  const vault = tempVault();

  const outcome = await verb("check").run({ project: "ice-house" }, ctxFor(vault));

  expect(outcome.exitCode).toBe(0);
  const body = outcome.body as { ok: boolean; hits: unknown[]; unprovenanced: unknown[] };
  expect(body.ok).toBe(true);
  expect(Array.isArray(body.hits)).toBe(true);
  expect(Array.isArray(body.unprovenanced)).toBe(true);

  rmSync(vault, { recursive: true, force: true });
});

test("write.run with dry-run true returns a prompt_hash, without printing to real stdout", async () => {
  const vault = tempVault();

  const outcome = await verb("write").run({ project: "ice-house", chapter: 2, "dry-run": true }, ctxFor(vault));

  expect(outcome.exitCode).toBe(0);
  expect(outcome.body).toMatchObject({ ok: true, dryRun: true });
  expect(typeof (outcome.body as { prompt_hash: string }).prompt_hash).toBe("string");

  rmSync(vault, { recursive: true, force: true });
});

test("write.run restores console.log even when runWrite's underlying call throws", async () => {
  const vault = tempVault();
  const originalLog = console.log;

  // chapter 3's preconditions are unmet on the fixture (see the status test
  // above) — runWrite refuses (not a throw) here, but this also exercises
  // that console.log is back to normal immediately after the call either way.
  await verb("write").run({ project: "ice-house", chapter: 3, "dry-run": true }, ctxFor(vault));

  expect(console.log).toBe(originalLog);

  rmSync(vault, { recursive: true, force: true });
});

test("save.run without file refuses (no stdin to read in an MCP tool call)", async () => {
  const vault = tempVault();

  const outcome = await verb("save").run({ project: "ice-house" }, ctxFor(vault));

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });
  expect((outcome.body as { message: string }).message).toContain("stdin");

  rmSync(vault, { recursive: true, force: true });
});

// AGT-1235 review finding: `file` is model-controlled over MCP, so a path
// outside the vault must be refused before ever being read, never a silent
// exfiltration path (e.g. a compromised/prompt-injected caller reading an
// SSH key into a committed vault document).
test("save.run with a file outside the vault refuses (exit 2), naming the vault boundary", async () => {
  const vault = tempVault();

  const outcome = await verb("save").run({ project: "ice-house", stage: "premise", file: "/etc/hosts" }, ctxFor(vault));

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });
  expect((outcome.body as { message: string }).message).toContain("inside the vault");

  rmSync(vault, { recursive: true, force: true });
});

test("save.run with a relative file that escapes the vault via .. also refuses", async () => {
  const vault = tempVault();

  const outcome = await verb("save").run(
    { project: "ice-house", stage: "premise", file: "../../../../../../etc/hosts" },
    ctxFor(vault),
  );

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });
  expect((outcome.body as { message: string }).message).toContain("inside the vault");

  rmSync(vault, { recursive: true, force: true });
});

test("two concurrent write.run dry-run calls each get their own correct body (no console.log interleaving)", async () => {
  const vault = tempVault();

  const [a, b] = await Promise.all([
    verb("write").run({ project: "ice-house", chapter: 2, "dry-run": true }, ctxFor(vault)),
    verb("write").run({ project: "ice-house", chapter: 2, "dry-run": true }, ctxFor(vault)),
  ]);

  for (const outcome of [a, b]) {
    expect(outcome.exitCode).toBe(0);
    expect(outcome.body).toMatchObject({ ok: true, dryRun: true });
    expect(typeof (outcome.body as { prompt_hash: string }).prompt_hash).toBe("string");
  }

  rmSync(vault, { recursive: true, force: true });
});
