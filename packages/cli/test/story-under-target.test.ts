/**
 * AGT-2286: a draft far under its word target says what to do next and carries `underTarget`, and a
 * story over many beats is drafted beat by beat (one request per beat, stitched into the one unit).
 * Scripted writer on a temp copy of the fixture vault: no model, never `~/writing`.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, CompletionEvent } from "@openthink/pablo-core";
import { addOutput } from "../src/output-verbs";
import { runWrite } from "../src/write";
import type { WriteArgs } from "../src/write";
import { useLocalConfigHome } from "./local-config";

useLocalConfigHome();

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");
const STATE_HOME = mkdtempSync(join(tmpdir(), "pablo-under-target-state-"));
afterAll(() => rmSync(STATE_HOME, { recursive: true, force: true }));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  return result.stdout.toString("utf8").trim();
}

/** The fixture vault in a temp git repository, Mrs. Frayne's [pick] decided so every beat is ready. */
function vault(): { vault: string; work: string; home: string } {
  const dir = mkdtempSync(join(tmpdir(), "pablo-under-target-"));
  dirs.push(dir);
  const root = join(dir, "vault");
  cpSync(FIXTURE_VAULT, root, { recursive: true });
  const work = join(root, "novels", "ice-house");
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as Record<string, unknown>;
  delete marker["format"];
  writeFileSync(join(work, "pablo.json"), `${JSON.stringify({ ...marker, outputs: { novel: { dir: "chapters", added: "2026-09-01" } } }, null, 2)}\n`);
  const tree = join(work, "bible", "characters", "family-tree.md");
  writeFileSync(tree, readFileSync(tree, "utf8").replace("Mrs. Frayne [pick]", "Mrs. Frayne"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "pablo-test@example.com");
  git(root, "config", "user.name", "Pablo Test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  return { vault: root, work, home: join(dir, "pablo-home") };
}


/** Each request gets the next scripted answer (the last repeats); every prompt is kept. */
function scriptedWriter(answers: string[], prompts: string[]): Adapter {
  let call = 0;
  return {
    id: "local",
    model: "test-writer-model",
    preferredOutput: "text",
    async *complete(request: { prompt?: string } | string): AsyncIterable<CompletionEvent> {
      prompts.push(typeof request === "string" ? request : (request.prompt ?? ""));
      const text = answers[Math.min(call, answers.length - 1)] as string;
      call += 1;
      yield { type: "token", text };
      yield { type: "done", stats: { timeToFirstTokenMs: 10, elapsedMs: 20, tokensRead: 100, tokensWritten: 12, tokensPerSecond: 600 } };
    },
    async proposeEdit(): Promise<never> {
      throw new Error("not used");
    },
    async extractFacts(): Promise<never> {
      throw new Error("not used");
    },
  };
}

/** Grow the fixture's four beats to `total` (Act I rows 5..total), all POV Odile and already ready. */
function withBeats(v: { work: string }, total: number): void {
  const path = join(v.work, "outline", "chapters.md");
  const rows = Array.from({ length: total - 4 }, (_, i) => `| ${i + 5} | 1934 | Beat ${i + 5} | Something happens in beat ${i + 5}. | Odile | outline |`);
  const text = readFileSync(path, "utf8");
  writeFileSync(path, text.replace(/(\| 4 \|[^\n]*\n)/, `$1${rows.join("\n")}\n`));
}

async function write(
  v: { vault: string; work: string; home: string },
  args: Partial<WriteArgs>,
  answers: string[],
  prompts: string[] = [],
): Promise<{ code: number; body: Record<string, unknown>; stderr: string }> {
  const lines: string[] = [];
  let stderr = "";
  const log = console.log;
  console.log = (text: unknown) => void lines.push(String(text));
  try {
    const code = await runWrite(
      { chapter: undefined, words: undefined, scenes: undefined, dryRun: false, json: true, force: false, ...args },
      v.vault,
      v.work,
      {
        adapter: scriptedWriter(answers, prompts),
        env: { PATH: NO_THINK_PATH, XDG_STATE_HOME: STATE_HOME, PABLO_HOME: v.home },
        stderr: { write: (text: string) => void (stderr += text) },
        now: () => new Date("2026-10-12T12:00:00Z"),
      },
    );
    return { code, body: JSON.parse(lines.join("\n")) as Record<string, unknown>, stderr };
  } finally {
    console.log = log;
  }
}

const SHORT = "Odile drove the route alone that winter. The ice rang wrong under the horse.";

test("AC1/AC3: a short draft over a four-beat story carries underTarget and says what to do next", async () => {
  const v = vault();
  addOutput(v.vault, v.work, "story", { now: () => new Date(2026, 9, 12) });
  const prompts: string[] = [];
  const out = await write(v, { output: "story", words: "2400" }, [SHORT], prompts);
  expect(out.code).toBe(0);
  // Four beats stay one request: the proven single-pack form.
  expect(prompts).toHaveLength(1);
  expect(out.body["underTarget"]).toBe(true);
  expect(String(out.body["lengthWarning"])).toContain("under the 2400-word target");
  expect(String(out.body["lengthWarning"])).toContain("re-draft with --force");
});

test("a draft within 10% of target has no underTarget and no warning", async () => {
  const v = vault();
  addOutput(v.vault, v.work, "story", { now: () => new Date(2026, 9, 12) });
  const out = await write(v, { output: "story", words: "14" }, [SHORT]);
  expect(out.body["underTarget"]).toBeUndefined();
  expect(out.body["lengthWarning"]).toBeUndefined();
});

test("an over-long draft warns but is not underTarget", async () => {
  const v = vault();
  addOutput(v.vault, v.work, "story", { now: () => new Date(2026, 9, 12) });
  const out = await write(v, { output: "story", words: "5" }, [SHORT]);
  expect(out.body["underTarget"]).toBeUndefined();
  expect(String(out.body["lengthWarning"])).toContain("over the 5-word target");
});

test("AC2: a story over more than four beats is drafted one request per beat and stitched into the one unit", async () => {
  const v = vault();
  withBeats(v, 6);
  addOutput(v.vault, v.work, "story", { now: () => new Date(2026, 9, 12) });
  const answers = [1, 2, 3, 4, 5, 6].map((n) => `Part ${n} opens. ${"word ".repeat(18)}Part ${n} ends.`);
  const prompts: string[] = [];
  const out = await write(v, { output: "story", words: "600" }, answers, prompts);
  expect(out.code).toBe(0);
  expect(prompts).toHaveLength(6);
  // Each request carries its own beat, its share of the words (600 / 6 = 100), and part n of 6.
  expect(prompts[2]).toContain("part 3 of 6 of the story");
  expect(prompts[2]).toContain("The Route");
  expect(prompts[2]).not.toContain("The Hoist");
  expect(prompts[2]).toContain("about 100 words");
  // Part 1 is not given a tail; part 2 continues from part 1's text; only the last part closes.
  expect(prompts[0]).not.toContain("Part 1 opens");
  expect(prompts[1]).toContain("Part 1 ends.");
  expect(prompts[1]).toContain("Do not close the piece");
  expect(prompts[5]).toContain("close the piece");
  // One unit: one file, one commit, parts in order; the receipt sums every request.
  expect(git(v.vault, "show", "--name-only", "--format=", "draft/story")).toBe("novels/ice-house/outputs/story/story.md");
  expect(git(v.vault, "rev-list", "--count", "main..draft/story")).toBe("1");
  const text = git(v.vault, "show", "draft/story:novels/ice-house/outputs/story/story.md");
  for (let n = 1; n < 6; n += 1) expect(text.indexOf(`Part ${n} opens`)).toBeLessThan(text.indexOf(`Part ${n + 1} opens`));
  const receipt = out.body["receipt"] as { tokensWritten: number; tokensRead: number; wallMs: number; words: number };
  expect(receipt.tokensWritten).toBe(72);
  expect(receipt.tokensRead).toBe(600);
  expect(receipt.wallMs).toBe(120);
  expect(receipt.words).toBeGreaterThan(100);
  // 6 x 22 words is about 132 against 600: still reported under target.
  expect(out.body["underTarget"]).toBe(true);
});

test("beat by beat: an empty answer for one beat discards the branch and writes nothing", async () => {
  const v = vault();
  withBeats(v, 5);
  addOutput(v.vault, v.work, "story", { now: () => new Date(2026, 9, 12) });
  const out = await write(v, { output: "story" }, ["Part one text here.", "   "]);
  expect(out.code).toBe(2);
  expect(git(v.vault, "branch", "--list", "draft/*")).toBe("");
});

test("--dry-run on a long story says a real run drafts beat by beat", async () => {
  const v = vault();
  withBeats(v, 6);
  addOutput(v.vault, v.work, "story", { now: () => new Date(2026, 9, 12) });
  const out = await write(v, { output: "story", dryRun: true }, [SHORT]);
  expect(out.body["beatByBeat"]).toBe(6);
});
