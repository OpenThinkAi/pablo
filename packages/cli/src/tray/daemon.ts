/**
 * `pablo tray` — the reader's one long-lived process (AGT-1589): it polls GitHub
 * for rounds waiting for this reader (`poll.ts`), raises one notification per new
 * round (`notify.ts`), keeps `tray-state.json` in sync for the menu-bar helper
 * (`state.ts`), supervises that helper (`bundle.ts`, `supervise.ts`), and opens a
 * round when the helper asks (`request.ts`).
 *
 * Opening goes through ONE entry, `openRound`, which production wires to
 * `pablo read <ref>` (a child process): the tray knows nothing about the reader
 * view, so the view (AGT-1586) and the tray never collide.
 *
 * `runTrayDaemon(deps, signal)` is the whole loop with every side effect
 * injectable (GitHub runner, notifier, clock, sleep, opener, bundle build,
 * supervisor, signal target), so a test drives it in-process against a temp
 * `XDG_STATE_HOME` without a real helper, notification, window or network.
 */

import { join } from "node:path";
import { roundRefLabel } from "../read";
import type { ReaderRound, RoundRef } from "../read";
import type { Runner } from "../share";
import type { MaterializeTrayBundleOptions, MaterializeTrayBundleResult } from "./bundle";
import { defaultAppSupportDir } from "./launchd";
import { roundEvent } from "./notify";
import type { Notifier } from "./notify";
import { nextDelayMs, pollIntervalMs, RoundPoller } from "./poll";
import { listenForTrayRequests } from "./request";
import type { SignalTarget, TrayRequest } from "./request";
import { notifiedPath, readNotified, toTrayRounds, trayDir, trayParcelPath, trayStatePath, writeNotified, writeTrayState } from "./state";
import type { TrayState } from "./state";
import type { SupervisedProcess, SuperviseHelperOptions } from "./supervise";

/** Shown in the state file's `version`. */
export const TRAY_VERSION = "0.1.0";

/** The fixed sentence `lastError` carries; the real reason goes to the log only. */
export const TRAY_LAST_ERROR = "it did not work; the log says why";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolves once per `wake()`, so a request can cut a sleep short. */
function createWaker(): { wait: () => Promise<void>; wake: () => void } {
  let resolve: (() => void) | undefined;
  let promise = new Promise<void>((r) => {
    resolve = r;
  });
  return {
    wait: () => promise,
    wake: () => {
      resolve?.();
      promise = new Promise((r) => {
        resolve = r;
      });
    },
  };
}

/** A round's view, opened. `exited` settles when the view's process ends. */
export interface OpenedRound {
  readonly exited: Promise<unknown>;
}

export interface TrayDaemonDeps {
  readonly env: Record<string, string | undefined>;
  /** Called once per line; `runTrayDaemon` prefixes each with an ISO timestamp itself. */
  readonly log: (line: string) => void;
  readonly now: () => Date;
  /** Wait `ms`; may resolve early. The loop also races it against abort and requests. */
  readonly sleep: (ms: number) => Promise<void>;
  /** The injection seam for every `gh` call (a fake in tests; a timeout-bounded runner in production). */
  readonly run: Runner;
  readonly notifier: Notifier;
  /** The single entry that opens a round's view: `pablo read <ref>`. Never a real window in tests. */
  readonly openRound: (ref: RoundRef) => OpenedRound;
  readonly materialize: (opts: MaterializeTrayBundleOptions) => Promise<MaterializeTrayBundleResult>;
  readonly supervise: (opts: SuperviseHelperOptions) => Promise<void>;
  readonly spawnHelper: (helperPath: string, statePath: string) => SupervisedProcess;
  /** Absolute path of `PabloTray.swift`. */
  readonly helperSource: string;
  /** Injected in tests so no suite installs a real, process-wide SIGUSR1 handler. */
  readonly signalTarget?: SignalTarget;
}

/**
 * The loop. Resolves once `signal` aborts, after the supervisor has wound down
 * and a final `daemonPid: 0` state has been written. A failed or throwing poll
 * only lengthens the wait (`nextDelayMs`); nothing but `signal` ends it.
 */
export async function runTrayDaemon(deps: TrayDaemonDeps, signal: AbortSignal): Promise<void> {
  const log = (line: string): void => deps.log(`${deps.now().toISOString()} ${line}`);
  const env = deps.env;
  const dir = trayDir(env);
  const statePath = trayStatePath(dir);
  const parcelPath = trayParcelPath(dir);
  const notifiedFile = notifiedPath(dir);
  const intervalMs = pollIntervalMs(env);

  const poller = new RoundPoller({ run: deps.run, env, now: () => deps.now().getTime() });
  let rounds: readonly ReaderRound[] = [];
  let notified = readNotified(notifiedFile);
  let lastError: string | undefined;
  let failures = 0;
  /** Views this daemon has open, by ref: a second click on an open round does nothing. */
  const open = new Set<string>();

  function publish(daemonPidOverride?: number): void {
    const state: TrayState = { daemonPid: daemonPidOverride ?? process.pid, version: TRAY_VERSION, rounds: toTrayRounds(rounds) };
    if (lastError !== undefined) state.lastError = lastError;
    try {
      writeTrayState(statePath, state);
    } catch (error) {
      log(`could not write the tray state: ${describeError(error)}`);
    }
  }

  // Written before anything else runs, so the helper's first read is a real document.
  publish();

  let helperPath: string | undefined;
  try {
    const materialized = await deps.materialize({ source: deps.helperSource, appSupportDir: defaultAppSupportDir(env), version: TRAY_VERSION });
    if (materialized.reason !== undefined) log(`no menu-bar icon (the poller still runs): ${materialized.reason}`);
    else {
      helperPath = materialized.helperPath;
      if (materialized.built) log("helper written");
    }
  } catch (error) {
    log(`the tray helper could not be built: ${describeError(error)}`);
  }

  const pendingRequests: TrayRequest[] = [];
  const waker = createWaker();
  const stopListening = listenForTrayRequests({
    parcelPath,
    onRequest: (request) => {
      // Recorded only: servicing happens on the loop, never inside the handler.
      pendingRequests.push(request);
      waker.wake();
    },
    process: deps.signalTarget,
  });

  let supervisorDone: Promise<void> | undefined;
  if (env["PABLO_TRAY"] !== "0" && helperPath !== undefined) {
    const resolved = helperPath;
    supervisorDone = deps.supervise({
      spawn: () => deps.spawnHelper(resolved, statePath),
      log,
      sleep: deps.sleep,
      signal,
      now: () => deps.now().getTime(),
    });
  }

  /** One notification per round never announced; one that fails to raise is retried on the next poll. */
  async function announce(): Promise<void> {
    const present = new Set(rounds.map((r) => r.ref));
    for (const round of rounds) {
      if (round.status !== "waiting" || notified.has(round.ref)) continue;
      try {
        await deps.notifier.notify(roundEvent(round));
        notified.add(round.ref);
        log(`told the reader about ${round.ref}`);
      } catch (error) {
        log(`could not notify about ${round.ref}: ${describeError(error)}`);
      }
    }
    // Forget rounds that are gone (closed), so the file stays small; a round that flips to "sent" stays remembered.
    notified = new Set([...notified].filter((ref) => present.has(ref)));
    try {
      writeNotified(notifiedFile, notified);
    } catch (error) {
      log(`could not record the notified rounds: ${describeError(error)}`);
    }
  }

  async function pollOnce(): Promise<void> {
    const result = poller.tick();
    if (!result.ok) {
      failures += 1;
      log(`the poll failed (${failures} in a row): ${result.reason}`);
      lastError = TRAY_LAST_ERROR;
      return;
    }
    failures = 0;
    lastError = undefined;
    rounds = result.rounds;
    for (const notice of result.notices) log(notice);
    await announce();
  }

  function serviceRequest(request: TrayRequest): void {
    const label = roundRefLabel(request.ref);
    // Only a round this daemon listed: the parcel is a local file any process could write.
    if (!rounds.some((r) => r.ref === label)) {
      log(`ignored a request to open ${label}: not one of the listed rounds`);
      return;
    }
    if (open.has(label)) return;
    try {
      const opened = deps.openRound(request.ref);
      open.add(label);
      log(`opened ${label}`);
      const done = (): void => {
        open.delete(label);
      };
      void opened.exited.then(done, done);
    } catch (error) {
      log(`could not open ${label}: ${describeError(error)}`);
      lastError = TRAY_LAST_ERROR;
    }
  }

  try {
    while (!signal.aborted) {
      await pollOnce();
      publish();

      // Serve clicks, then wait; a click during the wait wakes the loop, which serves it without polling again.
      let remaining = nextDelayMs(failures, intervalMs);
      while (!signal.aborted && remaining > 0) {
        while (pendingRequests.length > 0) {
          serviceRequest(pendingRequests.shift() as TrayRequest);
          publish();
        }
        const startedAt = deps.now().getTime();
        await Promise.race([
          deps.sleep(remaining),
          waker.wait(),
          new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
        ]);
        // A wake (request) shortens the wait by what already elapsed; a late wake (the Mac slept) ends it.
        remaining -= Math.max(0, deps.now().getTime() - startedAt);
        if (pendingRequests.length === 0) break;
      }
    }
  } finally {
    stopListening();
    if (supervisorDone !== undefined) await supervisorDone;
    lastError = undefined;
    publish(0);
  }
}

/** Where `PabloTray.swift` lives relative to this file. */
export function defaultHelperSource(): string {
  return join(import.meta.dir, "..", "..", "tray", "PabloTray.swift");
}
