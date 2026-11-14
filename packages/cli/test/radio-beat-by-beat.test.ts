/**
 * AGT-2322: a radio episode over several beats is drafted beat by beat (one request per beat, each told where to
 * stop), stitched into the one episode file with a single CAST line. Scripted writer on a temp copy of the fixture
 * vault: no model, never `~/writing`.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, CompletionEvent } from "@openthink/pablo-core";
import { addOutput } from "../src/output-verbs";
import { stitchRadioParts, trimRadioPart } from "../src/outputs/radio/pack";
import { scriptRoles } from "../src/outputs/radio/script";
import { runWrite } from "../src/write";
import type { WriteArgs } from "../src/write";
import { useLocalConfigHome } from "./local-config";

useLocalConfigHome();

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");
const STATE_HOME = mkdtempSync(join(tmpdir(), "pablo-radio-bbb-state-"));
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

/** The fixture vault in a temp git repo with the radio output added and episode 1 mapped onto `beats` (a plan cell). */
function vault(beats: string): { vault: string; work: string; home: string } {
  const dir = mkdtempSync(join(tmpdir(), "pablo-radio-bbb-"));
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
  const added = addOutput(root, work, "radio", { now: () => new Date("2026-10-12T12:00:00Z") });
  if (!added.ok) throw new Error(`output add failed: ${JSON.stringify(added)}`);
  const plan = join(work, "outputs", "radio", "plan.md");
  const lines = readFileSync(plan, "utf8").split("\n");
  const at = lines.findIndex((l) => /^\|\s*1\s*\|/.test(l));
  const cells = (lines[at] as string).split("|");
  const beatsAt = 3; // | unit | title | beats | status |
  cells[beatsAt] = ` ${beats} `;
  lines[at] = cells.join("|");
  writeFileSync(plan, lines.join("\n"));
  return { vault: root, work, home: join(dir, "pablo-home") };
}

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

async function write(
  v: { vault: string; work: string; home: string },
  args: Partial<WriteArgs>,
  answers: string[],
  prompts: string[] = [],
): Promise<{ code: number; body: Record<string, unknown>; text: string }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (text: unknown) => void lines.push(String(text));
  try {
    const code = await runWrite(
      { chapter: undefined, words: undefined, scenes: undefined, dryRun: false, json: true, force: false, output: "radio", unit: "1", ...args },
      v.vault,
      v.work,
      {
        adapter: scriptedWriter(answers, prompts),
        env: { PATH: NO_THINK_PATH, XDG_STATE_HOME: STATE_HOME, PABLO_HOME: v.home },
        stderr: { write: () => undefined },
        now: () => new Date("2026-10-12T12:00:00Z"),
      },
    );
    const text = lines.join("\n");
    return { code, body: text.trim().startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : {}, text };
  } finally {
    console.log = log;
  }
}

const OPEN = [
  'CAST: ANNOUNCER=m "fifties, formal", NARRATOR=f "forties, plain", ODILE=f "thirties, dry"',
  "[MUSIC: theme]",
  "ANNOUNCER: The Last Full Cut, episode one.",
  "NARRATOR: January, the pond.",
  "ODILE: (dry) PART-ONE line.",
  "[SFX: a saw]",
].join("\n");
const MIDDLE = ['CAST: WILFRED=m "thirties, quick", ODILE=f "thirties, other words"', "WILFRED: PART-TWO line.", "ODILE: PART-TWO reply."].join("\n");
const CLOSE = ['CAST: MRS FRAYNE=f "sixties, sharp"', "MRS FRAYNE: PART-THREE line.", "[SFX: a gate]", "ANNOUNCER: Next week.", "[MUSIC: theme out]"].join("\n");

test("AC1/AC2: an episode over three beats is three requests, one CAST line, only the first opens and the last closes", async () => {
  const v = vault("1-3");
  const prompts: string[] = [];
  const out = await write(v, { words: "900" }, [OPEN, MIDDLE, CLOSE], prompts);
  expect(out.code).toBe(0);
  expect(prompts).toHaveLength(3);
  // Each request carries its own beat and its share of the words (900 / 3 = 300).
  expect(prompts[1]).toContain("part 2 of 3 of episode 1");
  expect(prompts[1]).toContain("Black Ice");
  expect(prompts[1]).not.toContain("loaded sled going up the ramp");
  expect(prompts[1]).toContain("About 300 spoken words");
  // Only the first opens; the middle is told not to recap or close, and names where to stop.
  expect(prompts[0]).toContain("Open the episode");
  expect(prompts[1]).toContain("Do not open the episode");
  expect(prompts[1]).toContain("no recap");
  expect(prompts[1]).toContain("Do not close the episode");
  expect(prompts[1]).toContain("Every beat after this one belongs to a later request");
  expect(prompts[1]).toContain('The next beat is "The Route"');
  expect(prompts[0]).toContain('The next beat is "Black Ice"');
  expect(prompts[2]).toContain("This is the last part");
  expect(prompts[2]).not.toContain("The next beat is");
  // Later requests are given the end of the script so far, line by line, never its CAST line.
  expect(prompts[1]).toContain("PART-ONE line.");
  expect(prompts[2]).toContain("PART-TWO reply.");
  const text = git(v.vault, "show", "draft/radio-ep01:novels/ice-house/outputs/radio/episodes/01-the-last-full-cut.md");
  expect(text.match(/^CAST:/gm)).toHaveLength(1);
  expect(scriptRoles(text)).toEqual(["ANNOUNCER", "NARRATOR", "ODILE", "WILFRED", "MRS FRAYNE"]);
  expect(text.indexOf("PART-ONE")).toBeLessThan(text.indexOf("PART-TWO line"));
  expect(text.indexOf("PART-TWO line")).toBeLessThan(text.indexOf("PART-THREE"));
  expect(text.match(/^ANNOUNCER:/gm)).toHaveLength(2);
  expect(git(v.vault, "rev-list", "--count", "main..draft/radio-ep01")).toBe("1");
  const receipt = out.body["receipt"] as { tokensWritten: number; tokensRead: number };
  expect(receipt.tokensWritten).toBe(36);
  expect(receipt.tokensRead).toBe(300);
});

test("an episode over one beat stays one request", async () => {
  const v = vault("1");
  const prompts: string[] = [];
  const out = await write(v, {}, [OPEN], prompts);
  expect(out.code).toBe(0);
  expect(prompts).toHaveLength(1);
});

test("a part that ran on into later beats (an early close) is trimmed at the boundary", async () => {
  const v = vault("1-3");
  const early = [OPEN, "ODILE: PART-ONE-RAN-ON line.", "[MUSIC: closing theme]", "ANNOUNCER: Early sign-off.", "[MUSIC: theme out]"].join("\n");
  const out = await write(v, {}, [early, MIDDLE, CLOSE]);
  expect(out.code).toBe(0);
  const text = git(v.vault, "show", "draft/radio-ep01:novels/ice-house/outputs/radio/episodes/01-the-last-full-cut.md");
  expect(text).toContain("PART-ONE-RAN-ON");
  expect(text).not.toContain("Early sign-off");
  expect(text).not.toContain("closing theme");
  expect(text.match(/^ANNOUNCER:/gm)).toHaveLength(2);
});

test("an empty answer for one beat discards the branch and writes nothing", async () => {
  const v = vault("1-3");
  const out = await write(v, {}, [OPEN, "   "]);
  expect(out.code).toBe(2);
  expect(git(v.vault, "branch", "--list", "draft/*")).toBe("");
});

test("AC3: --dry-run shows the per-beat plan and sends nothing", async () => {
  const v = vault("1-3");
  const prompts: string[] = [];
  const json = await write(v, { dryRun: true, words: "900" }, [OPEN], prompts);
  expect(json.body["beatByBeat"]).toBe(3);
  const plan = json.body["beatPlan"] as string[];
  expect(plan).toHaveLength(3);
  expect(plan[0]).toContain("opens the episode");
  expect(plan[1]).toContain("Black Ice");
  expect(plan[1]).toContain("about 300 words");
  expect(plan[2]).toContain("closes it");
  expect(prompts).toHaveLength(0);
  const human = await write(v, { dryRun: true, json: false }, [OPEN], prompts);
  expect(human.text).toContain("request 2 of 3");
  expect(human.text).toContain("beat by beat");
});

test("trimRadioPart: a later part loses a repeated opening, a non-last part loses a sign-off and an unclosed scene is closed", () => {
  const later = ["[MUSIC: theme]", "ANNOUNCER: Episode one again.", "NARRATOR: Later.", "WILFRED: kept."].join("\n");
  expect(trimRadioPart(later, 2, 3)).toBe("NARRATOR: Later.\nWILFRED: kept.");
  const scene = ["WILFRED: a", "[DRAMA]", "WILFRED: b", "[MUSIC: out]", "ANNOUNCER: bye"].join("\n");
  expect(trimRadioPart(scene, 2, 3)).toBe("WILFRED: a\n[DRAMA]\nWILFRED: b\n[DRAMA: off]");
  expect(trimRadioPart(scene, 3, 3)).toBe(scene);
});

test("stitchRadioParts: one CAST line, the union of roles, first description kept", () => {
  const out = stitchRadioParts([MIDDLE, OPEN]);
  expect(out.split("\n")[0]).toBe('CAST: WILFRED=m "thirties, quick", ODILE=f "thirties, other words", ANNOUNCER=m "fifties, formal", NARRATOR=f "forties, plain"');
  expect(out.match(/^CAST:/gm)).toHaveLength(1);
});
