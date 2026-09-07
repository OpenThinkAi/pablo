import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * These spawn the real bin, so they exercise argv parsing, exit codes and
 * stdout end to end. `PABLO_VAULT` always points at a throwaway copy of the
 * synthetic fixture — never the real `~/writing` vault.
 */
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));

/**
 * A PATH that can still run `bun` and `git` but resolves no `think` — the
 * real dev machine has `think` on PATH, and `resume` shells out to it, so
 * tests that don't care about the brief use this to avoid a real network call.
 */
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");

function tempVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-cli-test-"));
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  return vault;
}

function runCli(args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync(["bun", "run", CLI, ...args], {
    env: { ...process.env, ...env },
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

test("pablo --help lists the P0 verbs and exits 0", () => {
  const { stdout, exitCode } = runCli(["--help"]);

  expect(exitCode).toBe(0);
  for (const verb of ["init", "resume", "status", "write", "save", "check", "dry-run", "mcp"]) {
    expect(stdout).toContain(verb);
  }
});

test("pablo with no verb prints help and exits 0", () => {
  const { exitCode, stdout } = runCli([]);

  expect(exitCode).toBe(0);
  expect(stdout).toContain("Usage: pablo");
});

test("resume --project nope --json exits 2 with a JSON refusal body", () => {
  const vault = tempVault();

  const { stdout, exitCode } = runCli(["resume", "--project", "nope", "--json"], { PABLO_VAULT: vault });

  expect(exitCode).toBe(2);
  const body = JSON.parse(stdout);
  expect(body).toMatchObject({ ok: false, code: 2 });
  expect(typeof body.message).toBe("string");
  expect(Array.isArray(body.tried)).toBe(true);

  rmSync(vault, { recursive: true, force: true });
});

test("resume --project ice-house --json exits 0 with the resume summary shape", () => {
  const vault = tempVault();

  const { stdout, exitCode } = runCli(["resume", "--project", "ice-house", "--json"], {
    PABLO_VAULT: vault,
    PATH: NO_THINK_PATH,
  });

  expect(exitCode).toBe(0);
  const body = JSON.parse(stdout);
  expect(body).toMatchObject({ format: "novel", title: "The Ice House" });
  expect(typeof body.next).toBe("string");

  rmSync(vault, { recursive: true, force: true });
});

test("status --project no-marker --json exits 2 with a one-line message naming the missing marker", () => {
  const vault = tempVault();

  const { stdout, exitCode } = runCli(["status", "--project", "no-marker", "--json"], { PABLO_VAULT: vault });

  expect(exitCode).toBe(2);
  const body = JSON.parse(stdout);
  expect(body).toMatchObject({ ok: false, code: 2 });
  expect(body.message).toContain("no pablo.json");
  expect(body.message).toContain("pablo init --adopt --project");

  rmSync(vault, { recursive: true, force: true });
});

test("an unknown verb exits 1", () => {
  const { exitCode, stderr } = runCli(["frobnicate"]);

  expect(exitCode).toBe(1);
  expect(stderr).toContain("unknown verb");
});

test("init novel <slug> \"<Title>\" scaffolds the work and exits 0 with a JSON summary", () => {
  const vault = tempVault();

  const { stdout, exitCode } = runCli(["init", "novel", "salt-road", "The Salt Road", "--json"], { PABLO_VAULT: vault });

  expect(exitCode).toBe(0);
  const body = JSON.parse(stdout);
  expect(body).toMatchObject({ ok: true, format: "novel", slug: "salt-road", title: "The Salt Road" });
  expect(typeof body.committed).toBe("boolean");

  rmSync(vault, { recursive: true, force: true });
});

test("init novel onto an existing slug exits 2", () => {
  const vault = tempVault();

  const { stdout, exitCode } = runCli(["init", "novel", "ice-house", "Ice House Again", "--json"], { PABLO_VAULT: vault });

  expect(exitCode).toBe(2);
  const body = JSON.parse(stdout);
  expect(body).toMatchObject({ ok: false, code: 2 });

  rmSync(vault, { recursive: true, force: true });
});

test("status --project ice-house --json exits 0 with the novel machine's state", () => {
  const vault = tempVault();

  const { stdout, exitCode } = runCli(["status", "--project", "ice-house", "--json"], { PABLO_VAULT: vault });

  expect(exitCode).toBe(0);
  const body = JSON.parse(stdout);
  expect(body.premise).toBe(true);
  expect(body.beats).toHaveLength(4);
  expect(body.chapters).toEqual([
    { number: 1, file: "chapters/01-the-last-full-cut.md", status: "draft", title: "The Last Full Cut" },
  ]);

  rmSync(vault, { recursive: true, force: true });
});

test("status --project ice-house (no --json) prints one prose line per stage", () => {
  const vault = tempVault();

  const { stdout, exitCode } = runCli(["status", "--project", "ice-house"], { PABLO_VAULT: vault });

  expect(exitCode).toBe(0);
  expect(stdout).toContain("premise: ok");
  expect(stdout).toContain("acts: 2");
  expect(stdout).toContain("beats: 4 (chapters 1");
  expect(stdout).toContain("chapters: 1 written");

  rmSync(vault, { recursive: true, force: true });
});

test('status --project ice-house --for "chapter 2" --json exits 0 with ready:true', () => {
  const vault = tempVault();

  const { stdout, exitCode } = runCli(["status", "--project", "ice-house", "--for", "chapter 2", "--json"], {
    PABLO_VAULT: vault,
  });

  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ ready: true, missing: [] });

  rmSync(vault, { recursive: true, force: true });
});

test('status --project ice-house --for "chapter 3" --json exits 2 with ready:false and the exact missing strings', () => {
  const vault = tempVault();

  const { stdout, exitCode } = runCli(["status", "--project", "ice-house", "--for", "chapter 3", "--json"], {
    PABLO_VAULT: vault,
  });

  expect(exitCode).toBe(2);
  expect(JSON.parse(stdout)).toEqual({
    ready: false,
    missing: ["chapter 2 is not written", "Mrs. Frayne still has a [pick] in bible/characters/family-tree.md"],
  });

  rmSync(vault, { recursive: true, force: true });
});

test('status --project ice-house --for "ch 3" (no --json) prints the not-ready line and each missing item indented', () => {
  const vault = tempVault();

  const { stdout, exitCode } = runCli(["status", "--project", "ice-house", "--for", "ch 3"], { PABLO_VAULT: vault });

  expect(exitCode).toBe(2);
  expect(stdout).toContain("chapter 3: not ready");
  expect(stdout).toContain("  chapter 2 is not written");

  rmSync(vault, { recursive: true, force: true });
});

test("status --project ice-house --for bogus --json exits 2 with a refusal naming the expected shape", () => {
  const vault = tempVault();

  const { stdout, exitCode } = runCli(["status", "--project", "ice-house", "--for", "bogus", "--json"], {
    PABLO_VAULT: vault,
  });

  expect(exitCode).toBe(2);
  const body = JSON.parse(stdout);
  expect(body).toMatchObject({ ok: false, code: 2 });
  expect(body.message).toContain('--for expects "chapter N"');

  rmSync(vault, { recursive: true, force: true });
});

test("init --adopt --project no-marker writes only the marker and does not commit", () => {
  const vault = tempVault();

  const { stdout, exitCode } = runCli(["init", "--adopt", "--project", "no-marker", "--json"], { PABLO_VAULT: vault });

  expect(exitCode).toBe(0);
  const body = JSON.parse(stdout);
  expect(body).toMatchObject({ ok: true, format: "novel", slug: "no-marker", committed: false });

  rmSync(vault, { recursive: true, force: true });
});

// `write`'s own scenarios (AC1-AC5, chapter parsing, the neverSend refusal,
// dry-run's two output shapes) are in write.test.ts and pack.test.ts; this
// confirms only that cli.ts's dispatch actually reaches runWrite end to end.
test("write --project ice-house --chapter 2 --dry-run --json is wired through cli.ts's dispatch (AGT-1230)", () => {
  const vault = tempVault();

  const { stdout, exitCode } = runCli(
    ["write", "--project", "ice-house", "--chapter", "2", "--dry-run", "--json"],
    { PABLO_VAULT: vault },
  );

  expect(exitCode).toBe(0);
  const body = JSON.parse(stdout);
  expect(body).toMatchObject({ ok: true, dryRun: true });
  expect(typeof body.prompt_hash).toBe("string");

  rmSync(vault, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// voice (AGT-1240) — every case sets its own throwaway XDG_CONFIG_HOME so the
// global-voices fallback never touches the real ~/.config/pablo.
// ---------------------------------------------------------------------------

function tempConfigHome(): string {
  return mkdtempSync(join(tmpdir(), "pablo-cli-voice-config-"));
}

test("voice list prints fiction and every fixture voice with its scope", () => {
  const vault = tempVault();
  const configHome = tempConfigHome();

  const { stdout, exitCode } = runCli(["voice", "list"], { PABLO_VAULT: vault, XDG_CONFIG_HOME: configHome });

  expect(exitCode).toBe(0);
  expect(stdout).toContain("fiction\tfiction\t");
  expect(stdout).toContain("plain\tvault\t");

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("voice list --json returns {ok:true, voices[]}", () => {
  const vault = tempVault();
  const configHome = tempConfigHome();

  const { stdout, exitCode } = runCli(["voice", "list", "--json"], {
    PABLO_VAULT: vault,
    XDG_CONFIG_HOME: configHome,
  });

  expect(exitCode).toBe(0);
  const body = JSON.parse(stdout);
  expect(body.ok).toBe(true);
  expect(body.voices.some((v: { name: string }) => v.name === "plain")).toBe(true);

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("voice new memo scaffolds a voice under the vault and exits 0", () => {
  const vault = tempVault();
  const configHome = tempConfigHome();

  const { stdout, exitCode } = runCli(["voice", "new", "memo", "--json"], {
    PABLO_VAULT: vault,
    XDG_CONFIG_HOME: configHome,
  });

  expect(exitCode).toBe(0);
  const body = JSON.parse(stdout);
  expect(body).toMatchObject({ ok: true, scope: "vault" });
  expect(existsSync(join(vault, "voices", "memo", "voice.md"))).toBe(true);

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("voice new onto an existing voice exits 2", () => {
  const vault = tempVault();
  const configHome = tempConfigHome();

  const { stdout, exitCode } = runCli(["voice", "new", "plain", "--json"], {
    PABLO_VAULT: vault,
    XDG_CONFIG_HOME: configHome,
  });

  expect(exitCode).toBe(2);
  const body = JSON.parse(stdout);
  expect(body).toMatchObject({ ok: false, code: 2 });

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("voice show plain --json returns the readVoice shape", () => {
  const vault = tempVault();
  const configHome = tempConfigHome();

  const { stdout, exitCode } = runCli(["voice", "show", "plain", "--json"], {
    PABLO_VAULT: vault,
    XDG_CONFIG_HOME: configHome,
  });

  expect(exitCode).toBe(0);
  const body = JSON.parse(stdout);
  expect(body).toMatchObject({ ok: true, name: "plain", model: "anthropic" });
  expect(body.rules).toHaveLength(1);
  expect(body.exemplars).toHaveLength(2);

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("voice show fiction (no --json) prints the style guide's prose", () => {
  const vault = tempVault();
  const configHome = tempConfigHome();

  const { stdout, exitCode } = runCli(["voice", "show", "fiction"], {
    PABLO_VAULT: vault,
    XDG_CONFIG_HOME: configHome,
  });

  expect(exitCode).toBe(0);
  expect(stdout).toContain("Flagged:");

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("voice show nosuchvoice --json exits 2 listing both paths tried", () => {
  const vault = tempVault();
  const configHome = tempConfigHome();

  const { stdout, exitCode } = runCli(["voice", "show", "nosuchvoice", "--json"], {
    PABLO_VAULT: vault,
    XDG_CONFIG_HOME: configHome,
  });

  expect(exitCode).toBe(2);
  const body = JSON.parse(stdout);
  expect(body).toMatchObject({ ok: false, code: 2 });
  expect(body.tried).toHaveLength(2);
  expect(body.message).toContain(join(vault, "voices", "nosuchvoice"));
  expect(body.message).toContain(join(configHome, "pablo", "voices", "nosuchvoice"));

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});
