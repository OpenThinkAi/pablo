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
 * `audition`, `cast` and `voices` (AGT-1679) are `VERBS` entries
 * (`casting-verbs.ts`), so the CLI, `pablo mcp` and the harness reach them
 * through one entry each; each calls `runCasting` below. `doctor` stays
 * CLI-only: it reports the machine, not a work.
 *
 * `pablo gate` (AGT-1682) is the first verb that needs an optional extra:
 * scoring audio provisions with `--extra scorers` (torch, speechbrain, the
 * MLX scorers), which the stamp records, so a venv provisioned for
 * `audition --dry-run` alone is topped up once and never downgraded.
 * `gate calibrate` and `gate --scores` read score records only and need no
 * extra. `gate` stays CLI-only: its first run downloads the scorers' weights.
 *
 * `perform` (AGT-1683, a `casting-verbs.ts` entry) renders through a real
 * engine and judges every take with the gates, so it provisions with the
 * `scorers` extra too (mlx-audio is in it), and relays its progress events
 * live through `runPythonStreaming` when asked for JSON lines.
 *
 * A real `audition` and `cast` render and score audio too, so they provision
 * with the same extra (AGT-1709); `--library`/`--vault` aim every casting verb,
 * `gate` included, at the same library, and a card slug resolves through
 * `library.py` on the Python side.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
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
  /**
   * Runs `argv` like `run`, but hands each stdout line to `onLine` as it is
   * written (AGT-1683: `perform --json-lines` relays its progress events live).
   * Optional: without it, `runPythonStreaming` replays the lines after `run`.
   */
  stream?(argv: readonly string[], options: { readonly cwd: string; readonly env: Env }, onLine: (line: string) => void): Promise<CastingRun>;
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
    stream: async (argv, { cwd, env: e }, onLine) => {
      try {
        const child = Bun.spawn([...argv], { cwd, env: e, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
        const decoder = new TextDecoder();
        let all = "";
        let pending = "";
        for await (const chunk of child.stdout) {
          const text = decoder.decode(chunk, { stream: true });
          all += text;
          pending += text;
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) onLine(line);
        }
        const tail = decoder.decode();
        all += tail;
        pending += tail;
        if (pending !== "") onLine(pending);
        return { code: await child.exited, stdout: all, stderr: "" };
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
  /** The optional extras (`pyproject.toml` `[project.optional-dependencies]`) this venv was synced with. */
  readonly extras?: readonly string[];
}

const STAMP = ".pablo-provisioned.json";

export function venvPython(layout: CastingLayout): string {
  return join(layout.venv, "bin", "python");
}

function lockHash(layout: CastingLayout): string {
  return createHash("sha256").update(readFileSync(join(layout.source, "uv.lock"))).digest("hex");
}

export type CastingState = "not provisioned" | "stale" | "provisioned";

function readStamp(layout: CastingLayout): Partial<ProvisionStamp> | undefined {
  const stampPath = join(layout.venv, STAMP);
  if (!existsSync(stampPath) || !existsSync(venvPython(layout))) return undefined;
  try {
    return JSON.parse(readFileSync(stampPath, "utf8")) as Partial<ProvisionStamp>;
  } catch {
    return undefined;
  }
}

/** The extras the venv was last synced with (kept across a lock change, so a re-provision does not drop them). */
function stampedExtras(layout: CastingLayout): readonly string[] {
  const stamp = readStamp(layout);
  if (stamp === undefined || !Array.isArray(stamp.extras)) return [];
  // Only bare extra names reach `uv sync --extra`: a hand-edited stamp cannot smuggle in a flag.
  return stamp.extras.filter((extra): extra is string => typeof extra === "string" && /^[a-z][a-z0-9-]*$/.test(extra));
}

/**
 * Reads the venv's stamp against the current `uv.lock`. Never runs anything.
 * With `extras`, a lock-matching venv synced without one of them is `stale`.
 */
export function castingState(layout: CastingLayout, extras: readonly string[] = []): CastingState {
  const stamp = readStamp(layout);
  if (stamp === undefined) return "not provisioned";
  if (stamp.lock !== lockHash(layout)) return "stale";
  const have = new Set(Array.isArray(stamp.extras) ? stamp.extras : []);
  return extras.every((extra) => have.has(extra)) ? "provisioned" : "stale";
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
  extras: readonly string[] = [],
): { readonly ok: true; readonly layout: CastingLayout; readonly outcome: ProvisionOutcome } | { readonly ok: false; readonly result: VerbResult } {
  const layout = deps.layout;
  if (layout === undefined) return { ok: false, result: noSources() };
  if (castingState(layout, extras) === "provisioned") return { ok: true, layout, outcome: { provisioned: false } };
  // Keep what an earlier provision installed: `uv sync` removes the extras it is not asked for.
  const wanted = [...new Set([...stampedExtras(layout), ...extras])].sort();
  const extraArgs = wanted.flatMap((extra) => ["--extra", extra]);

  const uv = deps.which("uv", ctx.env);
  if (uv === undefined) {
    return {
      ok: false,
      result: refusal(`pablo: the casting side needs uv, which is not on PATH; install it with \`${UV_INSTALL}\` and run this again`, ["uv"]),
    };
  }

  const started = deps.now();
  const syncing = ["sync", "--frozen", ...(layout.install === "npm" ? ["--no-dev"] : []), ...extraArgs];
  ctx.stderr.write(`pablo: provisioning the casting side (uv ${syncing.join(" ")} into ${layout.venv})\n`);
  const env: Env = { ...ctx.env, UV_PROJECT_ENVIRONMENT: layout.venv };
  // An npm install has no use for the test dependencies; a checkout keeps them for `casting-test`.
  const sync = deps.run([uv, ...syncing], { cwd: layout.source, env });
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
  writeFileSync(join(layout.venv, STAMP), `${JSON.stringify({ lock, at: finished.toISOString(), extras: wanted } satisfies ProvisionStamp)}\n`, "utf8");
  const receipt = castingReceiptsPath(ctx.env, work);
  appendReceipt(receipt, {
    at: finished.toISOString(),
    intent: "provision",
    install: layout.install,
    venv: layout.venv,
    lock,
    extras: wanted,
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
 * `runPython`, relaying each stdout line to `onLine` as the child writes it
 * (through `deps.stream`), or replaying them once it has finished when the
 * machine cannot stream. The body is still the last line.
 */
export async function runPythonStreaming(
  layout: CastingLayout,
  deps: CastingDeps,
  ctx: CastingContext,
  args: readonly string[],
  onLine: (line: string) => void,
): Promise<VerbResult> {
  const argv = [venvPython(layout), "-m", "pablo_casting", ...args, "--json"];
  const options = { cwd: layout.source, env: ctx.env };
  let run: CastingRun;
  if (deps.stream !== undefined) {
    run = await deps.stream(argv, options, onLine);
  } else {
    run = deps.run(argv, options);
    for (const line of run.stdout.split("\n")) if (line !== "") onLine(line);
  }
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
  const python = casting["python"] as { ok?: boolean; python?: string; version?: string; message?: string; scorers?: readonly ScorerRow[] } | undefined;
  if (python !== undefined) lines.push(python.ok ? `  python: ${python.python} (pablo_casting ${python.version})` : `  python: ${python.message}`);
  if (python?.scorers !== undefined && python.scorers.length > 0) {
    lines.push("  gate scorers:");
    for (const s of python.scorers) {
      const version = s.installed ? `${s.package} ${s.version ?? "?"}` : `not installed (extra: ${s.extra})`;
      const cached = s.cached === true ? ", cached" : s.cached === false ? ", not cached" : "";
      lines.push(`    ${s.name.padEnd(9)} ${s.weights}${s.revision ? ` @ ${s.revision}` : ""}`);
      lines.push(`              license ${s.license.code} / weights ${s.license.weights}; ${version}; ${s.runs}${cached}`);
    }
  }
  return lines.join("\n");
}

/** One row of the Python doctor's `scorers` list (AGT-1682). */
interface ScorerRow {
  readonly name: string;
  readonly weights: string;
  readonly revision?: string;
  readonly license: { readonly code: string; readonly weights: string };
  readonly package: string;
  readonly version: string | null;
  readonly installed: boolean;
  readonly runs: string;
  readonly extra: string;
  readonly cached: boolean | null;
}

/**
 * Runs one casting command (`["audition", "--dry-run"]`, `["cast", "--role",
 * ...]`, `["voices", "list"]`): provisions the Python side when needed, then
 * runs `python -m pablo_casting <args> [--work <work>] --json` and returns its
 * body as pablo's own, with whether this call provisioned. Every casting verb
 * (`casting-verbs.ts`) comes through here. `extras` are the optional extras the
 * command needs (a real `audition` and `cast`, and `cast --auto --design`,
 * render and score audio, so they ask for `scorers`, AGT-1709/AGT-1699); the
 * stamp records them, so a venv is never
 * downgraded by a command that needs fewer.
 */
export function runCasting(
  args: readonly string[],
  ctx: CastingContext,
  deps: CastingDeps,
  work: string | undefined,
  extras: readonly string[] = [],
): VerbResult {
  const ready = ensureProvisioned(ctx, deps, work, extras);
  if (!ready.ok) return ready.result;
  const result = runPython(ready.layout, deps, ctx, [...args, ...(work === undefined ? [] : ["--work", work])]);
  return { body: { ...(result.body as object), provisioned: ready.outcome.provisioned, ...(ready.outcome.receipt ? { receipt: ready.outcome.receipt } : {}) }, exitCode: result.exitCode };
}

/** Asks the author a yes/no question on the terminal; the CLI passes one only when stdin and stdout are a TTY. */
export type Confirm = (question: string) => Promise<boolean>;

interface GcEntry {
  readonly key: string;
  readonly bytes?: number;
  readonly created?: string;
}

/**
 * `pablo takes show <key>` and `pablo takes gc` (AGT-1681): the take store of
 * the work's radio output (`outputs/radio/casting/takes/`). Both need a work.
 *
 * `gc` always lists first: the takes no manifest version references. With
 * `yes` (`--yes`) it archives exactly the listed keys; otherwise, with a
 * terminal (`confirm`), it asks; without one it refuses (exit 2) and names
 * `--yes`. Archiving moves a take into `archive/takes/<stamp>/`; nothing is
 * deleted.
 */
export async function runTakes(
  args: { readonly sub: string | undefined; readonly key: string | undefined; readonly yes: boolean },
  ctx: CastingContext,
  deps: CastingDeps,
  work: string | undefined,
  confirm?: Confirm,
): Promise<VerbResult> {
  if (args.sub !== "show" && args.sub !== "gc") {
    return failure(`pablo: takes needs a subcommand: \`takes show <key>\` or \`takes gc\`${args.sub ? ` (got "${args.sub}")` : ""}`);
  }
  if (work === undefined) return refusal(`pablo: takes ${args.sub} needs --project <slug>: takes live in the work's outputs/radio/casting/`, ["--project"]);
  if (args.sub === "show" && !args.key) return failure("pablo: usage: pablo takes show <key> --project <slug>");

  const ready = ensureProvisioned(ctx, deps, work);
  if (!ready.ok) return ready.result;
  if (args.sub === "show") return runPython(ready.layout, deps, ctx, ["takes", "show", args.key as string, "--work", work]);

  const listed = runPython(ready.layout, deps, ctx, ["takes", "gc", "--work", work]);
  if (listed.exitCode !== EXIT_OK) return listed;
  const keys = ((listed.body as { unreferenced?: readonly GcEntry[] }).unreferenced ?? []).map((entry) => entry.key);
  if (keys.length === 0) return listed;

  if (!args.yes) {
    if (confirm === undefined) {
      return {
        body: {
          ...(listed.body as object),
          ok: false,
          code: EXIT_REFUSED,
          message: `pablo: ${keys.length} take(s) no manifest references; pass --yes to archive them (moved to archive/takes/, never deleted)`,
          missing: ["--yes"],
        },
        exitCode: EXIT_REFUSED,
      };
    }
    ctx.stderr.write(`${takesGcText(listed.body)}\n`);
    if (!(await confirm(`Archive these ${keys.length} take(s) into archive/takes/? [y/N] `))) {
      return { body: { ...(listed.body as object), declined: true }, exitCode: EXIT_OK };
    }
  }
  // Exactly the keys the author saw: a take referenced since the listing is skipped, not moved.
  return runPython(ready.layout, deps, ctx, ["takes", "gc", "--work", work, "--yes", ...keys.flatMap((key) => ["--key", key])]);
}

/** Plain-text `pablo takes show`. */
export function takeShowText(body: unknown): string {
  const take = body as Record<string, unknown>;
  const inputs = (take["inputs"] ?? {}) as Record<string, unknown>;
  const engine = (inputs["engine"] ?? {}) as Record<string, unknown>;
  const lines = (inputs["lines"] ?? []) as readonly { speaker: string; text: string }[];
  const timings = (take["timings"] ?? {}) as Record<string, unknown>;
  const words = (timings["words"] ?? []) as readonly { word: string; start: number; end: number }[];
  const audio = (take["audio"] ?? {}) as Record<string, unknown>;
  return [
    `take ${String(take["key"])}`,
    `  status:    ${String(take["status"])} (attempt ${String(take["attempt"])}, seed ${String(take["seed"])})`,
    `  receipt:   ${String(take["receipt"])}`,
    `  created:   ${String(take["created"])}`,
    `  engine:    ${String(engine["id"])} (weights ${String(engine["weights_sha256"]).slice(0, 12)}, mlx-audio ${String(engine["mlx_audio"])}, mlx ${String(engine["mlx"])})`,
    `  voice:     ${String(inputs["voice"])}`,
    `  direction: ${JSON.stringify(inputs["direction"] ?? {})}`,
    `  params:    ${JSON.stringify(inputs["params"] ?? {})}`,
    "  lines:",
    ...lines.map((line) => `    ${line.speaker}: ${line.text}`),
    `  scores:    ${JSON.stringify(take["scores"] ?? {})}`,
    `  timings:   wall ${String(timings["wall"])} s, audio ${String(audio["duration"])} s, rtf ${String(timings["rtf"])}`,
    `  words:     ${words.map((w) => `${w.word}@${w.start}`).join(" ")}`,
    `  path:      ${String(take["path"])}`,
  ].join("\n");
}

/** Plain-text `pablo takes gc`. */
export function takesGcText(body: unknown): string {
  const gc = body as { unreferenced?: readonly GcEntry[]; archived?: readonly { key: string; to: string }[]; referenced?: number; declined?: boolean };
  const archived = gc.archived ?? [];
  if (archived.length > 0) return [`archived ${archived.length} take(s):`, ...archived.map((entry) => `  ${entry.key} -> ${entry.to}`)].join("\n");
  const unreferenced = gc.unreferenced ?? [];
  if (unreferenced.length === 0) return `no unreferenced takes (${gc.referenced ?? 0} referenced by manifests)`;
  const listing = [`${unreferenced.length} take(s) no manifest references:`, ...unreferenced.map((entry) => `  ${entry.key}  ${entry.bytes ?? "?"} bytes  ${entry.created ?? ""}`)];
  if (gc.declined) listing.push("nothing archived");
  return listing.join("\n");
}

/** The extra `pablo gate` needs to score audio (`packages/casting/pyproject.toml`). */
export const SCORERS_EXTRA = "scorers";

/** The extra `pablo mix` needs to generate SFX and BED cues (Stable Audio Open: diffusers, torch). AGT-1684. */
export const MIX_EXTRA = "mix";

/** Makes a path the author typed absolute against their cwd: the Python side runs in the casting sources. */
function absolute(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function parseGateArgs(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      line: { type: "string" },
      card: { type: "string" },
      centroid: { type: "string" },
      emotion: { type: "string" },
      scores: { type: "string" },
      approved: { type: "string" },
      others: { type: "string" },
      apply: { type: "boolean" },
      // Where a card slug is looked up: the same two options `cast` takes (AGT-1709).
      library: { type: "string" },
      vault: { type: "string" },
      // Resolved by cli.ts before `runGate` is called; accepted here so strict parsing allows them.
      project: { type: "string" },
      json: { type: "boolean" },
    },
  });
}

/**
 * `pablo gate` (AGT-1682), parsed strictly here and passed to
 * `python -m pablo_casting gate`:
 *
 *     pablo gate <take.wav> --line "<line>" --card <slug|dir> [--centroid <file>] [--emotion <class>]
 *     pablo gate --scores <record.json> --card <slug|dir> [--line "<line>"]
 *     pablo gate calibrate --approved <dir> [--others <dir>] [--card <slug|dir>] [--apply]
 *
 * `argv` is everything after the verb. Paths are made absolute against `cwd`;
 * a card given as a path (it holds a `/` or starts with `.`) is too, a bare
 * word is a library slug, looked up where `cast` writes it
 * (`<library>/voices/<slug>`; the library is `--library`, else `--vault`'s
 * `<vault>/casting`, else the config's: `library.py`'s one rule). Scoring audio provisions with the `scorers` extra;
 * calibrate and `--scores` need none. A failing take is exit 0 with
 * `pass: false`; `calibrate` writes nothing without `--apply`.
 */
export function runGate(argv: readonly string[], ctx: CastingContext, deps: CastingDeps, cwd: string, work: string | undefined): VerbResult {
  let parsed: ReturnType<typeof parseGateArgs>;
  try {
    parsed = parseGateArgs(argv);
  } catch (error) {
    return failure(`pablo: gate: ${(error as Error).message}`);
  }
  const { values, positionals } = parsed;
  const calibrating = positionals[0] === "calibrate";
  const args: string[] = ["gate"];
  if (calibrating) {
    if (positionals.length > 1) return failure(`pablo: gate calibrate takes no positional arguments, got: ${positionals.slice(1).join(" ")}`);
    if (values.approved === undefined) return failure("pablo: gate calibrate needs --approved <dir> (score records of approved takes)");
    args.push("calibrate", "--approved", absolute(cwd, values.approved));
    if (values.others !== undefined) args.push("--others", absolute(cwd, values.others));
    if (values.apply === true) args.push("--apply");
  } else {
    const take = positionals[0];
    if (positionals.length > 1) return failure(`pablo: gate takes one take, got ${positionals.length}: ${positionals.join(" ")}`);
    if (take === undefined && values.scores === undefined) return failure('pablo: gate needs a take (`pablo gate <take.wav> --line "..." --card <slug>`) or --scores <record.json>');
    if (take !== undefined && values.scores !== undefined) return failure("pablo: give gate either a take or --scores, not both");
    if (take !== undefined && values.line === undefined) return failure('pablo: gate <take.wav> needs --line "<the script line>"');
    if (take !== undefined) args.push(absolute(cwd, take));
    if (values.scores !== undefined) args.push("--scores", absolute(cwd, values.scores));
    if (values.line !== undefined) args.push("--line", values.line);
    if (values.centroid !== undefined) args.push("--centroid", absolute(cwd, values.centroid));
    if (values.emotion !== undefined) args.push("--emotion", values.emotion);
    if (work !== undefined) args.push("--work", work);
  }
  if (values.library !== undefined) args.push("--library", absolute(cwd, values.library));
  if (values.vault !== undefined) args.push("--vault", absolute(cwd, values.vault));
  if (values.card !== undefined) {
    const card = values.card;
    args.push("--card", card.includes("/") || card.startsWith(".") ? absolute(cwd, card) : card);
  }

  const scoresAudio = !calibrating && values.scores === undefined;
  const ready = ensureProvisioned(ctx, deps, work, scoresAudio ? [SCORERS_EXTRA] : []);
  if (!ready.ok) return ready.result;
  return runPython(ready.layout, deps, ctx, args);
}

/** Plain-text `pablo gate` / `pablo gate calibrate`. */
export function gateText(body: unknown): string {
  const b = body as Record<string, unknown>;
  if (b["ok"] !== true) return String(b["message"] ?? "pablo: gate failed");
  if ("proposed" in b) {
    const lines = [`proposed gates (${String(b["approved"])} approved, ${String(b["others"])} others):`, JSON.stringify(b["proposed"], null, 2)];
    for (const warning of (b["warnings"] as readonly string[] | undefined) ?? []) lines.push(`warning: ${warning}`);
    if (typeof b["message"] === "string") lines.push(b["message"]);
    return lines.join("\n");
  }
  const failing = (b["failing"] as readonly string[] | undefined) ?? [];
  const flags = (b["flags"] as readonly string[] | undefined) ?? [];
  const head = b["pass"] === true ? `pass (card ${String(b["card"])})` : `fail: ${failing.join(", ")} (card ${String(b["card"])})`;
  const scores = Object.entries((b["scores"] as Record<string, unknown> | undefined) ?? {})
    .filter(([key]) => key !== "heard")
    .map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`);
  return [head, ...(flags.length > 0 ? [`flags: ${flags.join(", ")}`] : []), ...scores].join("\n");
}
