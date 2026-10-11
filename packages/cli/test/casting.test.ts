import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { castingLayout, castingState, ensureProvisioned, runAudition, runDoctor, UV_INSTALL, venvPython } from "../src/casting";
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

describe("audition --dry-run provisioning (AC2)", () => {
  test("the first call provisions and receipts under the work; the second skips", () => {
    const { layout, root } = fakeLayout();
    const work = join(root, "work");
    mkdirSync(work);
    const deps = fakeDeps(layout);
    const { ctx: c, err } = ctx(root);

    const first = runAudition({ dryRun: true }, c, deps, work);
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
    const second = runAudition({ dryRun: true }, c, deps, work);
    expect(second.exitCode).toBe(0);
    expect((second.body as { provisioned: boolean }).provisioned).toBe(false);
    expect(syncs()).toBe(1);
    expect(readFileSync(join(work, ".pablo", "casting", "receipts.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("with no work, the receipt goes to the state directory", () => {
    const { layout, root } = fakeLayout();
    const result = runAudition({ dryRun: true }, ctx(root).ctx, fakeDeps(layout), undefined);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, "state", "pablo", "casting", "receipts.jsonl"))).toBe(true);
  });

  test("a changed uv.lock makes the venv stale and re-provisions", () => {
    const { layout, root } = fakeLayout();
    const deps = fakeDeps(layout);
    runAudition({ dryRun: true }, ctx(root).ctx, deps, undefined);
    writeFileSync(join(layout.source, "uv.lock"), "version = 2\n", "utf8");
    expect(castingState(layout)).toBe("stale");
    runAudition({ dryRun: true }, ctx(root).ctx, deps, undefined);
    expect(deps.calls.filter((call) => call[1] === "sync")).toHaveLength(2);
  });

  test("an npm install syncs without the dev group", () => {
    const { layout, root } = fakeLayout();
    const npm: CastingLayout = { ...layout, venv: join(root, "data", "venv"), install: "npm" };
    const deps = fakeDeps(npm);
    expect(runAudition({ dryRun: true }, ctx(root).ctx, deps, undefined).exitCode).toBe(0);
    expect(deps.calls[0]).toEqual(["/fake/bin/uv", "sync", "--frozen", "--no-dev"]);
  });

  test("a missing uv is a refusal naming `brew install uv`, and nothing runs", () => {
    const { layout, root } = fakeLayout();
    const deps = fakeDeps(layout, { uv: false });
    const result = runAudition({ dryRun: true }, ctx(root).ctx, deps, undefined);
    expect(result.exitCode).toBe(2);
    const body = result.body as { ok: boolean; code: number; message: string; missing: string[] };
    expect(body).toMatchObject({ ok: false, code: 2, missing: ["uv"] });
    expect(body.message).toContain("brew install uv");
    expect(deps.calls).toEqual([]);
  });

  test("a failed uv sync is an error and leaves no stamp", () => {
    const { layout, root } = fakeLayout();
    const result = runAudition({ dryRun: true }, ctx(root).ctx, fakeDeps(layout, { sync: 1 }), undefined);
    expect(result.exitCode).toBe(1);
    expect(castingState(layout)).toBe("not provisioned");
  });

  test("a refused pull (an unusable config) passes the refusal through and leaves no stamp", () => {
    const { layout, root } = fakeLayout();
    const refusal = { ok: false, code: 2, message: "casting.json is not valid JSON" };
    const deps = fakeDeps(layout, { answers: { pull: { code: 2, stdout: JSON.stringify(refusal), stderr: "" } } });
    const result = runAudition({ dryRun: true }, ctx(root).ctx, deps, undefined);
    expect(result).toEqual({ body: refusal, exitCode: 2 });
    expect(castingState(layout)).toBe("not provisioned");
  });

  test("plain audition is not implemented yet and provisions nothing", () => {
    const { layout, root } = fakeLayout();
    const deps = fakeDeps(layout);
    expect(runAudition({ dryRun: false }, ctx(root).ctx, deps, undefined).exitCode).toBe(1);
    expect(deps.calls).toEqual([]);
  });

  test("no casting sources is an error", () => {
    const root = temp("pablo-casting-");
    expect(runAudition({ dryRun: true }, ctx(root).ctx, fakeDeps(undefined), undefined).exitCode).toBe(1);
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

test("only cli.ts reaches the casting runner: a writing verb never touches packages/casting", () => {
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
  expect(importers).toEqual(["cli.ts"]);
});
