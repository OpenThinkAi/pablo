/**
 * Keep the compiled tray helper (packages/cli/tray/PabloTray.swift, AGT-1256)
 * running as a child of the `pablo tray` daemon (AGT-1267), and never let a
 * helper that cannot start become a reason the daemon stops.
 *
 * Modeled on `~/Development/insieme/src/tray.ts`'s `superviseTray`, reshaped
 * from a `{stop, done, spawns}` handle into a single awaitable driven by an
 * `AbortSignal` — the shape this ticket's daemon wiring (AGT-1267) needs.
 */

/** A running helper, reduced to what supervision needs. */
export interface SupervisedProcess {
  exited: Promise<number>;
  kill: () => void;
}

export interface SuperviseHelperOptions {
  /** Starts one helper. Every throw is absorbed and logged, never rethrown. */
  spawn: () => SupervisedProcess;
  log: (line: string) => void;
  /** Injected so backoff is testable without a real wait. */
  sleep: (ms: number) => Promise<void>;
  /** Aborting kills the current child (if any) and returns promptly. */
  signal: AbortSignal;
  /** Injected clock, so a 30s-or-longer run is testable without waiting 30s. */
  now?: () => number;
}

/** A run at least this long counts as healthy, resetting the backoff. */
const HEALTHY_AFTER_MS = 30_000;
/** The backoff never waits longer than this between respawns. */
const MAX_BACKOFF_MS = 60_000;
/** The first backoff after a run that was not healthy. */
const FIRST_BACKOFF_MS = 1_000;

/**
 * `min(1000 * 2^n, 60000)`, where `n` is how many consecutive short-lived
 * exits have happened so far (0 for the first one).
 */
export function restartDelayMs(n: number): number {
  const exponent = Math.max(n, 0);
  return Math.min(FIRST_BACKOFF_MS * 2 ** exponent, MAX_BACKOFF_MS);
}

/** Resolves once, when `signal` aborts (or immediately if it already has). */
function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The supervision loop: spawn, wait for exit, back off, respawn — forever,
 * until `signal` aborts.
 *
 * Every throw `spawn()` raises, and every rejection the child's `exited`
 * promise carries, is absorbed as a logged line rather than propagated: a
 * menu-bar helper that cannot start (a corrupt bundle, a signature macOS
 * refuses, a framework missing after an OS upgrade) must never be a reason
 * the daemon this runs inside dies.
 */
export async function superviseHelper(opts: SuperviseHelperOptions): Promise<void> {
  const now = opts.now ?? (() => Date.now());
  let failures = 0;

  while (!opts.signal.aborted) {
    const startedAt = now();
    let exitCode: number | null = null;
    let child: SupervisedProcess | null = null;

    try {
      child = opts.spawn();
    } catch (error) {
      opts.log(`the tray helper could not be started: ${describeError(error)}`);
    }

    if (child) {
      const proc = child;
      const onAbort = (): void => {
        try {
          proc.kill();
        } catch {
          // Already gone — nothing to undo.
        }
      };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });

      try {
        // Raced against abort so a child that does not exit promptly after
        // being killed (or a fake in a test that never resolves `exited`)
        // cannot stop this function from returning once told to stop.
        const outcome = await Promise.race([
          proc.exited.then((code) => ({ aborted: false as const, code })),
          whenAborted(opts.signal).then(() => ({ aborted: true as const, code: null })),
        ]);
        exitCode = outcome.code;
      } catch (error) {
        opts.log(`the tray helper exited with an error: ${describeError(error)}`);
      } finally {
        opts.signal.removeEventListener("abort", onAbort);
      }
    }

    if (opts.signal.aborted) return;

    const ranMs = now() - startedAt;
    failures = ranMs >= HEALTHY_AFTER_MS ? 0 : failures + 1;
    const delay = restartDelayMs(failures - 1);

    opts.log(
      `the tray helper exited (${exitCode ?? "did not start"}) — restarting in ${Math.round(delay / 1000)}s.`,
    );

    await Promise.race([opts.sleep(delay), whenAborted(opts.signal)]);
  }
}

/**
 * The production spawn: the real helper binary, the real state file, no
 * stdio. Both streams are discarded rather than inherited — the daemon's own
 * log is not the place for AppKit chatter nobody reads, and the helper never
 * writes prose or a credential to either stream in the first place.
 */
export function spawnTrayHelper(helperPath: string, statePath: string): SupervisedProcess {
  const child = Bun.spawn([helperPath, statePath], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return {
    exited: child.exited,
    kill: () => child.kill(),
  };
}
