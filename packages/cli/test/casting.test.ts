import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  castingLayout,
  castingState,
  doctorText,
  ensureProvisioned,
  gateText,
  runCasting,
  runDoctor,
  runGate,
  runTakes,
  takeShowText,
  takesGcText,
  UV_INSTALL,
  venvPython,
} from "../src/casting";
import type { CastingDeps, CastingLayout, CastingRun } from "../src/casting";
import { BUNDLED, bundleCasting } from "../src/casting-bundle";

// AGT-1678: every test here injects `CastingDeps`, so no test needs uv,
// Python or a model, and nothing is written outside a mkdtemp directory.

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function fakeSource(dir: string, lock = "version = 1\n"): void {
  mkdirSync(join(dir, "src", "pablo_casting"), { recursive: true });
  writeFileSync(join(dir, "pyproject.toml"), '[project]\nname = "pablo-casting"\n', "utf8");
  writeFileSync(join(dir, "uv.lock"), lock, "utf8");
}

function fakeLayout(): { layout: CastingLayout; root: string } {
  const root = temp("pablo-casting-");
  const source = join(root, "casting");
  fakeSource(source);
  return { root, layout: { source, venv: join(source, ".venv"), install: "checkout" } };
}

/** A fake machine: `uv sync` creates the venv's python; `python -m pablo_casting <cmd>` answers per `answers`. */
function fakeDeps(
  layout: CastingLayout | undefined,
  options: { uv?: boolean; sync?: number; answers?: Record<string, CastingRun> } = {},
): CastingDeps & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    layout,
    which: (command) => (command === "uv" && options.uv !== false ? "/fake/bin/uv" : undefined),
    run: (argv) => {
      calls.push([...argv]);
      if (argv[1] === "sync") {
        if ((options.sync ?? 0) === 0 && layout) {
          mkdirSync(join(layout.venv, "bin"), { recursive: true });
          writeFileSync(venvPython(layout), "", "utf8");
        }
        return { code: options.sync ?? 0, stdout: "", stderr: "" };
      }
      const command = argv[3] ?? "";
      const answer = options.answers?.[command];
      if (answer) return answer;
      if (command === "pull") return { code: 0, stdout: JSON.stringify({ ok: true, weights: [] }), stderr: "" };
      if (command === "audition") return { code: 0, stdout: JSON.stringify({ ok: true, dryRun: true, message: "no model was loaded" }), stderr: "" };
      if (command === "doctor") return { code: 0, stdout: JSON.stringify({ ok: true, python: "3.12.13", version: "0.1.0" }), stderr: "" };
      return { code: 1, stdout: JSON.stringify({ ok: false, code: 1, message: "unknown" }), stderr: "" };
    },
    now: () => new Date("2026-10-10T12:00:00Z"),
  };
}

function ctx(root: string) {
  const err: string[] = [];
  return {
    err,
    ctx: { env: { XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), PATH: "/nowhere" }, stderr: { write: (t: string) => void err.push(t) } },
  };
}

describe("doctor", () => {
  test("reports `not provisioned` without running uv or downloading anything (AC1)", () => {
    const { layout, root } = fakeLayout();
    const deps = fakeDeps(layout);
    const result = runDoctor(ctx(root).ctx, deps, "9.9.9");

    expect(result.exitCode).toBe(0);
    const body = result.body as { ok: boolean; casting: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.casting["state"]).toBe("not provisioned");
    expect(body.casting["config"]).toBe(join(root, "config", "pablo", "casting.json"));
    expect(deps.calls).toEqual([]);
    expect(existsSync(layout.venv)).toBe(false);
  });

  test("names `brew install uv` when uv is missing, and still exits 0", () => {
    const { layout, root } = fakeLayout();
    const body = runDoctor(ctx(root).ctx, fakeDeps(layout, { uv: false }), "9.9.9").body as { casting: { uv: unknown } };
    expect(body.casting.uv).toEqual({ found: false, install: UV_INSTALL });
  });

  test("asks the Python side for its report once provisioned", () => {
    const { layout, root } = fakeLayout();
    const deps = fakeDeps(layout);
    expect(ensureProvisioned(ctx(root).ctx, deps, undefined).ok).toBe(true);
    const body = runDoctor(ctx(root).ctx, deps, "9.9.9").body as { casting: Record<string, unknown> };
    expect(body.casting["state"]).toBe("provisioned");
    expect(body.casting["python"]).toEqual({ ok: true, python: "3.12.13", version: "0.1.0" });
    expect(deps.calls.at(-1)?.slice(1)).toEqual(["-m", "pablo_casting", "doctor", "--json"]);
  });
});

describe("takes (AGT-1681)", () => {
  const KEY_A = "a".repeat(64);
  const KEY_B = "b".repeat(64);
  const listing = { ok: true, referenced: 3, unreferenced: [{ key: KEY_A, bytes: 10, created: "t" }, { key: KEY_B, bytes: 20, created: "t" }], archived: [] };

  /** A provisioned fake whose `takes` answers come from `answer(argv)`. */
  function takesDeps(answer: (args: readonly string[]) => object) {
    const { layout, root } = fakeLayout();
    const work = join(root, "work");
    mkdirSync(work);
    const base = fakeDeps(layout);
    const deps: CastingDeps & { calls: string[][] } = {
      ...base,
      run: (argv, options) => {
        if (argv[3] !== "takes") return base.run(argv, options);
        base.calls.push([...argv]);
        const body = answer(argv.slice(3)) as { ok?: boolean; code?: number };
        return { code: body.ok === false ? (body.code ?? 1) : 0, stdout: JSON.stringify(body), stderr: "" };
      },
    };
    return { deps, work, root, takesCalls: () => base.calls.filter((call) => call[3] === "takes").map((call) => call.slice(3)) };
  }

  const gcAnswer = (args: readonly string[]) =>
    args.includes("--yes") ? { ...listing, archived: [{ key: KEY_A, to: "/w/archive/takes/s/a" }, { key: KEY_B, to: "/w/archive/takes/s/b" }] } : listing;

  test("show provisions if needed and passes the key and work through", async () => {
    const { deps, work, root, takesCalls } = takesDeps(() => ({ ok: true, key: KEY_A, receipt: "r-1" }));
    const result = await runTakes({ sub: "show", key: "aaaa", yes: false }, ctx(root).ctx, deps, work);
    expect(result.exitCode).toBe(0);
    expect((result.body as { receipt: string }).receipt).toBe("r-1");
    expect(takesCalls()).toEqual([["takes", "show", "aaaa", "--work", work, "--json"]]);
  });

  test("takes need a project; an unknown or missing subcommand is an error", async () => {
    const { deps, root, work, takesCalls } = takesDeps(() => listing);
    expect((await runTakes({ sub: "gc", key: undefined, yes: false }, ctx(root).ctx, deps, undefined)).exitCode).toBe(2);
    expect((await runTakes({ sub: "burn", key: undefined, yes: false }, ctx(root).ctx, deps, work)).exitCode).toBe(1);
    expect((await runTakes({ sub: undefined, key: undefined, yes: false }, ctx(root).ctx, deps, work)).exitCode).toBe(1);
    expect((await runTakes({ sub: "show", key: undefined, yes: false }, ctx(root).ctx, deps, work)).exitCode).toBe(1);
    expect(takesCalls()).toEqual([]);
  });

  test("gc without a terminal and without --yes lists, refuses (exit 2) and archives nothing", async () => {
    const { deps, work, root, takesCalls } = takesDeps(gcAnswer);
    const result = await runTakes({ sub: "gc", key: undefined, yes: false }, ctx(root).ctx, deps, work);
    expect(result.exitCode).toBe(2);
    const body = result.body as { message: string; unreferenced: unknown[]; missing: string[] };
    expect(body.unreferenced).toHaveLength(2);
    expect(body.missing).toEqual(["--yes"]);
    expect(body.message).toContain("--yes");
    expect(takesCalls()).toEqual([["takes", "gc", "--work", work, "--json"]]);
  });

  test("gc on a terminal shows the list, asks, and archives exactly the listed keys on yes", async () => {
    const { deps, work, root, takesCalls } = takesDeps(gcAnswer);
    const { ctx: c, err } = ctx(root);
    const asked: string[] = [];
    const result = await runTakes({ sub: "gc", key: undefined, yes: false }, c, deps, work, async (q) => (asked.push(q), true));
    expect(result.exitCode).toBe(0);
    expect(asked).toHaveLength(1);
    expect(err.join("")).toContain(KEY_A);
    expect(takesCalls().at(-1)).toEqual(["takes", "gc", "--work", work, "--yes", "--key", KEY_A, "--key", KEY_B, "--json"]);
    expect(takesGcText(result.body)).toContain("archived 2 take(s)");
  });

  test("gc declined on a terminal archives nothing", async () => {
    const { deps, work, root, takesCalls } = takesDeps(gcAnswer);
    const result = await runTakes({ sub: "gc", key: undefined, yes: false }, ctx(root).ctx, deps, work, async () => false);
    expect(result.exitCode).toBe(0);
    expect((result.body as { declined: boolean }).declined).toBe(true);
    expect(takesCalls()).toHaveLength(1);
    expect(takesGcText(result.body)).toContain("nothing archived");
  });

  test("gc --yes archives without asking; nothing unreferenced means nothing to ask", async () => {
    const { deps, work, root, takesCalls } = takesDeps(gcAnswer);
    const never = async () => {
      throw new Error("must not ask");
    };
    expect((await runTakes({ sub: "gc", key: undefined, yes: true }, ctx(root).ctx, deps, work, never)).exitCode).toBe(0);
    expect(takesCalls()).toHaveLength(2);

    const empty = takesDeps(() => ({ ok: true, referenced: 4, unreferenced: [], archived: [] }));
    const result = await runTakes({ sub: "gc", key: undefined, yes: false }, ctx(empty.root).ctx, empty.deps, empty.work, never);
    expect(result.exitCode).toBe(0);
    expect(empty.takesCalls()).toHaveLength(1);
    expect(takesGcText(result.body)).toBe("no unreferenced takes (4 referenced by manifests)");
  });

  test("show's text names inputs, scores, timings and the receipt", () => {
    const text = takeShowText({
      ok: true,
      key: KEY_A,
      status: "pass",
      attempt: 0,
      seed: 7,
      receipt: "r-123",
      inputs: { engine: { id: "fake", weights_sha256: "0".repeat(64), mlx_audio: "none", mlx: "none" }, voice: "card", lines: [{ speaker: "CORA", text: "Hush." }], direction: { emotion: "dry" }, params: {} },
      scores: { wer: 0 },
      timings: { words: [{ word: "Hush.", start: 0, end: 0.36 }], wall: 0.01, rtf: 0.02 },
      audio: { duration: 0.54 },
      path: "/w/takes/a",
    });
    for (const expected of ["r-123", "CORA: Hush.", '{"wer":0}', "Hush.@0", "wall 0.01 s", "fake"]) expect(text).toContain(expected);
  });
});

describe("audition --dry-run provisioning (AC2)", () => {
  test("the first call provisions and receipts under the work; the second skips", () => {
    const { layout, root } = fakeLayout();
    const work = join(root, "work");
    mkdirSync(work);
    const deps = fakeDeps(layout);
    const { ctx: c, err } = ctx(root);

    const first = runCasting(["audition", "--dry-run"], c, deps, work);
    expect(first.exitCode).toBe(0);
    expect((first.body as { provisioned: boolean }).provisioned).toBe(true);
    expect(deps.calls[0]).toEqual(["/fake/bin/uv", "sync", "--frozen"]);
    expect(deps.calls[1]).toEqual([venvPython(layout), "-m", "pablo_casting", "pull", "--json", "--work", work]);
    expect(err.join("")).toContain("uv sync --frozen");

    const receipts = readFileSync(join(work, ".pablo", "casting", "receipts.jsonl"), "utf8").trim().split("\n");
    expect(receipts).toHaveLength(1);
    const receipt = JSON.parse(receipts[0] ?? "") as Record<string, unknown>;
    expect(receipt["intent"]).toBe("provision");
    expect(receipt["venv"]).toBe(layout.venv);
    expect(receipt["weights"]).toEqual([]);
    expect(castingState(layout)).toBe("provisioned");

    const syncs = () => deps.calls.filter((call) => call[1] === "sync").length;
    const second = runCasting(["audition", "--dry-run"], c, deps, work);
    expect(second.exitCode).toBe(0);
    expect((second.body as { provisioned: boolean }).provisioned).toBe(false);
    expect(syncs()).toBe(1);
    expect(readFileSync(join(work, ".pablo", "casting", "receipts.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("with no work, the receipt goes to the state directory", () => {
    const { layout, root } = fakeLayout();
    const result = runCasting(["audition", "--dry-run"], ctx(root).ctx, fakeDeps(layout), undefined);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, "state", "pablo", "casting", "receipts.jsonl"))).toBe(true);
  });

  test("a changed uv.lock makes the venv stale and re-provisions", () => {
    const { layout, root } = fakeLayout();
    const deps = fakeDeps(layout);
    runCasting(["audition", "--dry-run"], ctx(root).ctx, deps, undefined);
    writeFileSync(join(layout.source, "uv.lock"), "version = 2\n", "utf8");
    expect(castingState(layout)).toBe("stale");
    runCasting(["audition", "--dry-run"], ctx(root).ctx, deps, undefined);
    expect(deps.calls.filter((call) => call[1] === "sync")).toHaveLength(2);
  });

  test("an npm install syncs without the dev group", () => {
    const { layout, root } = fakeLayout();
    const npm: CastingLayout = { ...layout, venv: join(root, "data", "venv"), install: "npm" };
    const deps = fakeDeps(npm);
    expect(runCasting(["audition", "--dry-run"], ctx(root).ctx, deps, undefined).exitCode).toBe(0);
    expect(deps.calls[0]).toEqual(["/fake/bin/uv", "sync", "--frozen", "--no-dev"]);
  });

  test("a missing uv is a refusal naming `brew install uv`, and nothing runs", () => {
    const { layout, root } = fakeLayout();
    const deps = fakeDeps(layout, { uv: false });
    const result = runCasting(["audition", "--dry-run"], ctx(root).ctx, deps, undefined);
    expect(result.exitCode).toBe(2);
    const body = result.body as { ok: boolean; code: number; message: string; missing: string[] };
    expect(body).toMatchObject({ ok: false, code: 2, missing: ["uv"] });
    expect(body.message).toContain("brew install uv");
    expect(deps.calls).toEqual([]);
  });

  test("a failed uv sync is an error and leaves no stamp", () => {
    const { layout, root } = fakeLayout();
    const result = runCasting(["audition", "--dry-run"], ctx(root).ctx, fakeDeps(layout, { sync: 1 }), undefined);
    expect(result.exitCode).toBe(1);
    expect(castingState(layout)).toBe("not provisioned");
  });

  test("a refused pull (an unusable config) passes the refusal through and leaves no stamp", () => {
    const { layout, root } = fakeLayout();
    const refusal = { ok: false, code: 2, message: "casting.json is not valid JSON" };
    const deps = fakeDeps(layout, { answers: { pull: { code: 2, stdout: JSON.stringify(refusal), stderr: "" } } });
    const result = runCasting(["audition", "--dry-run"], ctx(root).ctx, deps, undefined);
    expect(result).toEqual({ body: refusal, exitCode: 2 });
    expect(castingState(layout)).toBe("not provisioned");
  });

  test("a casting command runs after provisioning, with the work for its receipts (AGT-1679)", () => {
    const { layout, root } = fakeLayout();
    const work = join(root, "work");
    mkdirSync(work);
    const deps = fakeDeps(layout);
    const result = runCasting(["voices", "list"], ctx(root).ctx, deps, work);
    expect(result.exitCode).toBe(1); // the fake answers "unknown" for voices; the point is the argv
    expect(deps.calls.at(-1)).toEqual([venvPython(layout), "-m", "pablo_casting", "voices", "list", "--work", work, "--json"]);
  });

  test("no casting sources is an error", () => {
    const root = temp("pablo-casting-");
    expect(runCasting(["audition", "--dry-run"], ctx(root).ctx, fakeDeps(undefined), undefined).exitCode).toBe(1);
  });
});

describe("gate (AGT-1682)", () => {
  const passing = { ok: true, pass: true, failing: [], flags: [], card: "cora", scores: { wer: 0, sim_card: 0.74, heard: "x" } };
  const answer = (body: unknown, code = 0): CastingRun => ({ code, stdout: JSON.stringify(body), stderr: "" });

  test("scoring a take provisions with the scorers extra and passes absolute paths to the Python side", () => {
    const { layout, root } = fakeLayout();
    const work = join(root, "work");
    mkdirSync(work);
    const deps = fakeDeps(layout, { answers: { gate: answer(passing) } });
    const result = runGate(
      ["takes/t1.wav", "--line", "Not just for the breweries.", "--card", "cora", "--centroid", "c.json", "--emotion", "sad", "--json"],
      ctx(root).ctx,
      deps,
      root,
      work,
    );
    expect(result).toEqual({ body: passing, exitCode: 0 });
    expect(deps.calls[0]).toEqual(["/fake/bin/uv", "sync", "--frozen", "--extra", "scorers"]);
    expect(deps.calls.at(-1)).toEqual([
      venvPython(layout), "-m", "pablo_casting", "gate", join(root, "takes/t1.wav"),
      "--line", "Not just for the breweries.", "--centroid", join(root, "c.json"), "--emotion", "sad",
      "--work", work, "--card", "cora", "--json",
    ]);
    expect(castingState(layout, ["scorers"])).toBe("provisioned");
  });

  test("--library and --vault are passed (absolute) so a slug resolves where cast wrote it (AGT-1709)", () => {
    const { layout, root } = fakeLayout();
    const deps = fakeDeps(layout, { answers: { gate: answer(passing) } });
    runGate(["--scores", "r.json", "--card", "cora", "--library", "lib", "--vault", "/v"], ctx(root).ctx, deps, root, undefined);
    expect(deps.calls.at(-1)).toEqual([
      venvPython(layout), "-m", "pablo_casting", "gate", "--scores", join(root, "r.json"),
      "--library", join(root, "lib"), "--vault", "/v", "--card", "cora", "--json",
    ]);
  });

  test("a venv provisioned without the extra is topped up once, keeping what it had", () => {
    const { layout, root } = fakeLayout();
    const deps = fakeDeps(layout, { answers: { gate: answer(passing) } });
    runCasting(["audition", "--dry-run"], ctx(root).ctx, deps, undefined);
    expect(castingState(layout)).toBe("provisioned");
    expect(castingState(layout, ["scorers"])).toBe("stale");
    runGate(["t.wav", "--line", "x", "--card", "cora"], ctx(root).ctx, deps, root, undefined);
    runGate(["t.wav", "--line", "x", "--card", "cora"], ctx(root).ctx, deps, root, undefined);
    const syncs = deps.calls.filter((call) => call[1] === "sync");
    expect(syncs).toEqual([["/fake/bin/uv", "sync", "--frozen"], ["/fake/bin/uv", "sync", "--frozen", "--extra", "scorers"]]);
    // A later audition does not drop the extra.
    runCasting(["audition", "--dry-run"], ctx(root).ctx, deps, undefined);
    expect(deps.calls.filter((call) => call[1] === "sync")).toHaveLength(2);
  });

  test("a changed lock re-provisions with the extras the venv had", () => {
    const { layout, root } = fakeLayout();
    const deps = fakeDeps(layout, { answers: { gate: answer(passing) } });
    runGate(["t.wav", "--line", "x", "--card", "cora"], ctx(root).ctx, deps, root, undefined);
    writeFileSync(join(layout.source, "uv.lock"), "version = 3\n", "utf8");
    runCasting(["audition", "--dry-run"], ctx(root).ctx, deps, undefined);
    expect(deps.calls.filter((call) => call[1] === "sync").at(-1)).toEqual(["/fake/bin/uv", "sync", "--frozen", "--extra", "scorers"]);
    expect(castingState(layout, ["scorers"])).toBe("provisioned");
  });

  test("calibrate and --scores need no extra and never pass --work", () => {
    const { layout, root } = fakeLayout();
    const deps = fakeDeps(layout, { answers: { gate: answer({ ok: true, proposed: { gates: { sim_min: 0.66 } }, approved: 30, others: 30, warnings: [] }) } });
    const result = runGate(["calibrate", "--approved", "ok", "--others", "/abs/others", "--card", "./voices/cora", "--apply"], ctx(root).ctx, deps, root, join(root, "w"));
    expect(result.exitCode).toBe(0);
    expect(deps.calls[0]).toEqual(["/fake/bin/uv", "sync", "--frozen"]);
    expect(deps.calls.at(-1)?.slice(3)).toEqual(["gate", "calibrate", "--approved", join(root, "ok"), "--others", "/abs/others", "--apply", "--card", join(root, "voices/cora"), "--json"]);

    runGate(["--scores", "rec.json", "--card", "cora"], ctx(root).ctx, deps, root, undefined);
    expect(deps.calls.at(-1)?.slice(3)).toEqual(["gate", "--scores", join(root, "rec.json"), "--card", "cora", "--json"]);
    expect(deps.calls.filter((call) => call[1] === "sync")).toHaveLength(1);
  });

  test("usage mistakes are errors (exit 1) and provision nothing", () => {
    const { layout, root } = fakeLayout();
    const deps = fakeDeps(layout);
    for (const argv of [[], ["t.wav", "--card", "cora"], ["a.wav", "b.wav", "--line", "x"], ["t.wav", "--scores", "r.json"], ["t.wav", "--bogus"], ["calibrate"], ["calibrate", "x", "--approved", "d"]]) {
      const result = runGate(argv, ctx(root).ctx, deps, root, undefined);
      expect(result.exitCode).toBe(1);
      expect((result.body as { ok: boolean }).ok).toBe(false);
    }
    expect(deps.calls).toEqual([]);
  });

  test("a Python refusal passes through with its code", () => {
    const { layout, root } = fakeLayout();
    const refusal = { ok: false, code: 2, message: 'no card "nobody"' };
    const deps = fakeDeps(layout, { answers: { gate: answer(refusal, 2) } });
    expect(runGate(["t.wav", "--line", "x", "--card", "nobody"], ctx(root).ctx, deps, root, undefined)).toEqual({ body: refusal, exitCode: 2 });
  });

  test("a missing uv refuses before anything runs", () => {
    const { layout, root } = fakeLayout();
    const deps = fakeDeps(layout, { uv: false });
    expect(runGate(["t.wav", "--line", "x", "--card", "cora"], ctx(root).ctx, deps, root, undefined).exitCode).toBe(2);
    expect(deps.calls).toEqual([]);
  });

  test("plain text names the failing gates and the proposed block", () => {
    expect(gateText({ ...passing, pass: false, failing: ["identity", "pace"], flags: ["emotion"] })).toStartWith("fail: identity, pace (card cora)\nflags: emotion\n  wer: 0");
    expect(gateText(passing)).not.toContain("heard");
    expect(gateText({ ok: true, proposed: { gates: { sim_min: 0.66 } }, approved: 30, others: 2, warnings: ["sim_min: few"], message: "nothing written" })).toContain('"sim_min": 0.66');
  });

  test("doctor lists each scorer's weights, license and version", () => {
    const text = doctorText({
      version: "9.9.9",
      casting: {
        state: "provisioned",
        venv: "/v",
        uv: { found: true, path: "/uv" },
        config: "/c",
        python: {
          ok: true,
          python: "3.12.13",
          version: "0.1.0",
          scorers: [
            { name: "ecapa", weights: "speechbrain/spkrec-ecapa-voxceleb", license: { code: "Apache-2.0", weights: "Apache-2.0" }, package: "speechbrain", version: "1.1.1", installed: true, runs: "CPU (PyTorch)", extra: "scorers", cached: true },
            { name: "utmos", weights: "tarepan/SpeechMOS utmos22_strong", revision: "v1.2.0", license: { code: "MIT", weights: "MIT" }, package: "torch", version: null, installed: false, runs: "CPU (PyTorch)", extra: "scorers", cached: null },
          ],
        },
      },
    });
    expect(text).toContain("gate scorers:");
    expect(text).toContain("ecapa     speechbrain/spkrec-ecapa-voxceleb");
    expect(text).toContain("license Apache-2.0 / weights Apache-2.0; speechbrain 1.1.1; CPU (PyTorch), cached");
    expect(text).toContain("tarepan/SpeechMOS utmos22_strong @ v1.2.0");
    expect(text).toContain("not installed (extra: scorers)");
  });
});

describe("layout", () => {
  test("finds packages/casting in a repo checkout", () => {
    const layout = castingLayout({}, new URL("../src/casting.ts", import.meta.url).href);
    expect(layout?.install).toBe("checkout");
    expect(layout?.source).toBe(fileURLToPath(new URL("../../casting", import.meta.url)));
    expect(layout?.venv).toBe(join(layout?.source ?? "", ".venv"));
  });

  test("in an npm install, finds the bundled copy and keeps the venv under $XDG_DATA_HOME/pablo/casting", () => {
    const root = temp("pablo-npm-");
    const pkg = join(root, "node_modules", "@openthink", "pablo");
    mkdirSync(join(pkg, "src"), { recursive: true });
    fakeSource(join(pkg, "casting"));
    const layout = castingLayout({ XDG_DATA_HOME: join(root, "data") }, pathToFileURL(join(pkg, "src", "casting.ts")).href);
    expect(layout).toEqual({ source: join(pkg, "casting"), venv: join(root, "data", "pablo", "casting", "venv"), install: "npm" });
  });
});

describe("packaging", () => {
  test("the npm files list ships the casting sources", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { files: string[]; scripts: Record<string, string> };
    expect(manifest.files).toContain("casting");
    expect(manifest.files).toContain("!casting/.venv");
    expect(manifest.scripts["prepack"]).toContain("casting-bundle.ts");
  });

  test("the bundle copies sources only: no venv, caches or tests", () => {
    const root = temp("pablo-bundle-");
    const from = join(root, "casting");
    fakeSource(from);
    writeFileSync(join(from, "src", "pablo_casting", "__init__.py"), "", "utf8");
    mkdirSync(join(from, "src", "pablo_casting", "__pycache__"), { recursive: true });
    writeFileSync(join(from, "src", "pablo_casting", "__pycache__", "x.pyc"), "", "utf8");
    mkdirSync(join(from, ".venv", "bin"), { recursive: true });
    mkdirSync(join(from, "tests"), { recursive: true });

    const to = join(root, "out");
    bundleCasting(from, to);
    expect(readdirSync(to).sort()).toEqual([...BUNDLED].sort());
    expect(readdirSync(join(to, "src", "pablo_casting"))).toEqual(["__init__.py"]);
  });
});

// AGT-1680: `radio.ts` is the one other door. `check`, `status --for "episode N"` and `bind` reach the Python
// side through it, and only for a work whose scripts carry a `CAST:` line; verbs.ts and check.ts import the
// runner's types and defaults from radio.ts, never from casting.ts, so a writing verb on a writing work
// still never touches packages/casting.
// AGT-1679: `casting-verbs.ts` holds the `audition`/`cast`/`voices` VERBS entries; the runner only runs
// inside their `run`, never at import, so `verbs.ts` importing them provisions nothing.
// AGT-1766: `mixer-host.ts` (the mixer window's host) runs it only inside a mutation the window calls.
test("only cli.ts, radio.ts and the casting verbs reach the casting runner: a writing verb never touches packages/casting", () => {
  const src = fileURLToPath(new URL("../src", import.meta.url));
  const importers: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && /from "\.{1,2}\/(?:\.\.\/)*casting"/.test(readFileSync(path, "utf8"))) importers.push(path.slice(src.length + 1));
    }
  };
  walk(src);
  expect(importers.sort()).toEqual(["casting-verbs.ts", "cli.ts", "mixer-cast-host.ts", "mixer-host.ts", "mixer-punch-host.ts", "radio.ts"]);
});
