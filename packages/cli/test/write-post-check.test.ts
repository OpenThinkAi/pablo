// The track's checks after each draft (AGT-2115, pm project `pablo-platform`, D-10): `write` runs them on the fresh unit,
// puts the hits in the receipt, never rewrites the draft, and a check that cannot run is a notice, not a failure.
// A fake writer and fake check models throughout: no test reaches a real model.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, CompletionEvent } from "@openthink/pablo-core";
import { anachronismModel } from "../src/anachronism";
import { factAccuracyModel } from "../src/fact-accuracy";
import type { WriteArgs } from "../src/write";
import { runWrite } from "../src/write";
import { useLocalConfigHome } from "./local-config";

useLocalConfigHome();

const FIXTURE = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");
const TEXT = "The storm came up from the coast. She did not wait for him.";

const roots: string[] = [];
beforeEach(() => {
  anachronismModel.ask = async () => {
    throw new Error("anachronism model is down");
  };
});
afterEach(() => {
  delete anachronismModel.ask;
  delete factAccuracyModel.ask;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** A committed temp copy of the fixture vault; a historical-fiction work gets the period core that opens its gate. */
function tempWork(track?: "historical-fiction"): { vault: string; work: string; env: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "pablo-post-check-"));
  roots.push(root);
  const vault = join(root, "vault");
  cpSync(FIXTURE, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  if (track !== undefined) {
    const marker = join(work, "pablo.json");
    writeFileSync(marker, JSON.stringify({ ...JSON.parse(readFileSync(marker, "utf8")), track }, null, 2));
    writeFileSync(join(work, "bible", "period.md"), "# Period\n\nThe Hudson ice trade, winter 1888-89.\n");
    mkdirSync(join(work, "research"), { recursive: true });
    writeFileSync(join(work, "research", "ice-harvest.md"), "# Ice\n\nRetrieved: 2026-10-26\n\nCut at a foot.\n\n## Sources\n\n- https://example.org/ice\n");
    writeFileSync(join(work, "research", "checklist.md"), "| # | Category | Item | Status | Sources | Waived |\n| --- | --- | --- | --- | --- | --- |\n| 1 | technology | Ice thickness | open | ice-harvest | |\n");
    mkdirSync(join(work, "facts"), { recursive: true });
    writeFileSync(join(work, "facts", "period.md"), "# Period facts\n\n| Fact | Source | Story date |\n|---|---|---|\n| Storms never came up from the coast | research/ice-harvest.md | 1888 |\n");
  }
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "t@example.com");
  git(vault, "config", "user.name", "T");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  return { vault, work, env: { PATH: NO_THINK_PATH, XDG_STATE_HOME: join(root, "state"), PABLO_HOME: join(root, "home") } };
}

function writer(): Adapter {
  return {
    id: "local",
    model: "test-writer",
    preferredOutput: "text",
    async *complete(): AsyncIterable<CompletionEvent> {
      yield { type: "token", text: TEXT };
      yield { type: "done", stats: { timeToFirstTokenMs: 1, elapsedMs: 2, tokensRead: 10, tokensWritten: 5, tokensPerSecond: 1 } };
    },
    async proposeEdit(): Promise<never> {
      throw new Error("not implemented");
    },
    async extractFacts(): Promise<never> {
      throw new Error("not implemented");
    },
  };
}

function args(overrides: Partial<WriteArgs> = {}): WriteArgs {
  return { chapter: "2", words: undefined, scenes: undefined, dryRun: false, json: true, force: false, ...overrides };
}

async function run(t: ReturnType<typeof tempWork>, overrides: Partial<WriteArgs> = {}): Promise<{ code: number; body: Record<string, any> }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = ((...a: unknown[]) => void lines.push(a.map(String).join(" "))) as typeof console.log;
  try {
    const code = await runWrite(args(overrides), t.vault, t.work, { adapter: writer(), env: t.env, stderr: { write: () => {} } });
    return { code, body: JSON.parse(lines[0] as string) as Record<string, any> };
  } finally {
    console.log = original;
  }
}

/** A fake fact-accuracy model: the first sentence contradicts the first fact. */
function contradict(): void {
  factAccuracyModel.ask = async () => `\`\`\`json\n${JSON.stringify({ contradictions: [{ sentence: 1, fact: 1, why: "storms did not" }] })}\n\`\`\``;
}

test("write puts the track's check hits in the receipt and leaves the draft as written", async () => {
  const t = tempWork("historical-fiction");
  contradict();
  const { code, body } = await run(t);
  expect(code).toBe(0);
  const hits = body["check"] as Array<{ rule: string; path: string }>;
  expect(hits.some((h) => h.rule === "fact-accuracy" && h.path === "chapters/02-black-ice.md")).toBe(true);
  // The anachronism model failed: a check error in the notices (AGT-2187), not a failed write.
  expect(body["checkNotices"].join("\n")).toContain("pablo: check error: anachronism");
  // Never a rewrite: the committed text is the model's, whole.
  const file = join(body["worktree"], "novels", "ice-house", "chapters", "02-black-ice.md");
  expect(readFileSync(file, "utf8")).toContain("The storm came up from the coast.");
  expect(git(t.vault, "log", "-1", "--format=%s", "draft/ch02")).toBe("ice-house: draft chapter 2");
});

test("--no-check skips the track's checks: no model is asked and no notice appears", async () => {
  const t = tempWork("historical-fiction");
  let asked = 0;
  factAccuracyModel.ask = async () => {
    asked++;
    return "{}";
  };
  anachronismModel.ask = async () => {
    asked++;
    return "{}";
  };
  const { code, body } = await run(t, { noCheck: true });
  expect(code).toBe(0);
  expect(asked).toBe(0);
  expect(body["checkNotices"]).toBeUndefined();
  expect((body["check"] as Array<{ rule: string }>).some((h) => h.rule === "fact-accuracy")).toBe(false);
});

test("a model that errors is reported, never fatal", async () => {
  const t = tempWork("historical-fiction");
  factAccuracyModel.ask = async () => {
    throw new Error("fact model exploded");
  };
  const { code, body } = await run(t);
  expect(code).toBe(0);
  expect(body["ok"]).toBe(true);
  expect(body["checkNotices"].length).toBeGreaterThan(0);
});

test("a fiction work asks no model and reports no notice", async () => {
  const t = tempWork();
  factAccuracyModel.ask = async () => {
    throw new Error("must not be asked");
  };
  const { code, body } = await run(t);
  expect(code).toBe(0);
  expect(body["checkNotices"]).toBeUndefined();
  expect(Array.isArray(body["check"])).toBe(true);
});
