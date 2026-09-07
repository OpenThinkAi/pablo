/**
 * `pablo tray` — the one long-lived pablo process: it materialises the menu-
 * bar helper (`bundle.ts`, AGT-1265), supervises it (`supervise.ts`), keeps
 * `~/.config/pablo/tray-state.json` in sync with the review queue
 * (`state.ts`, AGT-1266), and services the helper's clicks
 * (`request.ts`, AGT-1266) by calling straight into `review.ts`'s `decide`
 * (AGT-1255) so the append-only log stays the single source of truth.
 *
 * `runTrayDaemon(deps, signal)` is the whole loop with every side effect
 * injectable — `materialize`, `supervise`, `decide` and `now` chief among
 * them — so a test can drive it in-process against a temp `XDG_STATE_HOME`/
 * `XDG_CONFIG_HOME` without ever compiling a real helper, spawning a real
 * process, or creating a real status item. `cli.ts`'s `tray` verb supplies
 * the real implementations and a real `AbortSignal` tied to SIGTERM/SIGINT.
 */

import { mkdirSync, watch } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import { configDir } from "@openthink/pablo-core";
import type { MaterializeTrayBundleOptions, MaterializeTrayBundleResult } from "./bundle";
import type { SupervisedProcess, SuperviseHelperOptions } from "./supervise";
import { listenForTrayRequests } from "./request";
import type { SignalTarget, TrayRequest } from "./request";
import { toTrayPieces, writeTrayState } from "./state";
import type { TrayState } from "./state";
import { pending, readEvents } from "../review";
import type { DecideInput, DecideResult } from "../review";
import { stateReviewPath } from "../paths";

/** Recorded in `build.json` and shown in the state file's `version`. */
const TRAY_VERSION = "0.1.0";

/** The fixed sentence `lastError` carries — the real reason goes to the log only. */
export const TRAY_LAST_ERROR = "it did not work; the log says why";

/** How often the queue file is polled as a fallback to `fs.watch`. */
const DEFAULT_POLL_MS = 10_000;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Joins `filename` onto `dir` and asserts the result cannot have escaped it —
 * a defensive resolve-and-confine check applied before a path is handed to a
 * spawned process as an argument, even though `filename` here is always one
 * of our own literals, never anything read from the request parcel or the
 * helper.
 */
function ownedPath(dir: string, filename: string): string {
  const base = resolvePath(dir);
  const abs = resolvePath(base, filename);
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`refusing an out-of-bounds path under ${base}: ${abs}`);
  }
  return abs;
}

/** Resolves once per `wake()`, so a request or a queue change can cut a sleep short. */
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

/** Resolves once `signal` aborts (or immediately if it already has). */
function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Every side effect `runTrayDaemon` needs, injectable so a test never touches a real Mac. */
export interface TrayDaemonDeps {
  readonly env: Record<string, string | undefined>;
  /** Called once per line; `runTrayDaemon` prefixes each with an ISO timestamp itself. */
  readonly log: (line: string) => void;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly materialize: (opts: MaterializeTrayBundleOptions) => Promise<MaterializeTrayBundleResult>;
  readonly supervise: (opts: SuperviseHelperOptions) => Promise<void>;
  readonly spawnHelper: (helperPath: string, statePath: string) => SupervisedProcess;
  readonly decide: (path: string, input: DecideInput) => DecideResult;
  /** Injected in tests so no suite installs a real, process-wide SIGUSR1 handler. */
  readonly signalTarget?: SignalTarget;
  /** Milliseconds between the queue-file poll fallback; defaults to 10s. */
  readonly pollMs?: number;
}

/**
 * `pablo tray`'s whole loop: materialise the bundle, supervise the helper
 * (unless `PABLO_TRAY=0`), publish `tray-state.json` on start / queue change /
 * serviced request, and service SIGUSR1 requests between polls — never
 * inside the signal handler itself, which only ever records one. Resolves
 * once `signal` aborts, after the supervisor has wound down and a final
 * `daemonPid: 0` state has been written.
 */
export async function runTrayDaemon(deps: TrayDaemonDeps, signal: AbortSignal): Promise<void> {
  const log = (line: string): void => deps.log(`${deps.now().toISOString()} ${line}`);

  const env = deps.env;
  const cfgDir = configDir(env);
  const appSupportDir = env["PABLO_APP_SUPPORT_DIR"] ?? join(homedir(), "Library", "Application Support", "pablo");
  const statePath = ownedPath(cfgDir, "tray-state.json");
  const parcelPath = ownedPath(cfgDir, "tray-request.json");
  const queuePath = stateReviewPath(env);
  const sourcePath = join(import.meta.dir, "..", "..", "tray", "PabloTray.swift");
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;

  let lastError: string | undefined;

  function publish(daemonPidOverride?: number): void {
    const records = pending(readEvents(queuePath));
    const state: TrayState = {
      daemonPid: daemonPidOverride ?? process.pid,
      version: TRAY_VERSION,
      pending: toTrayPieces(records),
    };
    if (lastError !== undefined) state.lastError = lastError;
    writeTrayState(statePath, state);
  }

  // Written before anything else runs, so the first thing the helper (or a
  // person checking the file) reads is a real document, not a missing one.
  publish();

  let helperPath: string | undefined;
  try {
    const materialized = await deps.materialize({ source: sourcePath, appSupportDir, version: TRAY_VERSION });
    if (materialized.reason !== undefined) {
      log(materialized.reason);
    } else {
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
      // Recorded only — servicing (deciding, logging, publishing) happens on
      // the next loop tick, never inside this handler.
      pendingRequests.push(request);
      waker.wake();
    },
    process: deps.signalTarget,
  });

  let watcher: ReturnType<typeof watch> | undefined;
  let queueChanged = false;
  try {
    mkdirSync(dirname(queuePath), { recursive: true });
    watcher = watch(dirname(queuePath), () => {
      queueChanged = true;
      waker.wake();
    });
  } catch (error) {
    log(`could not watch the review queue directory: ${describeError(error)}`);
  }

  let supervisorDone: Promise<void> | undefined;
  if (env["PABLO_TRAY"] !== "0" && helperPath !== undefined) {
    const resolvedHelperPath = helperPath;
    supervisorDone = deps.supervise({
      spawn: () => deps.spawnHelper(resolvedHelperPath, statePath),
      log,
      sleep: deps.sleep,
      signal,
      now: () => deps.now().getTime(),
    });
  }

  function serviceRequest(request: TrayRequest): void {
    if (request.action === "approve") {
      const result = deps.decide(queuePath, {
        id: request.id,
        kind: "approved",
        by: "tray",
        read: false,
        now: deps.now(),
      });
      if (result.ok) {
        log(`approved ${request.id}`);
        lastError = undefined;
      } else {
        log(`approve ${request.id} failed: ${result.detail}`);
        lastError = TRAY_LAST_ERROR;
      }
      return;
    }

    // action === "review" — AGT-1259 wires this to the editor; until then,
    // the click is acknowledged in the log and nothing else happens.
    log(`review requested for ${request.id} (editor not wired yet)`);
    lastError = undefined;
  }

  try {
    while (!signal.aborted) {
      if (queueChanged) {
        queueChanged = false;
        publish();
      }

      while (pendingRequests.length > 0) {
        const request = pendingRequests.shift() as TrayRequest;
        serviceRequest(request);
        publish();
      }

      if (signal.aborted) break;
      await Promise.race([deps.sleep(pollMs), waker.wait(), whenAborted(signal)]);
    }
  } finally {
    stopListening();
    watcher?.close();
    if (supervisorDone !== undefined) await supervisorDone;
    lastError = undefined;
    publish(0);
  }
}
