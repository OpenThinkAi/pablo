import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** One of `voice`'s AGT-1245 `mcpTools` (voice_list/voice_show/voice_flag/voice_exemplar) — `verbs.test.ts`'s own in-process complement to `mcp.test.ts`'s full stdio round trip. */
function voiceMcpTool(name: string) {
  const tools = verb("voice").mcpTools ?? [];
  const found = tools.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no such voice mcpTool: ${name}`);
  return found;
}

test("VERBS exposes exactly the eight MCP verbs, each project-scoped verb requiring project", () => {
  expect(VERBS.map((v) => v.name).sort()).toEqual(["check", "prose", "resume", "review", "save", "status", "voice", "write"]);
  for (const v of VERBS) {
    if (v.name === "voice" || v.name === "prose" || v.name === "review") continue; // none resolves via a --project slug (AGT-1240, AGT-1241, AGT-1261 — the review queue is global)
    const parsed = v.args.safeParse({});
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path[0] === "project")).toBe(true);
    }
  }
});

test("review's args require action, but not project", () => {
  const review = verb("review");
  expect(review.args.safeParse({}).success).toBe(false);
  expect(review.args.safeParse({ action: "list" }).success).toBe(true);
  expect("project" in review.args.shape).toBe(false);
});

// AGT-1261 security review finding: the review queue is a human checkpoint
// on pablo's own output, so a model connected over MCP must never be able to
// clear it itself — `review`'s `mcpTools` narrows to one tool covering only
// list/show/wait; `approve`/`reject` stay reachable from the CLI only.
test("review's mcpTools narrows to list/show/wait — approve/reject are not in its schema's action enum", () => {
  const tools = verb("review").mcpTools;
  expect(tools).toBeDefined();
  expect(tools!.map((t) => t.name)).toEqual(["review"]);

  const mcpReview = tools![0]!;
  for (const action of ["list", "show", "wait"]) {
    expect(mcpReview.args.safeParse({ action }).success).toBe(true);
  }
  for (const action of ["approve", "reject", "bogus"]) {
    expect(mcpReview.args.safeParse({ action }).success).toBe(false);
  }
  // No `unread`/`reason` either — those only make sense for approve/reject.
  expect(Object.keys(mcpReview.args.shape).sort()).toEqual(["action", "all", "id", "timeout"]);
});

test("review's mcpTools run rejects an approve/reject action at the schema level, before run ever executes", () => {
  const mcpReview = verb("review").mcpTools![0]!;
  expect(mcpReview.args.safeParse({ action: "approve", id: "x" }).success).toBe(false);
  expect(mcpReview.args.safeParse({ action: "reject", id: "x" }).success).toBe(false);
  expect(mcpReview.args.safeParse({ action: "list" }).success).toBe(true);
});

test("voice's args require sub, but not project", () => {
  const voice = verb("voice");
  expect(voice.args.safeParse({}).success).toBe(false);
  expect(voice.args.safeParse({ sub: "list" }).success).toBe(true);
});

test("prose's args accept no project, and require nothing on their own (voice/brief are checked by run, not by zod)", () => {
  const prose = verb("prose");
  expect(prose.args.safeParse({}).success).toBe(true);
  expect("project" in prose.args.shape).toBe(false);
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
    sub: { type: "string" },
    name: { type: "string" },
    global: { type: "boolean", default: false },
    line: { type: "string" },
    section: { type: "string" },
    title: { type: "string" },
    voice: { type: "string" },
    brief: { type: "string" },
    context: { type: "string", multiple: true },
    format: { type: "string" },
    out: { type: "string" }, // AGT-1242: prose --out (prose reuses `force`, already pinned above)
    draft: { type: "string" }, // AGT-1244: prose --draft
    instruction: { type: "string" }, // AGT-1244: prose --instruction
    // AGT-1261: review's `action`/`id` are NOT here — `positionalArgs` on the
    // `review` verb tells `deriveCliOptions` to skip them, since `cli.ts`
    // reads them from positionals (`args.rest`), never a named flag (a
    // standards review finding — see `Verb.positionalArgs`'s docstring).
    all: { type: "boolean", default: false }, // AGT-1261: review list --all
    unread: { type: "boolean", default: false }, // AGT-1261: review approve --unread
    reason: { type: "string" }, // AGT-1261: review reject --reason
    timeout: { type: "string" }, // AGT-1261: review wait --timeout
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

test("check.run with a file outside the vault refuses (exit 2), naming the vault boundary", async () => {
  const vault = tempVault();

  const outcome = await verb("check").run({ project: "ice-house", file: "/etc/hosts" }, ctxFor(vault));

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });
  expect((outcome.body as { message: string }).message).toContain("inside the vault");

  rmSync(vault, { recursive: true, force: true });
});

test("check.run with a relative file that escapes the vault via .. also refuses", async () => {
  const vault = tempVault();

  const outcome = await verb("check").run(
    { project: "ice-house", file: "../../../../../../etc/hosts" },
    ctxFor(vault),
  );

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });

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

// ---------------------------------------------------------------------------
// voice (AGT-1240) — its own ctx, always with a throwaway XDG_CONFIG_HOME:
// `ctxFor`'s env has no XDG_CONFIG_HOME key at all, which would otherwise
// leave `voice`'s global-directory fallback resolving against the real
// `~/.config/pablo` (never a real risk for `list`/`show`, which only stat
// paths, but `new` without --global falling back to "no vault" would WRITE
// there — this vault always has a `style/` marker, so that fallback never
// actually fires in these tests, but every test still pins its own
// XDG_CONFIG_HOME rather than relying on that).
// ---------------------------------------------------------------------------

function voiceCtxFor(vault: string, configHome: string): VerbContext {
  return { cwd: vault, env: { PABLO_VAULT: vault, XDG_CONFIG_HOME: configHome, PATH: NO_THINK_PATH }, stderr: { write: () => {} } };
}

test("voice.run list includes fiction and every fixture voice", async () => {
  const vault = tempVault();
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-voice-config-"));

  const outcome = await verb("voice").run({ sub: "list" }, voiceCtxFor(vault, configHome));

  expect(outcome.exitCode).toBe(0);
  const body = outcome.body as { ok: boolean; voices: Array<{ name: string; scope: string; path: string }> };
  expect(body.ok).toBe(true);
  expect(body.voices).toContainEqual({ name: "fiction", scope: "fiction", path: join(vault, "style") });
  expect(body.voices.some((v) => v.name === "plain" && v.scope === "vault")).toBe(true);

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("voice.run show on the fixture's plain voice returns the readVoice shape", async () => {
  const vault = tempVault();
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-voice-config-"));

  const outcome = await verb("voice").run({ sub: "show", name: "plain" }, voiceCtxFor(vault, configHome));

  expect(outcome.exitCode).toBe(0);
  expect(outcome.body).toMatchObject({ ok: true, name: "plain", model: "anthropic" });
  expect((outcome.body as { rules: unknown[] }).rules).toHaveLength(1);
  expect((outcome.body as { exemplars: unknown[] }).exemplars).toHaveLength(2);

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("voice.run show on an unknown name refuses (exit 2), naming both paths tried", async () => {
  const vault = tempVault();
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-voice-config-"));

  const outcome = await verb("voice").run({ sub: "show", name: "nosuchvoice" }, voiceCtxFor(vault, configHome));

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });
  expect((outcome.body as { tried: string[] }).tried).toHaveLength(2);

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("voice.run new scaffolds a voice and voice.run show then reads it back", async () => {
  const vault = tempVault();
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-voice-config-"));

  const created = await verb("voice").run({ sub: "new", name: "memo" }, voiceCtxFor(vault, configHome));
  expect(created.exitCode).toBe(0);
  expect(created.body).toMatchObject({ ok: true, scope: "vault" });

  const shown = await verb("voice").run({ sub: "show", name: "memo" }, voiceCtxFor(vault, configHome));
  expect(shown.exitCode).toBe(0);
  expect(shown.body).toMatchObject({ ok: true, name: "memo" });

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

// AGT-1235's review finding, reapplied to `voice`: a path-shaped `name` is
// model-controlled over MCP, so a path outside the vault must be refused
// before ever being read (see `looksLikeVoicePath` in verbs.ts).
test("voice.run show with a path-shaped name outside the vault refuses (exit 2), naming the vault boundary", async () => {
  const vault = tempVault();
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-voice-config-"));

  const outcome = await verb("voice").run({ sub: "show", name: "/etc/hosts" }, voiceCtxFor(vault, configHome));

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });
  expect((outcome.body as { message: string }).message).toContain("inside the vault");

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("voice.run show with a relative path-shaped name that escapes the vault via .. also refuses", async () => {
  const vault = tempVault();
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-voice-config-"));

  const outcome = await verb("voice").run(
    { sub: "show", name: "../../../../../../etc/hosts" },
    voiceCtxFor(vault, configHome),
  );

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test('voice.run show with the in-vault path "./voices/plain/voice.md" is allowed (inside the vault boundary)', async () => {
  const vault = tempVault();
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-voice-config-"));

  const outcome = await verb("voice").run(
    { sub: "show", name: "./voices/plain/voice.md" },
    voiceCtxFor(vault, configHome),
  );

  expect(outcome.exitCode).toBe(0);
  expect(outcome.body).toMatchObject({ ok: true, name: "voice" });

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("voice.run new without name refuses (exit 2)", async () => {
  const vault = tempVault();
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-voice-config-"));

  const outcome = await verb("voice").run({ sub: "new" }, voiceCtxFor(vault, configHome));

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// prose (AGT-1241) — CLI-level and slice-shape behaviour is covered in
// packages/cli/test/prose.test.ts; these exercise the MCP-only surface:
// dry-run through the verb's `run`, and the vault-boundary bound on
// `brief`/`context` (mirroring `save`'s/`check`'s MCP tests above).
// ---------------------------------------------------------------------------

test("prose.run with dry-run true returns a prompt_hash, exit 0", async () => {
  const vault = tempVault();
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-prose-config-"));
  const briefPath = join(vault, "brief.md");
  writeFileSync(briefPath, "Announce the new dock hours.\n", "utf8");

  const outcome = await verb("prose").run(
    { voice: "plain", brief: briefPath, context: [], "dry-run": true },
    voiceCtxFor(vault, configHome),
  );

  expect(outcome.exitCode).toBe(0);
  expect(outcome.body).toMatchObject({ ok: true, dryRun: true });
  expect(typeof (outcome.body as { prompt_hash: string }).prompt_hash).toBe("string");

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

// AGT-1242: the send path replaced AGT-1241's exit-1 stub. The fixture's
// `plain` voice names `model: anthropic`, which the temp config home does not
// configure, so this refuses on AC1's per-voice override without reaching any
// endpoint. (The MCP surface has no adapter injection point; the fake-adapter
// send tests live in prose-send.test.ts.)
test("prose.run without dry-run, on a voice whose model: is not configured, refuses (exit 2)", async () => {
  const vault = tempVault();
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-prose-config-"));
  const briefPath = join(vault, "brief.md");
  writeFileSync(briefPath, "Announce the new dock hours.\n", "utf8");

  const outcome = await verb("prose").run(
    { voice: "plain", brief: briefPath, context: [] },
    voiceCtxFor(vault, configHome),
  );

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });
  expect((outcome.body as { message: string }).message).toContain("anthropic");

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

// AGT-1242: `out` is a WRITE path arriving as a model-controlled tool
// argument, so it gets the same vault bound `brief`/`context`/`voice` get —
// and the refusal must happen before any model call, let alone any file
// creation.
test("prose.run with an out path outside the vault refuses (exit 2), naming the vault boundary, and creates nothing", async () => {
  const vault = tempVault();
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-prose-config-"));
  const briefPath = join(vault, "brief.md");
  writeFileSync(briefPath, "Announce the new dock hours.\n", "utf8");
  const outside = join(mkdtempSync(join(tmpdir(), "pablo-verbs-prose-outside-")), "escaped.md");

  for (const out of [outside, "../escaped.md", "/tmp/pablo-verbs-escaped.md"]) {
    const outcome = await verb("prose").run(
      { voice: "plain", brief: briefPath, context: [], out },
      voiceCtxFor(vault, configHome),
    );

    expect(outcome.exitCode).toBe(2);
    expect(outcome.body).toMatchObject({ ok: false, code: 2 });
    expect((outcome.body as { message: string }).message).toContain("inside");
  }

  expect(existsSync(outside)).toBe(false);
  expect(existsSync("/tmp/pablo-verbs-escaped.md")).toBe(false);

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

// AGT-1242 security review: the vault bound stops `out` escaping, but inside
// the vault `force: true` would still let a tool call destroy an existing
// file with no read-back. Overwriting is an author's decision, so it is a CLI
// flag only.
test("prose.run with force true refuses (exit 2) and leaves the existing file byte-identical", async () => {
  const vault = tempVault();
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-prose-config-"));
  const briefPath = join(vault, "brief.md");
  writeFileSync(briefPath, "Announce the new dock hours.\n", "utf8");
  const outPath = join(vault, "notice.md");
  writeFileSync(outPath, "hand-written, must not be clobbered\n", "utf8");
  const before = readFileSync(outPath);

  const outcome = await verb("prose").run(
    { voice: "plain", brief: briefPath, context: [], out: outPath, force: true },
    voiceCtxFor(vault, configHome),
  );

  expect(outcome.exitCode).toBe(2);
  expect((outcome.body as { message: string }).message).toContain("MCP");
  expect(readFileSync(outPath).equals(before)).toBe(true);

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("prose.run without voice refuses (exit 2)", async () => {
  const vault = tempVault();
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-prose-config-"));

  const outcome = await verb("prose").run({ context: [], "dry-run": true }, voiceCtxFor(vault, configHome));

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("prose.run with brief \"-\" refuses (exit 2): no stdin to read in an MCP tool call", async () => {
  const vault = tempVault();
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-prose-config-"));

  const outcome = await verb("prose").run(
    { voice: "plain", brief: "-", context: [], "dry-run": true },
    voiceCtxFor(vault, configHome),
  );

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });
  expect((outcome.body as { message: string }).message).toContain("MCP");

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

// AGT-1241's own version of the AGT-1235 review finding: `brief`/`context`
// are model-controlled over MCP, so a path outside the vault must be refused
// before ever being read.
test("prose.run with a brief outside the vault refuses (exit 2), naming the vault boundary", async () => {
  const vault = tempVault();
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-prose-config-"));

  const outcome = await verb("prose").run(
    { voice: "plain", brief: "/etc/hosts", context: [], "dry-run": true },
    voiceCtxFor(vault, configHome),
  );

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });
  expect((outcome.body as { message: string }).message).toContain("inside");

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

// A path-shaped `voice` is model-controlled over MCP and AGT-1240 resolves it
// as a one-off voice file, so it needs the same bound `--brief`/`--context`
// get. A plain name is slug-validated by `resolveVoice` and cannot traverse.
test("prose.run with a path-shaped voice outside the vault refuses (exit 2), naming the vault boundary", async () => {
  const vault = tempVault();
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-prose-config-"));
  const briefPath = join(vault, "brief.md");
  writeFileSync(briefPath, "Announce the new dock hours.\n", "utf8");

  for (const voice of ["/etc/hosts", "../../../etc/passwd", "../../etc/hosts.md"]) {
    const outcome = await verb("prose").run(
      { voice, brief: briefPath, context: [], "dry-run": true },
      voiceCtxFor(vault, configHome),
    );

    expect(outcome.exitCode).toBe(2);
    expect(outcome.body).toMatchObject({ ok: false, code: 2 });
    expect((outcome.body as { message: string }).message).toContain("inside");
  }

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("prose.run with a path-shaped voice INSIDE the vault is still allowed (AGT-1240's one-off voice file)", async () => {
  const vault = tempVault();
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-prose-config-"));
  const briefPath = join(vault, "brief.md");
  writeFileSync(briefPath, "Announce the new dock hours.\n", "utf8");
  const oneOff = join(vault, "one-off-voice.md");
  writeFileSync(oneOff, "# Voice\n\nPlain sentences. No throat-clearing.\n", "utf8");

  const outcome = await verb("prose").run(
    { voice: oneOff, brief: briefPath, context: [], "dry-run": true },
    voiceCtxFor(vault, configHome),
  );

  expect(outcome.exitCode).toBe(0);
  expect(outcome.body).toMatchObject({ ok: true, dryRun: true });

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("prose.run with a context file outside the vault refuses (exit 2), naming the vault boundary", async () => {
  const vault = tempVault();
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-prose-config-"));
  const briefPath = join(vault, "brief.md");
  writeFileSync(briefPath, "Announce the new dock hours.\n", "utf8");

  const outcome = await verb("prose").run(
    { voice: "plain", brief: briefPath, context: ["/etc/hosts"], "dry-run": true },
    voiceCtxFor(vault, configHome),
  );

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });
  expect((outcome.body as { message: string }).message).toContain("inside");

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

// AC4: prose must work with no vault at all — a global voice, from a cwd
// with no vault/style marker at all. The bound then falls back to `ctx.cwd`
// (see `bindProsePath`'s comment in verbs.ts), so a brief under `ctx.cwd`
// is still allowed.
test("prose.run with no vault resolves a global voice and a brief under ctx.cwd", async () => {
  const noVaultCwd = mkdtempSync(join(tmpdir(), "pablo-verbs-prose-novault-"));
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-prose-config-"));
  mkdirSync(join(configHome, "pablo", "voices", "memo", "exemplars"), { recursive: true });
  writeFileSync(join(configHome, "pablo", "voices", "memo", "voice.md"), "# Voice: memo\n\nShort and plain.\n", "utf8");
  const briefPath = join(noVaultCwd, "brief.md");
  writeFileSync(briefPath, "Announce the new dock hours.\n", "utf8");

  const outcome = await verb("prose").run(
    { voice: "memo", brief: briefPath, context: [], "dry-run": true },
    { cwd: noVaultCwd, env: { XDG_CONFIG_HOME: configHome, PATH: NO_THINK_PATH }, stderr: { write: () => {} } },
  );

  expect(outcome.exitCode).toBe(0);
  expect(outcome.body).toMatchObject({ ok: true, dryRun: true });

  rmSync(noVaultCwd, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// voice's mcpTools (AGT-1245) — `voice_list`/`voice_show`/`voice_flag`/
// `voice_exemplar`, the four narrow MCP tools `voice`'s VERBS entry exposes
// instead of registering itself directly (see verbs.ts's file header and
// `mcp.test.ts`'s full stdio round trip for the same tools driven end to end).
// ---------------------------------------------------------------------------

test("voice exposes exactly four mcpTools, each with a disjoint schema and no sub field", () => {
  const tools = verb("voice").mcpTools;
  expect(tools).toBeDefined();
  expect(tools!.map((t) => t.name).sort()).toEqual(["voice_exemplar", "voice_flag", "voice_list", "voice_show"]);

  const shapeKeys = (name: string) => Object.keys(voiceMcpTool(name).args.shape).sort();
  expect(shapeKeys("voice_list")).toEqual([]);
  expect(shapeKeys("voice_show")).toEqual(["name"]);
  expect(shapeKeys("voice_flag")).toEqual(["line", "name", "section"]);
  expect(shapeKeys("voice_exemplar")).toEqual(["file", "name", "title"]);
  for (const name of ["voice_list", "voice_show", "voice_flag", "voice_exemplar"]) {
    expect("sub" in voiceMcpTool(name).args.shape).toBe(false);
  }
});

// AC1: a narrow schema enforces requiredness structurally — `name` (and
// `voice_flag`'s `line`, `voice_exemplar`'s `file`) are not `.optional()`,
// unlike `VOICE_ARGS`'s own `name` (which must stay optional for `list`).
test("voice_show/voice_flag/voice_exemplar require name (and their own field) in the schema itself, not just at runtime", () => {
  expect(voiceMcpTool("voice_show").args.safeParse({}).success).toBe(false);
  expect(voiceMcpTool("voice_show").args.safeParse({ name: "plain" }).success).toBe(true);

  expect(voiceMcpTool("voice_flag").args.safeParse({ name: "plain" }).success).toBe(false);
  expect(voiceMcpTool("voice_flag").args.safeParse({ name: "plain", line: "x" }).success).toBe(true);

  expect(voiceMcpTool("voice_exemplar").args.safeParse({ name: "plain" }).success).toBe(false);
  expect(voiceMcpTool("voice_exemplar").args.safeParse({ name: "plain", file: "x.md" }).success).toBe(true);
});

test("voice_list mcpTool returns the same body voice.run sub:list does", async () => {
  const vault = tempVault();
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-voice-mcp-config-"));
  const ctx = voiceCtxFor(vault, configHome);

  const viaVerb = await verb("voice").run({ sub: "list" }, ctx);
  const viaTool = await voiceMcpTool("voice_list").run({}, ctx);

  expect(viaTool).toEqual(viaVerb);

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("voice_show mcpTool on the fixture's plain voice returns the readVoice shape", async () => {
  const vault = tempVault();
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-voice-mcp-config-"));

  const outcome = await voiceMcpTool("voice_show").run({ name: "plain" }, voiceCtxFor(vault, configHome));

  expect(outcome.exitCode).toBe(0);
  expect(outcome.body).toMatchObject({ ok: true, name: "plain", model: "anthropic" });

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("voice_show mcpTool with a path-shaped name outside the vault refuses (exit 2), naming the vault boundary", async () => {
  const vault = tempVault();
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-voice-mcp-config-"));

  const outcome = await voiceMcpTool("voice_show").run({ name: "/etc/hosts" }, voiceCtxFor(vault, configHome));

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });
  expect((outcome.body as { message: string }).message).toContain("inside the vault");

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

// AGT-1243 gate finding, re-verified over the narrow tool (mirrors
// mcp.test.ts's full round trip): `line` and `section` are both flattened
// before writing, so neither can forge a `## ` heading.
test("voice_flag mcpTool flattens an embedded newline in both line and section, forging no heading", async () => {
  const vault = tempVault();
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-voice-mcp-config-"));

  const outcome = await voiceMcpTool("voice_flag").run(
    { name: "plain", line: "Say what changed.\n## Injected", section: "Flagged\n## AlsoInjected" },
    voiceCtxFor(vault, configHome),
  );

  expect(outcome.exitCode).toBe(0);
  const body = outcome.body as { ok: boolean; path: string };
  expect(body.ok).toBe(true);
  const contents = readFileSync(body.path, "utf8");
  expect(contents).toContain('Flagged: "Say what changed. ## Injected"');
  expect(contents).not.toMatch(/^## Injected$/m);
  expect(contents).not.toMatch(/^## AlsoInjected$/m);

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("voice_exemplar mcpTool with a file outside the vault refuses (exit 2), never reads it", async () => {
  const vault = tempVault();
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-voice-mcp-config-"));

  const outcome = await voiceMcpTool("voice_exemplar").run(
    { name: "plain", file: "/etc/hosts" },
    voiceCtxFor(vault, configHome),
  );

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });
  expect((outcome.body as { message: string }).message).toContain("inside the vault");

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("voice_exemplar mcpTool on a fresh voice keeps a piece verbatim", async () => {
  const vault = tempVault();
  const configHome = mkdtempSync(join(tmpdir(), "pablo-verbs-voice-mcp-config-"));
  const piece = join(vault, "piece.md");
  writeFileSync(piece, "# A Kept Piece\n\nExactly as written.\n", "utf8");

  const created = await verb("voice").run({ sub: "new", name: "memo" }, voiceCtxFor(vault, configHome));
  expect(created.exitCode).toBe(0);

  const outcome = await voiceMcpTool("voice_exemplar").run(
    { name: "memo", file: piece, title: "A Kept Piece" },
    voiceCtxFor(vault, configHome),
  );

  expect(outcome.exitCode).toBe(0);
  const body = outcome.body as { ok: boolean; path: string };
  expect(body.ok).toBe(true);
  expect(readFileSync(body.path, "utf8")).toBe("# A Kept Piece\n\nExactly as written.\n");

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});
