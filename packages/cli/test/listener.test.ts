/**
 * AGT-2323: the `listener` check. Can a radio script be followed by ear? The model is always a fake `Ask`; nothing
 * here reaches a model. The work is a temp copy of the synthetic fixture vault (never ~/writing).
 */

import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Ask } from "../src/critique";
import { LISTENER_STRICT_RETRY, beatsPrompt, heardLines, listenToEpisode, listenerDirection, listenerModel, listenerPrompt, parseListenerReply, runListener } from "../src/listener";
import type { ListenerHit } from "../src/listener";
import type { CastingDeps } from "../src/casting";
import { VERBS } from "../src/verbs";
import type { VerbContext } from "../src/verbs";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");

const SCRIPT = `---
episode: 2
title: Black Ice
story_date: Winter 1931
model: test
prompt_hash: abc
---

# Episode 2

CAST: NARRATOR=m "fifties, dry", WILFRED=m "gruff", ODILE=f "sharp"
[BED: wind across a frozen lake, a horse's harness jingling]
NARRATOR: The ice rang wrong under the horse.
[SFX: a long crack splits the ice]
WILFRED: (shouting) Bring Dorcas round!
ODILE: (quietly) (beat)
[MUSIC: the theme, an organ swell]
ODILE: I will not weigh what comes off that ice.
A stage direction nobody hears.
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete listenerModel.ask;
});

/** A fake model answering the listener prompt and the beats prompt from canned replies, recording each prompt. */
function fakeAsk(listener: string | string[], beats = '{"missed": []}'): Ask & { prompts: string[] } {
  const queue = Array.isArray(listener) ? [...listener] : [listener];
  const prompts: string[] = [];
  const ask = (async (prompt: string) => {
    prompts.push(prompt);
    if (prompt.includes("Compare the retelling to the beats")) return beats;
    return (queue.length > 1 ? queue.shift() : queue[0]) as string;
  }) as Ask & { prompts: string[] };
  ask.prompts = prompts;
  return ask;
}

const BEATS = [{ n: 2, title: "Black Ice", beat: "Wilfred puts the crew out on ice that rings wrong; Odile refuses to weigh the catch." }];

test("heardLines: only what a listener hears, numbered by file line; cue descriptions and delivery notes are never heard", () => {
  const heard = heardLines(SCRIPT);
  expect(heard).toEqual([
    { line: 12, text: "(a sound)" },
    { line: 13, text: "NARRATOR: The ice rang wrong under the horse." },
    { line: 14, text: "(a sound)" },
    { line: 15, text: "WILFRED: Bring Dorcas round!" },
    { line: 17, text: "(music)" },
    { line: 18, text: "ODILE: I will not weigh what comes off that ice." },
  ]);
  const prompt = listenerPrompt("ep02", heard);
  for (const unheard of ["wind across a frozen lake", "a long crack", "organ swell", "shouting", "CAST:", "nobody hears", "fifties"]) {
    expect(prompt).not.toContain(unheard);
  }
  // The four questions, the restart question among them.
  expect(prompt).toContain("Retell the story");
  expect(prompt).toContain("could not follow");
  expect(prompt).toContain("sounds like a restart");
  expect(prompt).toContain('"yes", "mostly" or "no"');
});

test("listenToEpisode: confusions and repeats are hits on the line they point at; the blind listener never sees the beats; a missed beat is a hit too", async () => {
  const ask = fakeAsk(
    JSON.stringify({
      retelling: "Someone is on a frozen lake. There is a crack.",
      confusions: [{ line: "L3", what: "what was that sound?" }, { line: 4, what: "who is Dorcas?" }],
      repeats: [{ line: 6, what: "sounds like a second ending" }],
      verdict: "mostly",
    }),
    JSON.stringify({ missed: [{ beat: "B2", line: "L6", why: "the refusal to weigh is not understood" }, { beat: 9, line: 1, why: "not a shown beat" }] }),
  );
  const result = await listenToEpisode(SCRIPT, "outputs/radio/episodes/02-black-ice.md", BEATS, ask, 2);
  expect(result.verdict).toBe("mostly");
  expect(result.passed).toBe(false);
  expect(result.retelling).toContain("frozen lake");
  const hits = result.hits as ListenerHit[];
  expect(hits.map((h) => [h.line, h.kind, h.excerpt])).toEqual([
    [14, "confusion", "(a sound)"],
    [15, "confusion", "WILFRED: Bring Dorcas round!"],
    [18, "repeat", "ODILE: I will not weigh what comes off that ice."],
    [18, "missed-beat", "ODILE: I will not weigh what comes off that ice."],
  ]);
  expect(hits.every((h) => h.rule === "listener" && h.path === "outputs/radio/episodes/02-black-ice.md")).toBe(true);
  expect(hits.find((h) => h.kind === "missed-beat")).toMatchObject({ beat: 2, detail: 'missed beat 2 "Black Ice": the refusal to weigh is not understood' });
  // Two calls: the listener's has no beat; the comparison's has the beats and the retelling.
  expect(ask.prompts).toHaveLength(2);
  expect(ask.prompts[0]).not.toContain("Odile refuses to weigh");
  expect(ask.prompts[1]).toContain("Odile refuses to weigh");
  expect(ask.prompts[1]).toContain("Someone is on a frozen lake");
});

test("listenToEpisode: passes only on yes with no beat missed; a confusion with no line is kept on the first heard line", async () => {
  const pass = await listenToEpisode(SCRIPT, "ep.md", BEATS, fakeAsk('{"retelling": "r", "confusions": [], "repeats": [], "verdict": "yes"}'));
  expect(pass).toMatchObject({ verdict: "yes", passed: true, hits: [] });

  const missed = await listenToEpisode(SCRIPT, "ep.md", BEATS, fakeAsk('{"retelling": "r", "confusions": [], "repeats": [], "verdict": "yes"}', '{"missed": [{"beat": 2, "why": "gone"}]}'));
  expect(missed.passed).toBe(false);
  expect(missed.hits[0]).toMatchObject({ line: 12, kind: "missed-beat", detail: 'missed beat 2 "Black Ice": gone (no line given)' });

  const unplaced = await listenToEpisode(SCRIPT, "ep.md", [], fakeAsk('{"retelling": "r", "confusions": [{"line": 99, "what": "lost"}], "repeats": [], "verdict": "no"}'));
  expect(unplaced.hits).toEqual([expect.objectContaining({ line: 12, kind: "confusion", detail: "confusion: lost (no line given)" })]);
});

test("an unreadable listener reply is asked once more with the strict instruction; a second is an error", async () => {
  const ask = fakeAsk(["I think it is fine.", '{"retelling": "r", "confusions": [], "repeats": [], "verdict": "yes"}']);
  const result = await listenToEpisode(SCRIPT, "ep.md", [], ask);
  expect(result.passed).toBe(true);
  expect(ask.prompts[1]).toContain(LISTENER_STRICT_RETRY);
  await expect(listenToEpisode(SCRIPT, "ep.md", [], fakeAsk("nope"))).rejects.toThrow("not the listener JSON");
  expect(() => parseListenerReply('{"verdict": "perhaps"}', 3)).toThrow();
});

test("listenerDirection is one line naming each point and the line it points at", () => {
  const direction = listenerDirection({
    path: "ep.md",
    verdict: "mostly",
    passed: false,
    retelling: "",
    hits: [{ path: "ep.md", line: 14, rule: "listener", kind: "confusion", excerpt: "(a sound)", detail: "confusion: what was that sound?" }],
  });
  expect(direction).not.toContain("\n");
  expect(direction).toContain('"mostly"');
  expect(direction).toContain('confusion: what was that sound? (at "(a sound)")');
  expect(beatsPrompt("ep", BEATS, "r", heardLines(SCRIPT))).toContain("B2. Black Ice:");
});

test("runListener: no model is a notice and nothing is sent", async () => {
  const run = await runListener({ workDir: "/nowhere", files: ["/nowhere/a.md"], unitOf: () => 1, ask: () => "no provider is configured" });
  expect(run).toEqual({ units: [], hits: [], notRun: 1, notice: "listener not run: no provider is configured (1 episode not run)" });
});

// --- AC1/AC2 through the check verb --------------------------------------------------------------------------------

function radioWork(): { vault: string; work: string; ctx: VerbContext } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pablo-listener-")));
  dirs.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as Record<string, unknown>;
  delete marker["format"];
  writeFileSync(join(work, "pablo.json"), `${JSON.stringify({ ...marker, outputs: { novel: { dir: "chapters", added: "2026-09-01" }, radio: { added: "2026-10-12" } } }, null, 2)}\n`);
  mkdirSync(join(work, "outputs", "radio", "episodes"), { recursive: true });
  // No CAST: line, so the Python side's radio check is never asked.
  writeFileSync(join(work, "outputs", "radio", "episodes", "02-black-ice.md"), SCRIPT.replace(/^CAST:.*\n/m, ""));
  const casting = { run: () => { throw new Error("the casting side must not run"); } } as unknown as CastingDeps;
  const env = { PATH: NO_THINK_PATH, PABLO_VAULT: vault, PABLO_HOME: join(dir, "pablo-home"), HOME: dir, XDG_CONFIG_HOME: join(dir, "config") };
  return { vault, work, ctx: { cwd: vault, env, stderr: { write: () => {} }, casting } };
}

const checkVerb = VERBS.find((v) => v.name === "check")!;

test("AC1/AC2: check --output radio adds listener hits from the check model, compared to the episode's beats from the outline", async () => {
  const { ctx } = radioWork();
  const ask = fakeAsk(
    '{"retelling": "A man on ice.", "confusions": [{"line": 2, "what": "whose horse?"}], "repeats": [], "verdict": "no"}',
    '{"missed": [{"beat": 2, "line": 6, "why": "never learn Odile refuses"}]}',
  );
  listenerModel.ask = ask;
  const result = await checkVerb.run(checkVerb.args.parse({ project: "ice-house", output: "radio" }) as never, ctx);
  expect(result.exitCode).toBe(0);
  const body = result.body as Record<string, any>;
  const listener = (body.hits as ListenerHit[]).filter((h) => h.rule === "listener");
  expect(listener.map((h) => [h.kind, h.line])).toEqual([
    ["confusion", 12],
    ["missed-beat", 17],
  ]);
  expect(body.listener.units).toEqual([{ path: "outputs/radio/episodes/02-black-ice.md", unit: 2, verdict: "no", passed: false, retelling: "A man on ice." }]);
  // The beat came from the work's outline (episode 2 tells beat 2).
  expect(ask.prompts[1]).toContain("Odile refuses to weigh what comes off it");

  // Without output radio, no listener check and no model call.
  const before = ask.prompts.length;
  const plain = await checkVerb.run(checkVerb.args.parse({ project: "ice-house", output: "novel" }) as never, ctx);
  expect((plain.body as Record<string, any>).listener).toBeUndefined();
  expect(ask.prompts.length).toBe(before);
});
