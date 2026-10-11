/**
 * `casting.ts` (AGT-1678, pm project `pablo-casting`) — the runner that puts
 * pablo's Python side (`packages/casting`, `python -m pablo_casting`) behind
 * the one `pablo` CLI.
 *
 * The Python side is provisioned **lazily**: nothing here runs until a casting
 * verb does, so a writing-only author never needs `uv`, never gets a venv and
 * never downloads a model. The first casting verb on a machine:
 *
 *  1. runs `uv sync --frozen` in the casting sources, with the venv next to
 *     them (`packages/casting/.venv`, a repo checkout) or under
 *     `$XDG_DATA_HOME/pablo/casting/venv` (an npm install, whose package
 *     directory may not be writable);
 *  2. runs `python -m pablo_casting pull`, which downloads the weights
 *     `$XDG_CONFIG_HOME/pablo/casting.json` names into the HF cache with
 *     progress on stderr (none are configured by default);
 *  3. writes a stamp (`<venv>/.pablo-provisioned.json`, holding `uv.lock`'s
 *     sha256) and appends a `provision` receipt to
 *     `<work>/.pablo/casting/receipts.jsonl` (or, with no work,
 *     `$XDG_STATE_HOME/pablo/casting/receipts.jsonl`).
 *
 * A later call finds the stamp matching the lock and skips straight to the
 * command; a changed `uv.lock` re-provisions. A missing `uv` is a refusal
 * (exit 2) naming `brew install uv`. `pablo doctor` reports all of this and
 * never provisions or downloads.
 *
 * Everything that touches the machine goes through `CastingDeps`, so `bun
 * test` injects a fake and never needs `uv`, Python or a model. The verbs are
 * dispatched by `cli.ts` only; registering them in `verbs.ts` (MCP, the
 * harness) comes with the real `cast`/`audition` verbs, so an agent cannot
 * trigger a multi-gigabyte download through a tool before those land.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir } from "./paths";
import type { ProgressSink, VerbResult } from "./verbs";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_REFUSED = 2;

/** What a refusal for a missing `uv` tells the author to run. */
export const UV_INSTALL = "brew install uv";

/** The Python package's distribution name; how a candidate source directory is recognised. */
const DIST_NAME = 'name = "pablo-casting"';

type Env = Record<string, string | undefined>;

/** Where the casting sources and their venv are on this machine. */
export interface CastingLayout {
  /** The directory holding `pyproject.toml`, `uv.lock` and `src/pablo_casting/`. */
  readonly source: string;
  /** The venv `uv sync` creates (`UV_PROJECT_ENVIRONMENT`). */
  readonly venv: string;
  /** `checkout`: `packages/casting` beside `packages/cli`. `npm`: the copy `prepack` bundles into the package. */
  readonly install: "checkout" | "npm";
}

/** `$XDG_DATA_HOME/pablo`, else `~/.local/share/pablo`. */
export function dataDir(env: Env): string {
  const base = env["XDG_DATA_HOME"];
  return base ? join(base, "pablo") : join(homedir(), ".local", "share", "pablo");
}

/** `$XDG_CONFIG_HOME/pablo/casting.json`, else `~/.config/pablo/casting.json` (the Python side reads the same path). */
export function castingConfigPath(env: Env): string {
  const base = env["XDG_CONFIG_HOME"];
  return join(base ? base : join(homedir(), ".config"), "pablo", "casting.json");
}

function isCastingSource(dir: string): boolean {
  const pyproject = join(dir, "pyproject.toml");
  return existsSync(pyproject) && existsSync(join(dir, "uv.lock")) && readFileSync(pyproject, "utf8").includes(DIST_NAME);
}

/**
 * Finds the casting sources relative to this module: `../../casting` in a repo
 * checkout (`packages/cli/src` → `packages/casting`), else `../casting` in an
 * npm install (`casting/` inside the published package). `undefined` when
 * neither holds them.
 */
export function castingLayout(env: Env, here: string = import.meta.url): CastingLayout | undefined {
  const checkout = fileURLToPath(new URL("../../casting", here));
  if (isCastingSource(checkout)) return { source: checkout, venv: join(checkout, ".venv"), install: "checkout" };
  const bundled = fileURLToPath(new URL("../casting", here));
  if (isCastingSource(bundled)) return { source: bundled, venv: join(dataDir(env), "casting", "venv"), install: "npm" };
  return undefined;
}

/** One finished child process. */
export interface CastingRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The machine, as the runner sees it; `bun test` passes a fake. */
export interface CastingDeps {
  readonly layout: CastingLayout | undefined;
  /** The absolute path of `command` on `env`'s PATH, or `undefined`. */
  which(command: string, env: Env): string | undefined;
  /** Runs `argv` in `cwd`. stderr passes through to the author's terminal (progress); stdout is captured. */
  run(argv: readonly string[], options: { readonly cwd: string; readonly env: Env }): CastingRun;
  now(): Date;
}

/** The production deps: `Bun.which` and `Bun.spawnSync`, stderr inherited so uv's and the hub's progress shows. */
export function realCastingDeps(env: Env): CastingDeps {
  return {
    layout: castingLayout(env),
    which: (command, e) => Bun.which(command, { PATH: e["PATH"] ?? "" }) ?? undefined,
    run: (argv, { cwd, env: e }) => {
      try {
        const result = Bun.spawnSync([...argv], { cwd, env: e, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
        return { code: result.exitCode, stdout: result.stdout.toString("utf8"), stderr: "" };
      } catch (error) {
        return { code: 1, stdout: "", stderr: (error as Error).message };
      }
    },
    now: () => new Date(),
  };
}

/** The stamp `provision` leaves in the venv. */
interface ProvisionStamp {
  readonly lock: string;
  readonly at: string;
}

const STAMP = ".pablo-provisioned.json";

export function venvPython(layout: CastingLayout): string {
  return join(layout.venv, "bin", "python");
}

function lockHash(layout: CastingLayout): string {
  return createHash("sha256").update(readFileSync(join(layout.source, "uv.lock"))).digest("hex");
}

export type CastingState = "not provisioned" | "stale" | "provisioned";

/** Reads the venv's stamp against the current `uv.lock`. Never runs anything. */
export function castingState(layout: CastingLayout): CastingState {
  const stampPath = join(layout.venv, STAMP);
  if (!existsSync(stampPath) || !existsSync(venvPython(layout))) return "not provisioned";
  try {
    const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as Partial<ProvisionStamp>;
    return stamp.lock === lockHash(layout) ? "provisioned" : "stale";
  } catch {
    return "not provisioned";
  }
}

/** `<work>/.pablo/casting/receipts.jsonl`, or the state directory's when there is no work. */
export function castingReceiptsPath(env: Env, work: string | undefined): string {
  return work === undefined ? join(stateDir(env), "casting", "receipts.jsonl") : join(work, ".pablo", "casting", "receipts.jsonl");
}

function appendReceipt(path: string, receipt: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(receipt)}\n`, "utf8");
}

function refusal(message: string, missing: readonly string[] = []): VerbResult {
  return { body: { ok: false, code: EXIT_REFUSED, message, missing }, exitCode: EXIT_REFUSED };
}

function failure(message: string): VerbResult {
  return { body: { ok: false, code: EXIT_ERROR, message }, exitCode: EXIT_ERROR };
}

function noSources(): VerbResult {
  return failure("pablo: the casting sources (packages/casting) are missing from this install");
}

/** The exit code a Python body carries, or an error when the child said something that is not pablo's contract. */
function parseBody(run: CastingRun, what: string): VerbResult {
  try {
    const body = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "") as unknown;
    if (typeof body !== "object" || body === null) throw new Error("not an object");
    const exitCode = run.code === EXIT_OK || run.code === EXIT_REFUSED ? run.code : EXIT_ERROR;
    return { body, exitCode };
  } catch {
    return failure(`pablo: ${what} exited ${run.code} without a JSON body${run.stderr ? `: ${run.stderr.trim()}` : ""}`);
  }
}

export interface ProvisionOutcome {
  /** True when this call ran `uv sync`; false when the venv was already provisioned. */
  readonly provisioned: boolean;
  readonly receipt?: string;
}

export interface CastingContext {
  readonly env: Env;
  readonly stderr: ProgressSink;
}

/**
 * Makes sure the Python side is ready, provisioning it if not. Returns the
 * outcome, or a `VerbResult` refusal/error to hand straight back.
 */
export function ensureProvisioned(
  ctx: CastingContext,
  deps: CastingDeps,
  work: string | undefined,
): { readonly ok: true; readonly layout: CastingLayout; readonly outcome: ProvisionOutcome } | { readonly ok: false; readonly result: VerbResult } {
  const layout = deps.layout;
  if (layout === undefined) return { ok: false, result: noSources() };
  if (castingState(layout) === "provisioned") return { ok: true, layout, outcome: { provisioned: false } };

  const uv = deps.which("uv", ctx.env);
  if (uv === undefined) {
    return {
      ok: false,
      result: refusal(`pablo: the casting side needs uv, which is not on PATH; install it with \`${UV_INSTALL}\` and run this again`, ["uv"]),
    };
  }

  const started = deps.now();
  ctx.stderr.write(`pablo: provisioning the casting side (uv sync --frozen into ${layout.venv})\n`);
  const env: Env = { ...ctx.env, UV_PROJECT_ENVIRONMENT: layout.venv };
  // An npm install has no use for the test dependencies; a checkout keeps them for `casting-test`.
  const sync = deps.run([uv, "sync", "--frozen", ...(layout.install === "npm" ? ["--no-dev"] : [])], { cwd: layout.source, env });
  if (sync.code !== 0) {
    return { ok: false, result: failure(`pablo: uv sync --frozen failed (exit ${sync.code})${sync.stderr ? `: ${sync.stderr.trim()}` : ""}`) };
  }

  ctx.stderr.write("pablo: pulling the configured casting weights\n");
  const pullRun = deps.run([venvPython(layout), "-m", "pablo_casting", "pull", "--json", ...(work === undefined ? [] : ["--work", work])], {
    cwd: layout.source,
    env: ctx.env,
  });
  const pull = parseBody(pullRun, "pablo_casting pull");
  if (pull.exitCode !== EXIT_OK) return { ok: false, result: pull };

  const lock = lockHash(layout);
  const finished = deps.now();
  writeFileSync(join(layout.venv, STAMP), `${JSON.stringify({ lock, at: finished.toISOString() } satisfies ProvisionStamp)}\n`, "utf8");
  const receipt = castingReceiptsPath(ctx.env, work);
  appendReceipt(receipt, {
    at: finished.toISOString(),
    intent: "provision",
    install: layout.install,
    venv: layout.venv,
    lock,
    weights: (pull.body as { weights?: unknown }).weights ?? [],
    wall: (finished.getTime() - started.getTime()) / 1000,
  });
  ctx.stderr.write(`pablo: casting side provisioned (receipt in ${receipt})\n`);
  return { ok: true, layout, outcome: { provisioned: true, receipt } };
}

/** Runs `python -m pablo_casting <args> --json` in a provisioned venv and returns its body as pablo's own. */
export function runPython(layout: CastingLayout, deps: CastingDeps, ctx: CastingContext, args: readonly string[]): VerbResult {
  const run = deps.run([venvPython(layout), "-m", "pablo_casting", ...args, "--json"], { cwd: layout.source, env: ctx.env });
  return parseBody(run, `pablo_casting ${args[0] ?? ""}`.trim());
}

/**
 * `pablo doctor`: the casting side's state. Never provisions and never
 * downloads; asks the Python side for its own report only when it is
 * already provisioned.
 */
export function runDoctor(ctx: CastingContext, deps: CastingDeps, version: string): VerbResult {
  const uv = deps.which("uv", ctx.env);
  const uvBody = uv === undefined ? { found: false, install: UV_INSTALL } : { found: true, path: uv };
  const layout = deps.layout;
  if (layout === undefined) {
    return { body: { ok: true, version, casting: { state: "missing sources", uv: uvBody, config: castingConfigPath(ctx.env) } }, exitCode: EXIT_OK };
  }
  const state = castingState(layout);
  const casting: Record<string, unknown> = {
    state,
    install: layout.install,
    source: layout.source,
    venv: layout.venv,
    uv: uvBody,
    config: castingConfigPath(ctx.env),
  };
  if (state === "provisioned") casting["python"] = runPython(layout, deps, ctx, ["doctor"]).body;
  return { body: { ok: true, version, casting }, exitCode: EXIT_OK };
}

/** Plain-text `pablo doctor`. */
export function doctorText(body: unknown): string {
  const { version, casting } = body as { version: string; casting: Record<string, unknown> };
  const uv = casting["uv"] as { found: boolean; path?: string; install?: string };
  const lines = [`pablo ${version}`, `casting: ${String(casting["state"])}`];
  if (casting["venv"] !== undefined) lines.push(`  venv:   ${String(casting["venv"])}`);
  lines.push(`  uv:     ${uv.found ? uv.path : `not found (${uv.install})`}`);
  lines.push(`  config: ${String(casting["config"])}`);
  const python = casting["python"] as { ok?: boolean; python?: string; version?: string; message?: string } | undefined;
  if (python !== undefined) lines.push(python.ok ? `  python: ${python.python} (pablo_casting ${python.version})` : `  python: ${python.message}`);
  return lines.join("\n");
}

/**
 * `pablo audition --dry-run`: the first casting verb. It provisions the
 * Python side when needed and runs the no-model audition check. A real
 * audition (rendering candidates) lands with the cast-card ticket; until then
 * plain `audition` is "not implemented yet" and provisions nothing.
 */
export function runAudition(args: { readonly dryRun: boolean }, ctx: CastingContext, deps: CastingDeps, work: string | undefined): VerbResult {
  if (!args.dryRun) return failure('pablo: "audition" is not implemented yet; `pablo audition --dry-run` checks the casting side without a model');
  const ready = ensureProvisioned(ctx, deps, work);
  if (!ready.ok) return ready.result;
  const result = runPython(ready.layout, deps, ctx, ["audition", "--dry-run"]);
  return { body: { ...(result.body as object), provisioned: ready.outcome.provisioned, ...(ready.outcome.receipt ? { receipt: ready.outcome.receipt } : {}) }, exitCode: result.exitCode };
}
