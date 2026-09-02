/**
 * The work brief: `think brief` for the work you just opened.
 *
 * **The brief is an app event, not an instruction to a model.** The design doc's
 * ritual table says it plainly: opening a work runs `think brief --cortex
 * writing --context <slug>` and loads the result. Nothing asks the model to
 * remember to do this, because the model would not, and the local writer has no
 * session preamble to hang it on.
 *
 * Two halves, split so the interesting one needs no disk:
 *
 * - **Detection** (`findVaultRoot`, `workUnder`, `detectWork`) is pure. The
 *   only fact it needs from the filesystem is "is this directory a vault", and
 *   that arrives as an injected probe, so the layout rules are tested over
 *   synthetic paths rather than over Matt's real vault.
 * - **Running it** (`runBrief`) spawns `think` off the render loop with a
 *   timeout, and reports a failure as a one-line notice rather than an
 *   exception. `think` is resolved from `PATH` at call time and is never a
 *   hardcoded path: a missing `think` is a normal outcome, not a broken install
 *   (AC3).
 *
 * Nothing here writes anything, anywhere. The brief is read-only context that
 * lives in memory for the length of the session; it never reaches the
 * manuscript file (AC4).
 */

import { statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** A work in a writing vault: `<vaultRoot>/<kind>/<slug>`. */
export interface Work {
  /** The vault root — the nearest ancestor holding `style/`. */
  readonly vaultRoot: string;
  /** `novels`, `stories`, `essays`: the directory the works of a kind sit in. */
  readonly kind: string;
  /** The work's own directory name, which is what `think` knows it by. */
  readonly slug: string;
}

/** "Is this path a directory?" — injected so detection stays pure in tests. */
export type DirectoryProbe = (path: string) => boolean;

/** The real probe. A missing path, or a file, is simply not a directory. */
export function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Directories directly under a vault root that hold no works. `style/` is the
 * marker itself, and a dot directory is machine state (`.pablo/`, `.git/`).
 */
const NOT_A_KIND = new Set(["style", "node_modules"]);

/**
 * The vault root for `path`: the nearest ancestor that has a `style/` directory.
 *
 * Nearest rather than furthest, so a vault nested inside a checkout resolves to
 * the vault. The walk stops at the filesystem root, and a path with no such
 * ancestor is simply not in a vault — the common case for `pablo /tmp/x.md`.
 */
export function findVaultRoot(path: string, isDirectory: DirectoryProbe = directoryExists): string | undefined {
  let directory = dirname(resolve(path));
  for (;;) {
    if (isDirectory(join(directory, "style"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * The work `path` belongs to, given the vault it is in.
 *
 * A work is `<vault>/<kind>/<slug>/…`, so the file must be at least three
 * segments below the root: a file sitting directly in `<vault>/novels` names no
 * work, and neither does anything under `style/`.
 */
export function workUnder(vaultRoot: string, path: string): Work | undefined {
  const root = resolve(vaultRoot);
  const inside = relative(root, resolve(path));
  if (inside.length === 0 || inside.startsWith("..")) return undefined;

  const segments = inside.split(sep).filter((segment) => segment.length > 0);
  if (segments.length < 3) return undefined;

  const [kind, slug] = segments as [string, string, ...string[]];
  if (NOT_A_KIND.has(kind) || kind.startsWith(".") || slug.startsWith(".")) return undefined;
  return { vaultRoot: root, kind, slug };
}

/** The work an opened file belongs to, or `undefined` if it is not in a vault (AC1). */
export function detectWork(path: string, isDirectory: DirectoryProbe = directoryExists): Work | undefined {
  const vaultRoot = findVaultRoot(path, isDirectory);
  return vaultRoot === undefined ? undefined : workUnder(vaultRoot, path);
}

/** How long the brief gets before it is killed. Long enough for a cold daemon. */
export const BRIEF_TIMEOUT_MS = 20_000;

/** The command, as data, so a test can assert it without spawning anything. */
export function briefCommand(think: string, slug: string): string[] {
  return [think, "brief", "--cortex", "writing", "--context", slug];
}

export interface SpawnResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the timeout killed it; the exit code of a killed process lies. */
  readonly timedOut: boolean;
}

export interface SpawnOptions {
  readonly timeoutMs: number;
  /** Aborted when the view tears down, so no child outlives the session. */
  readonly signal?: AbortSignal | undefined;
}

export type Spawner = (command: readonly string[], options: SpawnOptions) => Promise<SpawnResult>;

/** What the session knows about the brief. */
export type BriefStatus = "none" | "loading" | "ready" | "unavailable";

export interface BriefOutcome {
  readonly status: "ready" | "unavailable";
  /** The brief itself, on `ready`. Cached for the session; never written to disk. */
  readonly text?: string | undefined;
  /** One line for the status bar, on `unavailable` (AC3). */
  readonly notice?: string | undefined;
}

export interface RunBriefOptions {
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  /** The `PATH` to resolve `think` on. Defaults to the process's own. */
  readonly path?: string | undefined;
  /** Overridden in tests; the default really spawns. */
  readonly spawn?: Spawner | undefined;
  /** Overridden in tests; the default is `Bun.which`. */
  readonly resolve?: ((path: string | undefined) => string | undefined) | undefined;
}

/** `think` on `PATH`, or `undefined`. Never a hardcoded path — Matt's is under nvm. */
export function resolveThink(path: string | undefined = process.env["PATH"]): string | undefined {
  return Bun.which("think", path === undefined ? undefined : { PATH: path }) ?? undefined;
}

async function spawnCommand(command: readonly string[], options: SpawnOptions): Promise<SpawnResult> {
  const child = Bun.spawn({
    cmd: [...command],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const kill = (): void => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone; a dead child is the outcome we wanted either way.
    }
  };
  const expire = (): void => {
    timedOut = true;
    kill();
  };

  const timer = setTimeout(expire, options.timeoutMs);
  timer.unref?.();
  options.signal?.addEventListener("abort", kill, { once: true });

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const exitCode = await child.exited;
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", kill);
  }
}

function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0);
  return line === undefined ? "" : line.trim().slice(0, 120);
}

/**
 * Run the brief for one work. Resolves — it never rejects, because a brief that
 * cannot be fetched is a notice in the status line and nothing more (AC3).
 *
 * Only stdout is the brief. `think` writes advisory notes to stderr, and those
 * belong in the failure notice, not in the model's context.
 */
export async function runBrief(slug: string, options: RunBriefOptions = {}): Promise<BriefOutcome> {
  const resolver = options.resolve ?? resolveThink;
  const think = resolver(options.path);
  if (think === undefined || think.length === 0) {
    return { status: "unavailable", notice: "think is not on PATH — no brief for this work" };
  }

  const spawn = options.spawn ?? spawnCommand;
  let result: SpawnResult;
  try {
    result = await spawn(briefCommand(think, slug), {
      timeoutMs: options.timeoutMs ?? BRIEF_TIMEOUT_MS,
      signal: options.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "unavailable", notice: `think brief could not run: ${message}` };
  }

  if (result.timedOut) {
    const seconds = Math.round((options.timeoutMs ?? BRIEF_TIMEOUT_MS) / 1000);
    return { status: "unavailable", notice: `think brief timed out after ${seconds}s` };
  }
  if (result.exitCode !== 0) {
    const detail = firstLine(result.stderr);
    return {
      status: "unavailable",
      notice: `think brief failed (exit ${result.exitCode})${detail.length > 0 ? `: ${detail}` : ""}`,
    };
  }

  const text = result.stdout.trim();
  if (text.length === 0) {
    return { status: "unavailable", notice: `think brief had nothing for ${slug}` };
  }
  return { status: "ready", text };
}
