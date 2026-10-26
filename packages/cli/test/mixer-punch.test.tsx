import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { CastingDeps, CastingLayout } from "../src/casting";
import { lineTakesText, runTakes, venvPython } from "../src/casting";
import { createMixerHost, mixerMutations } from "../src/mixer-host";
import { createReviewHost, flagsFile } from "../src/review-host";
import type { LineTake, ManifestLine } from "../views/mixer-protocol";
import { PunchPanel, flagLabel, lineOptions, takeLabel } from "../views/mixer-punch";
import type { PunchApi } from "../views/mixer-punch";

/**
 * AGT-2155: the punch list in the mixer. The host over a temp work (a mixed manifest, `flags.json`) and a fake
 * casting machine standing in for `python -m pablo_casting` (`fix --line`, `takes line`, `takes choose`, tested in
 * `packages/casting/tests/test_choose.py`): flags are the review player's own, a re-take runs `fix` on one line
 * with its reason, compare and choose run `takes line` / `takes choose`. The panel as static markup.
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const KEY = (n: number): string => n.toString(16).padStart(64, "0");
const NOW = new Date("2026-10-26T12:00:00Z");
const LINES = [
  { i: 0, speaker: "MAVIS", text: "Who keeps the lamp?", take: KEY(1), start: 0.5, end: 1.5, gates: {}, failing: [] },
  { i: 1, speaker: "OTTO", text: "I do.", take: KEY(2), start: 1.8, end: 2.4, gates: {}, failing: [] },
];

interface Machine {
  readonly deps: CastingDeps;
  readonly calls: string[][];
  respond: (argv: readonly string[]) => { code: number; body: unknown };
}

function setup(): { m: Machine; work: string } {
  const root = mkdtempSync(join(tmpdir(), "pablo-mixer-punch-test-"));
  dirs.push(root);
  const source = join(root, "casting");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "pyproject.toml"), '[project]\nname = "pablo-casting"\n', "utf8");
  writeFileSync(join(source, "uv.lock"), "version = 1\n", "utf8");
  const layout: CastingLayout = { source, venv: join(source, ".venv"), install: "checkout" };
  const work = join(root, "novels", "harbour");
  mkdirSync(join(work, "outputs", "radio", "episodes"), { recursive: true });
  writeFileSync(join(work, "outputs", "radio", "episodes", "01-the-light.md"), "---\ntitle: The Light\n---\n\nCAST: MAVIS, OTTO\n\nMAVIS: Who keeps the lamp?\nOTTO: I do.\n");
  const ep = join(work, "outputs", "radio", "casting", "renders", "ep01");
  mkdirSync(ep, { recursive: true });
  writeFileSync(join(ep, "v1.json"), JSON.stringify({ episode: 1, version: 1, audio: "ep01.v1.m4a", duration: 3, lines: LINES }));
  writeFileSync(join(ep, "ep01.v1.m4a"), "fake audio");
  const m: Machine = {
    calls: [],
    respond: () => ({ code: 0, body: { ok: true } }),
    deps: {
      layout,
      which: () => "/fake/bin/uv",
      run: (argv) => {
        if (argv[1] === "sync") {
          mkdirSync(join(layout.venv, "bin"), { recursive: true });
          writeFileSync(venvPython(layout), "", "utf8");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (argv[3] === "pull") return { code: 0, stdout: JSON.stringify({ ok: true, weights: [] }), stderr: "" };
        m.calls.push(argv.slice(3));
        const answer = m.respond(argv.slice(3));
        return { code: answer.code, stdout: JSON.stringify(answer.body), stderr: "" };
      },
      now: () => NOW,
    },
  };
  return { m, work };
}

const TAKES = {
  ok: true,
  episode: 1,
  line: 1,
  speaker: "OTTO",
  text: "I do.",
  version: 2,
  current: KEY(9),
  takes: [
    { key: KEY(2), versions: [1], status: "pass", attempt: 0, seconds: 0.6, stretch: 1, gates: {}, failing: [], reasons: [], temperature: null, chosen: false, stored: true, created: null, current: false },
    { key: KEY(9), versions: [2], status: "pass", attempt: 4, seconds: 0.7, stretch: 1, gates: {}, failing: [], reasons: ["flat"], temperature: 0.9, chosen: false, stored: true, created: null, current: true },
  ],
};

const host = (m: Machine, work: string) => createMixerHost({ work, title: "Harbour", vault: "/vault", library: "/lib", env: { PATH: "/nowhere" }, casting: m.deps, now: () => NOW });
const flags = (work: string) => JSON.parse(readFileSync(flagsFile(work), "utf8")).flags as Record<string, unknown>[];

test("flag writes pablo review's format, listFlags shows human and auto flags, unflag removes them", () => {
  const { m, work } = setup();
  const h = host(m, work);
  expect(h.listFlags({ episode: 1 })).toEqual({ episode: 1, flags: [] });
  writeFileSync(flagsFile(work), JSON.stringify({ flags: [{ id: "f-auto-1", episode: 1, line: 0, reason: "best of 4 failed: pace", by: "auto" }] }));

  const flagged = h.flag({ episode: 1, line: 1, reason: "flat" });
  expect(flagged.flags.map((f) => [f.line, f.source, f.reason])).toEqual([
    [0, "auto", "best of 4 failed: pace"],
    [1, "human", "flat"],
  ]);
  // Byte for byte what the review player writes for the same flag.
  const viaReview = setup();
  createReviewHost({ work: viaReview.work, title: "Harbour", now: () => NOW }).flag({ episode: 1, line: 1, reason: "flat" });
  expect(flags(work)[1]).toEqual(flags(viaReview.work)[0] as Record<string, unknown>);

  expect(() => h.flag({ episode: 1, line: 1, reason: "loud" })).toThrow("reason must be one of");
  expect(h.unflag({ episode: 1, line: 1 }).flags.map((f) => f.line)).toEqual([0]);
  expect(m.calls).toEqual([]); // flags never touch the Python side
});

test("retake flags the line with its reason, then runs fix on that line only and returns the line's takes", async () => {
  const { m, work } = setup();
  m.respond = (argv) =>
    argv[0] === "fix"
      ? { code: 0, body: { ok: true, episode: 1, version: 2, fromVersion: 1, changedLines: [1], mixed: true, message: "episode 1 v2: re-recorded line(s) 1 from v1; remixed -> ep01.v2.m4a" } }
      : { code: 0, body: TAKES };
  const done = await host(m, work).retake({ episode: 1, line: 1, reason: "rushed" });
  expect(flags(work).map((f) => [f["line"], f["reason"], f["by"]])).toEqual([[1, "rushed", "human"]]);
  const fix = m.calls.find((c) => c[0] === "fix");
  expect(fix).toEqual(["fix", "--episode=1", "--line=1", "--vault=/vault", "--library=/lib", "--work", work, "--json"]);
  expect(m.calls.at(-1)).toEqual(["takes", "line", "--episode", "1", "--line", "1", "--work", work, "--json"]);
  expect([done.version, done.fromVersion, done.changedLines, done.mixed]).toEqual([2, 1, [1], true]);
  expect(done.takes.takes.map((t) => t.current)).toEqual([false, true]);
});

test("retake refuses a line with no open flag and no reason, running nothing; a fix refusal is thrown in its words", async () => {
  const { m, work } = setup();
  await expect(host(m, work).retake({ episode: 1, line: 1 })).rejects.toThrow("has no open flag");
  expect(m.calls).toEqual([]);
  await expect(host(m, work).retake({ episode: 1, line: 1, reason: "nope" })).rejects.toThrow("reason must be one of");
  m.respond = () => ({ code: 2, body: { ok: false, code: 2, message: "the cast changed since v1" } });
  await expect(host(m, work).retake({ episode: 1, line: 1, reason: "flat" })).rejects.toThrow("the cast changed since v1");
});

test("chooseTake runs takes choose with the key, episode, line and the cue library, then relists", async () => {
  const { m, work } = setup();
  m.respond = (argv) => (argv[1] === "choose" ? { code: 0, body: { ok: true, version: 3, mixed: true, message: "episode 1 v3: line 1 is back on take 000000000000" } } : { code: 0, body: TAKES });
  const chosen = await host(m, work).chooseTake({ episode: 1, line: 1, take: KEY(2) });
  expect(m.calls[0]).toEqual(["takes", "choose", KEY(2), "--episode", "1", "--line", "1", "--work", work, "--vault", "/vault", "--library", "/lib", "--json"]);
  expect([chosen.version, chosen.mixed, chosen.take]).toEqual([3, true, KEY(2)]);
  await expect(host(m, work).chooseTake({ episode: 1, line: 1, take: "abc" })).rejects.toThrow("64-character");
  const listed = await mixerMutations(host(m, work))["lineTakes"]!({ episode: 1, line: 1 });
  expect((listed as { speaker: string }).speaker).toBe("OTTO");
});

test("pablo takes line and choose need --episode and --line; the text form stars the current take", async () => {
  const { m, work } = setup();
  const ctx = { env: { PATH: "/nowhere" }, stderr: { write: () => undefined } };
  const missing = await runTakes({ sub: "line", key: undefined, yes: false, episode: 1 }, ctx, m.deps, work);
  expect([missing.exitCode, (missing.body as { missing: string[] }).missing]).toEqual([2, ["--line I"]]);
  expect((await runTakes({ sub: "choose", key: undefined, yes: false, episode: 1, line: 1 }, ctx, m.deps, work)).exitCode).toBe(1);
  expect(m.calls).toEqual([]);
  const text = lineTakesText(TAKES);
  expect(text.split("\n")).toEqual([
    "episode 1 line 1 (OTTO): I do.",
    `  ${KEY(2).slice(0, 12)}  pass  0.6 s  in v1`,
    `* ${KEY(9).slice(0, 12)}  pass  0.7 s  in v2 fixed for flat`,
  ]);
});

const MLINES: ManifestLine[] = LINES.map((l) => ({ i: l.i, speaker: l.speaker, text: l.text, take: l.take, stretch: 1, start: l.start, end: l.end }));

test("labels: a flag names its line, speaker and reason (auto: its failing gates); flagged lines come first", () => {
  expect(flagLabel({ id: "a", episode: 1, line: 1, reason: "flat", time: 1.8, source: "human", failing: [] }, MLINES)).toBe("L1 OTTO · flat");
  expect(flagLabel({ id: "b", episode: 1, line: 0, reason: "best of 4 failed: pace", time: 0.5, source: "auto", failing: ["pace"] }, MLINES)).toBe("L0 MAVIS · auto: pace");
  expect(lineOptions(MLINES, [{ id: "a", episode: 1, line: 1, reason: "flat", time: 0, source: "human", failing: [] }]).map((l) => l.i)).toEqual([1, 0]);
  expect(takeLabel(TAKES.takes[1] as LineTake)).toBe(`${KEY(9).slice(0, 8)} · pass · 0.70 s · re-take for flat · v2`);
});

const api = (over: Partial<PunchApi> = {}): PunchApi => ({
  flags: [{ id: "a", episode: 1, line: 1, reason: "flat", time: 1.8, source: "human", failing: [] }],
  line: 1,
  reason: "flat",
  takes: TAKES as unknown as PunchApi["takes"],
  busy: null,
  status: null,
  failed: false,
  playing: null,
  select: () => undefined,
  setReason: () => undefined,
  flag: () => undefined,
  unflag: () => undefined,
  retake: () => undefined,
  compare: () => undefined,
  play: () => undefined,
  choose: () => undefined,
  ...over,
});

test("the panel lists the flags, the line's actions and its takes; only a take not in use can be chosen", () => {
  const html = renderToStaticMarkup(<PunchPanel api={api()} lines={MLINES} locked={false} onJump={() => undefined} />);
  expect(html).toContain("Punch list (1)");
  expect(html).toContain("L1 OTTO · flat");
  for (const name of ["Flag", "Unflag", "Re-take", "Compare takes"]) expect(html).toMatch(new RegExp(`<button[^>]*>${name}</button>`));
  expect((html.match(/>Choose<\/button>/g) ?? []).length).toBe(1);
  expect(html).toContain("in use");

  const locked = renderToStaticMarkup(<PunchPanel api={api()} lines={MLINES} locked onJump={() => undefined} />);
  expect(locked).toMatch(/<button[^>]*disabled[^>]*>Re-take<\/button>/);
  expect(locked).toMatch(/<button[^>]*disabled[^>]*>Choose<\/button>/);
  expect(locked).toContain("Save your mix edits first");
});
