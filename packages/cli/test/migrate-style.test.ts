// `pablo migrate style` (AGT-2141, D-15) and the STYLE.md / QWEN.md fallback. Every migration runs on a
// git-initialised temp copy of the fixture vault, never on the fixture itself.

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readDraftingInputs, readWorkRules, workRulesFile } from "@openthink/pablo-core";
import { MIGRATE_STYLE_COMMIT_MESSAGE, migrateStyle } from "../src/migrate-style";
import { resolveVoiceLayers } from "../src/voice-layers";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function git(vault: string, ...args: string[]): string {
  return execFileSync("git", ["-C", vault, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
}

function tempVault(): { vault: string; work: string } {
  const vault = mkdtempSync(join(tmpdir(), "pablo-migrate-style-"));
  cpSync(FIXTURE, vault, { recursive: true });
  git(vault, "init", "-q", "-b", "main");
  git(vault, "add", "-A");
  git(vault, "commit", "-q", "-m", "fixture");
  return { vault, work: join(vault, "novels", "ice-house") };
}

test("the resolver reads STYLE.md, falls back to QWEN.md, and prefers STYLE.md when both exist", () => {
  const { work } = tempVault();
  expect(workRulesFile(work)).toBe("QWEN.md");
  writeFileSync(join(work, "STYLE.md"), "# Style\n\n## Ground rules\n\n- Only STYLE.md says this.\n");
  expect(workRulesFile(work)).toBe("STYLE.md");
  const empty = mkdtempSync(join(tmpdir(), "pablo-no-rules-"));
  expect(workRulesFile(empty)).toBe("STYLE.md");
});

test("drafting inputs and the voice layers carry STYLE.md when present, QWEN.md otherwise", () => {
  const { vault, work } = tempVault();
  const env = { XDG_CONFIG_HOME: join(vault, "no-global") };
  expect(readWorkRules(vault, work)?.path).toBe("novels/ice-house/QWEN.md");
  expect(resolveVoiceLayers({ vaultRoot: vault, workRoot: work, env }).layers.map((l) => l.name)).toEqual(["style", "QWEN.md"]);

  writeFileSync(join(work, "STYLE.md"), "# Style\n\n## Ground rules\n\n- Only STYLE.md says this.\n");
  const rules = readWorkRules(vault, work);
  expect(rules?.path).toBe("novels/ice-house/STYLE.md");
  expect(rules?.text).toContain("Only STYLE.md says this.");
  // The marker still lists QWEN.md; it resolves to whichever rules file the work has.
  const layers = resolveVoiceLayers({ vaultRoot: vault, workRoot: work, env });
  expect(layers.layers.map((l) => l.name)).toEqual(["style", "STYLE.md"]);
  expect(layers.missing.filter((m) => m.layer !== "global")).toEqual([]);
  expect(readDraftingInputs({ vaultRoot: vault, workRoot: work, chapter: 1, wordTarget: 1000 }).workRules?.path).toBe("novels/ice-house/STYLE.md");
});

test("migrate style renames with git mv, updates the voice list and commits on its own", () => {
  const { vault, work } = tempVault();
  const before = readFileSync(join(work, "QWEN.md"), "utf8");
  const dry = migrateStyle(vault, work, { dryRun: true });
  expect(dry).toMatchObject({ ok: true, dryRun: true, changes: ["QWEN.md -> STYLE.md", "pablo.json"], committed: false });
  expect(existsSync(join(work, "QWEN.md"))).toBe(true);

  const result = migrateStyle(vault, work, { dryRun: false });
  expect(result).toMatchObject({ ok: true, dryRun: false, committed: true });
  expect(existsSync(join(work, "QWEN.md"))).toBe(false);
  expect(readFileSync(join(work, "STYLE.md"), "utf8")).toBe(before);
  expect(JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")).voice).toEqual(["../../style", "STYLE.md"]);
  expect(git(vault, "log", "-1", "--format=%s").trim()).toBe(MIGRATE_STYLE_COMMIT_MESSAGE);
  expect(git(vault, "show", "--name-status", "--format=", "-M", "HEAD")).toMatch(/R\d+\s+novels\/ice-house\/QWEN\.md\s+novels\/ice-house\/STYLE\.md/);
  expect(git(vault, "status", "--porcelain").trim()).toBe("");

  const again = migrateStyle(vault, work, { dryRun: false });
  expect(again).toMatchObject({ ok: true, changes: [], committed: false });
  expect(git(vault, "log", "-1", "--format=%s").trim()).toBe(MIGRATE_STYLE_COMMIT_MESSAGE);
});

test("migrate style refuses when both files exist, and through the CLI", () => {
  const { vault, work } = tempVault();
  writeFileSync(join(work, "STYLE.md"), "# other\n");
  const refused = migrateStyle(vault, work, { dryRun: false });
  expect(refused.ok).toBe(false);
  expect(!refused.ok && refused.message).toContain("both QWEN.md and STYLE.md exist");

  const viaCli = Bun.spawnSync(["bun", "run", CLI, "migrate", "style", "--project", "ice-house", "--json"], {
    env: { ...process.env, ...GIT_ENV, PABLO_VAULT: vault },
  });
  expect(viaCli.exitCode).toBe(2);
});

test("pablo migrate style through the CLI renames the work's rules", () => {
  const { vault, work } = tempVault();
  const r = Bun.spawnSync(["bun", "run", CLI, "migrate", "style", "--project", "ice-house"], {
    env: { ...process.env, ...GIT_ENV, PABLO_VAULT: vault },
  });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toContain("pablo: migrate style: changed 2 path(s) (committed)");
  expect(existsSync(join(work, "STYLE.md"))).toBe(true);
});
