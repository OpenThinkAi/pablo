import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHROMIUM_PATHS,
  EditError,
  findChromium,
  NO_CHROMIUM_MESSAGE,
  openEditor,
  resolveEditTarget,
  runEdit,
} from "../src/edit";
import { appendEvent } from "../src/review";
import type { QueuedEvent } from "../src/review";
import { stateReviewPath } from "../src/paths";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempVault(): { vault: string; project: string; chapterPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "pablo-edit-test-"));
  cleanupDirs.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const project = join(vault, "novels", "ice-house");
  return { vault, project, chapterPath: join(project, "chapters", "01-the-last-full-cut.md") };
}

function stateHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-edit-test-state-"));
  cleanupDirs.push(dir);
  return dir;
}

function queuePiece(env: Record<string, string | undefined>, overrides: Partial<QueuedEvent> = {}): QueuedEvent {
  const event: QueuedEvent = {
    type: "queued",
    id: "20260907-hello-world-ab12",
    at: "2026-09-07T10:00:00.000Z",
    kind: "chapter",
    title: "Hello World",
    path: "/tmp/does-not-matter.md",
    words: 4,
    prompt_hash: "deadbeef",
    ...overrides,
  };
  appendEvent(stateReviewPath(env), event);
  return event;
}

// ---------------------------------------------------------------------------
// The Chromium probe (AC4) — an injected `existsExecutable`, never the real
// filesystem, so this suite behaves the same whether or not the machine
// running it actually has a browser installed.
// ---------------------------------------------------------------------------

describe("findChromium", () => {
  test("returns the first path whose existsExecutable check passes", () => {
    const seen: string[] = [];
    const found = findChromium((path) => {
      seen.push(path);
      return path === CHROMIUM_PATHS[1];
    });

    expect(found).toBe(CHROMIUM_PATHS[1]);
    // Stops at the first hit rather than probing every path.
    expect(seen).toEqual([CHROMIUM_PATHS[0], CHROMIUM_PATHS[1]]);
  });

  test("returns undefined when no path passes", () => {
    expect(findChromium(() => false)).toBeUndefined();
  });

  test("checks every CHROMIUM_PATHS entry, in order, against a custom list", () => {
    const custom = ["/a", "/b", "/c"];
    const seen: string[] = [];
    const found = findChromium((path) => {
      seen.push(path);
      return false;
    }, custom);

    expect(found).toBeUndefined();
    expect(seen).toEqual(custom);
  });
});

describe("openEditor — Chromium refusal (AC4)", () => {
  test("throws EditError code 2 with NO_CHROMIUM_MESSAGE before ever mounting, when no browser is found", async () => {
    const { chapterPath } = tempVault();

    await expect(
      openEditor({ path: chapterPath, deps: { existsExecutable: () => false } }),
    ).rejects.toMatchObject({ code: 2, message: NO_CHROMIUM_MESSAGE });
  });

  test("the rejection is an EditError instance", async () => {
    const { chapterPath } = tempVault();

    try {
      await openEditor({ path: chapterPath, deps: { existsExecutable: () => false } });
      throw new Error("expected openEditor to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(EditError);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveEditTarget — AC3's refusals.
// ---------------------------------------------------------------------------

describe("resolveEditTarget", () => {
  test("an unknown --piece refuses, exit code 2", () => {
    const env = { XDG_STATE_HOME: stateHome() };
    const { vault } = tempVault();

    const result = resolveEditTarget({ project: undefined, file: undefined, piece: "no-such-piece" }, { cwd: vault, env });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(2);
      expect(result.message).toContain("no-such-piece");
    }
  });

  test("a known --piece resolves to its own path and record", () => {
    const env = { XDG_STATE_HOME: stateHome() };
    const { chapterPath } = tempVault();
    const event = queuePiece(env, { path: chapterPath });

    const result = resolveEditTarget({ project: undefined, file: undefined, piece: event.id }, { cwd: "/", env });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(chapterPath);
      expect(result.piece?.id).toBe(event.id);
    }
  });

  test("--file outside the project refuses, exit code 2", () => {
    const env = { XDG_STATE_HOME: stateHome() };
    const { vault } = tempVault();
    const outside = join(vault, "outside.md");
    writeFileSync(outside, "not part of the project", "utf8");

    const result = resolveEditTarget(
      { project: "ice-house", file: "../outside.md", piece: undefined },
      { cwd: vault, env: { ...env, PABLO_VAULT: vault } },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(2);
      expect(result.message).toContain("outside the project");
    }
  });

  test("a --file that does not exist refuses, exit code 2", () => {
    const env = { XDG_STATE_HOME: stateHome() };
    const { vault } = tempVault();

    const result = resolveEditTarget(
      { project: "ice-house", file: "chapters/does-not-exist.md", piece: undefined },
      { cwd: vault, env: { ...env, PABLO_VAULT: vault } },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(2);
  });

  test("an unresolvable --project refuses with that project's own refusal", () => {
    const env = { XDG_STATE_HOME: stateHome() };
    const { vault } = tempVault();

    const result = resolveEditTarget(
      { project: "no-such-project", file: "chapters/x.md", piece: undefined },
      { cwd: vault, env: { ...env, PABLO_VAULT: vault } },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(2);
  });

  test("neither --piece nor --project/--file refuses, exit code 2", () => {
    const env = { XDG_STATE_HOME: stateHome() };
    const { vault } = tempVault();

    const result = resolveEditTarget({ project: undefined, file: undefined, piece: undefined }, { cwd: vault, env });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(2);
  });

  test("a --project with no --file (or vice versa) refuses, exit code 2", () => {
    const env = { XDG_STATE_HOME: stateHome() };
    const { vault } = tempVault();

    const result = resolveEditTarget(
      { project: "ice-house", file: undefined, piece: undefined },
      { cwd: vault, env: { ...env, PABLO_VAULT: vault } },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(2);
  });

  test("a project missing its pablo.json marker refuses", () => {
    const env = { XDG_STATE_HOME: stateHome() };
    const { vault } = tempVault();

    const result = resolveEditTarget(
      { project: "no-marker", file: "README.md", piece: undefined },
      { cwd: vault, env: { ...env, PABLO_VAULT: vault } },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(2);
  });

  test("--project/--file resolves inside the project", () => {
    const env = { XDG_STATE_HOME: stateHome() };
    const { vault, chapterPath } = tempVault();

    const result = resolveEditTarget(
      { project: "ice-house", file: "chapters/01-the-last-full-cut.md", piece: undefined },
      { cwd: vault, env: { ...env, PABLO_VAULT: vault } },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(chapterPath);
      expect(result.piece).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// runEdit — the CLI wrapper's refusal exit codes (never reaches openEditor,
// so no Chromium/browser dependency in these).
// ---------------------------------------------------------------------------

describe("runEdit", () => {
  test("an unknown --piece exits 2 without ever attempting to mount", async () => {
    const env = { XDG_STATE_HOME: stateHome() };
    const { vault } = tempVault();

    const code = await runEdit({ project: undefined, file: undefined, piece: "bogus", json: true }, vault, env);

    expect(code).toBe(2);
  });

  test("a --file outside the project exits 2", async () => {
    const env = { XDG_STATE_HOME: stateHome() };
    const { vault } = tempVault();

    const code = await runEdit(
      { project: "ice-house", file: "../../../../etc/hosts", piece: undefined, json: true },
      vault,
      { ...env, PABLO_VAULT: vault },
    );

    expect(code).toBe(2);
  });

  test("neither --piece nor --project/--file exits 2", async () => {
    const env = { XDG_STATE_HOME: stateHome() };
    const { vault } = tempVault();

    const code = await runEdit({ project: undefined, file: undefined, piece: undefined, json: true }, vault, env);

    expect(code).toBe(2);
  });
});
