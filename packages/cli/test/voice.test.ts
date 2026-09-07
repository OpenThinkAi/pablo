import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { globalVoicesDir, listVoices, readVoice, resolveVoice, scaffoldVoice } from "../src/voice";

/**
 * The fixture vault under `fixtures/vault` is entirely invented content
 * (see `cli.test.ts`'s own note) — never point these tests at `~/writing` or
 * the real `~/.config/pablo`. Every test here uses a throwaway copy of the
 * vault and a throwaway `XDG_CONFIG_HOME`, never the real environment.
 */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));

function tempVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-voice-test-"));
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  return vault;
}

function tempConfigHome(): string {
  return mkdtempSync(join(tmpdir(), "pablo-voice-config-"));
}

function envFor(configHome: string): Record<string, string | undefined> {
  return { XDG_CONFIG_HOME: configHome };
}

// ---------------------------------------------------------------------------
// resolveVoice
// ---------------------------------------------------------------------------

test("resolveVoice finds a vault voice before falling back to the global directory", () => {
  const vault = tempVault();
  const configHome = tempConfigHome();

  const result = resolveVoice("plain", { cwd: vault, env: envFor(configHome) });

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.path).toBe(join(vault, "voices", "plain"));
    expect(result.scope).toBe("vault");
  }

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("resolveVoice falls back to the global voices directory when the vault has no such voice", () => {
  const vault = tempVault();
  const configHome = tempConfigHome();
  const globalDir = join(globalVoicesDir(envFor(configHome)), "memo");
  mkdirSync(globalDir, { recursive: true });

  const result = resolveVoice("memo", { cwd: vault, env: envFor(configHome) });

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.path).toBe(globalDir);
    expect(result.scope).toBe("global");
  }

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test('resolveVoice("fiction") aliases to <vault>/style/', () => {
  const vault = tempVault();
  const configHome = tempConfigHome();

  const result = resolveVoice("fiction", { cwd: vault, env: envFor(configHome) });

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.path).toBe(join(vault, "style"));
    expect(result.scope).toBe("fiction");
  }

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("resolveVoice refuses a plain name that is not a slug rather than joining it onto a directory", () => {
  const vault = tempVault();
  const configHome = tempConfigHome();

  // `..` has no "/" and no ".md", so it misses the path branch; without slug
  // validation it would join() to the vault root and be read as a voice.
  for (const name of ["..", "Plain", "with space", "under_score"]) {
    const result = resolveVoice(name, { cwd: vault, env: envFor(configHome) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(2);
      expect(result.tried).toEqual([]);
      expect(result.message).toContain("is not a voice name");
    }
  }

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("resolveVoice on an unknown name is a refusal (exit 2) listing every path tried", () => {
  const vault = tempVault();
  const configHome = tempConfigHome();

  const result = resolveVoice("nosuchvoice", { cwd: vault, env: envFor(configHome) });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(2);
    expect(result.tried).toEqual([
      join(vault, "voices", "nosuchvoice"),
      join(globalVoicesDir(envFor(configHome)), "nosuchvoice"),
    ]);
    expect(result.message).toContain(join(vault, "voices", "nosuchvoice"));
    expect(result.message).toContain(join(globalVoicesDir(envFor(configHome)), "nosuchvoice"));
  }

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("resolveVoice accepts a one-off path argument (contains a slash) that exists", () => {
  const vault = tempVault();
  const configHome = tempConfigHome();
  const onceOff = join(vault, "voices", "plain", "voice.md");

  const result = resolveVoice("./voices/plain/voice.md", { cwd: vault, env: envFor(configHome) });

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.path).toBe(onceOff);
    expect(result.scope).toBe("path");
  }

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("resolveVoice accepts a one-off name ending in .md, refusing if it does not exist", () => {
  const vault = tempVault();
  const configHome = tempConfigHome();

  const result = resolveVoice("nope.md", { cwd: vault, env: envFor(configHome) });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(2);
    expect(result.tried).toEqual([join(vault, "nope.md")]);
  }

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readVoice
// ---------------------------------------------------------------------------

test("readVoice on the fixture's plain voice returns rules/exemplars/never/model", () => {
  const vault = tempVault();

  const voice = readVoice(join(vault, "voices", "plain"));

  expect(voice.name).toBe("plain");
  expect(voice.model).toBe("anthropic");
  expect(voice.rules).toHaveLength(1);
  expect(voice.rules[0]?.path).toBe("voice.md");
  expect(voice.rules[0]?.text).toContain("Flagged:");
  expect(voice.rules[0]?.text).not.toContain("model: anthropic"); // frontmatter stripped

  expect(voice.exemplars).toHaveLength(2);
  expect(voice.exemplars[0]?.path).toBe("exemplars/2026-09-02-ice-delivery-change.md"); // newest first
  expect(voice.exemplars[1]?.path).toBe("exemplars/2026-08-01-scale-house-hours.md");

  expect(voice.never).toBeUndefined();

  rmSync(vault, { recursive: true, force: true });
});

test("readVoice on fiction reads style/*.md sorted by name, like readStyle", () => {
  const vault = tempVault();

  const voice = readVoice(join(vault, "style"));

  expect(voice.name).toBe("fiction");
  expect(voice.exemplars).toEqual([]);
  expect(voice.rules.length).toBeGreaterThanOrEqual(2);
  expect(voice.rules.map((r) => r.path)).toEqual([...voice.rules.map((r) => r.path)].sort());

  rmSync(vault, { recursive: true, force: true });
});

test("readVoice on a one-off .md file treats the whole file as the voice", () => {
  const dir = mkdtempSync(join(tmpdir(), "pablo-voice-oneoff-"));
  const filePath = join(dir, "quick.md");
  writeFileSync(filePath, "---\nmodel: local\n---\n\nBe brief.\n", "utf8");

  const voice = readVoice(filePath);

  expect(voice.name).toBe("quick");
  expect(voice.model).toBe("local");
  expect(voice.rules).toEqual([{ path: "quick.md", text: "Be brief." }]);
  expect(voice.exemplars).toEqual([]);

  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// scaffoldVoice
// ---------------------------------------------------------------------------

test("scaffoldVoice writes voice.md and exemplars/.keep under the vault by default", () => {
  const vault = tempVault();
  const configHome = tempConfigHome();

  const result = scaffoldVoice("memo", { cwd: vault, env: envFor(configHome) });

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.scope).toBe("vault");
    expect(result.path).toBe(join(vault, "voices", "memo"));
    expect(typeof result.committed).toBe("boolean"); // the temp vault copy isn't a git repo; committed may be false with a notice
  }
  expect(existsSync(join(vault, "voices", "memo", "voice.md"))).toBe(true);
  expect(existsSync(join(vault, "voices", "memo", "exemplars", ".keep"))).toBe(true);
  const contents = readFileSync(join(vault, "voices", "memo", "voice.md"), "utf8");
  expect(contents).toContain("Voice: memo");
  expect(contents).toContain("Flagged:");

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("scaffoldVoice --global scaffolds under the global voices directory regardless of the vault", () => {
  const vault = tempVault();
  const configHome = tempConfigHome();

  const result = scaffoldVoice("memo", { cwd: vault, env: envFor(configHome), global: true });

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.scope).toBe("global");
    expect(result.path).toBe(join(globalVoicesDir(envFor(configHome)), "memo"));
    expect(result.committed).toBe(false);
  }
  expect(existsSync(join(globalVoicesDir(envFor(configHome)), "memo", "voice.md"))).toBe(true);

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("scaffoldVoice on an existing voice refuses (exit 2)", () => {
  const vault = tempVault();
  const configHome = tempConfigHome();

  const result = scaffoldVoice("plain", { cwd: vault, env: envFor(configHome) });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(2);
    expect(result.message).toContain("already exists");
  }

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("scaffoldVoice refuses an invalid name before writing anything", () => {
  const vault = tempVault();
  const configHome = tempConfigHome();

  const result = scaffoldVoice("Not Valid!", { cwd: vault, env: envFor(configHome) });

  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe(2);
  expect(existsSync(join(vault, "voices", "Not Valid!"))).toBe(false);

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// listVoices
// ---------------------------------------------------------------------------

test("listVoices reports fiction, every vault voice, and every global voice", () => {
  const vault = tempVault();
  const configHome = tempConfigHome();
  mkdirSync(join(globalVoicesDir(envFor(configHome)), "email"), { recursive: true });

  const listing = listVoices({ cwd: vault, env: envFor(configHome) });

  expect(listing).toContainEqual({ name: "fiction", scope: "fiction", path: join(vault, "style") });
  expect(listing).toContainEqual({ name: "plain", scope: "vault", path: join(vault, "voices", "plain") });
  expect(listing).toContainEqual({
    name: "email",
    scope: "global",
    path: join(globalVoicesDir(envFor(configHome)), "email"),
  });

  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});
