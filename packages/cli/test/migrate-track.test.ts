// `pablo migrate track` (AGT-2104). Every run is on a git-initialised temp copy of the fixture vault.

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readMarker, trackOf } from "../src/marker";
import { migrateTrack } from "../src/migrate-track";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function git(vault: string, ...args: string[]): string {
  return execFileSync("git", ["-C", vault, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
}

function tempVault(): { vault: string; work: string } {
  const vault = mkdtempSync(join(tmpdir(), "pablo-migrate-track-"));
  cpSync(FIXTURE, vault, { recursive: true });
  git(vault, "init", "-q", "-b", "main");
  git(vault, "add", "-A");
  git(vault, "commit", "-q", "-m", "fixture");
  return { vault, work: join(vault, "novels", "ice-house") };
}

test("--dry-run reports the change and the missing stages and writes nothing", () => {
  const { vault, work } = tempVault();
  const before = readFileSync(join(work, "pablo.json"), "utf8");
  const r = migrateTrack(vault, work, { track: "historical-fiction", dryRun: true });
  expect(r.ok && r.dryRun && !r.committed).toBe(true);
  if (!r.ok) return;
  expect(r.from).toBe("fiction");
  expect(r.paths).toEqual(["pablo.json"]);
  expect(r.missingStages).toEqual(["period", "period-facts"]);
  expect(readFileSync(join(work, "pablo.json"), "utf8")).toBe(before);
  expect(git(vault, "log", "--oneline").trim().split("\n")).toHaveLength(1);
});

test("the real run writes track, commits only pablo.json with a pablo trailer; a second run changes nothing", () => {
  const { vault, work } = tempVault();
  writeFileSync(join(work, "notes-scratch.txt"), "unrelated, untracked\n");
  const r = migrateTrack(vault, work, { track: "historical-fiction", dryRun: false });
  expect(r.ok && r.committed).toBe(true);
  const marker = readMarker(work);
  expect(marker.ok && trackOf(marker.marker)).toBe("historical-fiction");
  expect(git(vault, "show", "--name-only", "--format=%B", "HEAD")).toContain("Pablo-Migrate: track=historical-fiction");
  expect(git(vault, "show", "--name-only", "--format=", "HEAD").trim()).toBe("novels/ice-house/pablo.json");
  const again = migrateTrack(vault, work, { track: "historical-fiction", dryRun: false });
  expect(again.ok && again.changes.length === 0 && !again.committed).toBe(true);
  expect(git(vault, "log", "--oneline").trim().split("\n")).toHaveLength(2);
});

test("an unknown or missing track is a refusal naming the allowed ids; uncommitted pablo.json is refused", () => {
  const { vault, work } = tempVault();
  const bad = migrateTrack(vault, work, { track: "poetry", dryRun: false });
  expect(!bad.ok && bad.message).toContain("fiction, historical-fiction, nonfiction");
  expect(migrateTrack(vault, work, { track: undefined, dryRun: false }).ok).toBe(false);
  writeFileSync(join(work, "pablo.json"), `${readFileSync(join(work, "pablo.json"), "utf8")}\n`);
  const dirty = migrateTrack(vault, work, { track: "nonfiction", dryRun: false });
  expect(!dirty.ok && dirty.message).toContain("uncommitted");
});

test("the CLI verb: migrate track --dry-run --json", () => {
  const { vault } = tempVault();
  const r = Bun.spawnSync(["bun", "run", CLI, "migrate", "track", "--project", "ice-house", "--track", "historical-fiction", "--dry-run", "--json"], {
    env: { ...process.env, ...GIT_ENV, PABLO_VAULT: vault },
  });
  expect(r.exitCode).toBe(0);
  expect(JSON.parse(r.stdout.toString()).missingStages).toEqual(["period", "period-facts"]);
});
