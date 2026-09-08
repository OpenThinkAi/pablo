/**
 * `pablo tray` — the one long-lived pablo process: it materialises the menu-
 * bar helper (`bundle.ts`, AGT-1265), supervises it (`supervise.ts`), keeps
 * `~/.config/pablo/tray-state.json` in sync with the review queue
 * (`state.ts`, AGT-1266), and services the helper's clicks
 * (`request.ts`, AGT-1266) by calling straight into `review.ts`'s `decide`
 * (AGT-1255) so the append-only log stays the single source of truth.
 *
 * `runTrayDaemon(deps, signal)` is the whole loop with every side effect
 * injectable — `materialize`, `supervise`, `decide`, `openEditor` and `now`
 * chief among them — so a test can drive it in-process against a temp
 * `XDG_STATE_HOME`/`XDG_CONFIG_HOME` without ever compiling a real helper,
 * spawning a real process, or opening a real window. `cli.ts`'s `tray` verb
 * supplies the real implementations and a real `AbortSignal` tied to
 * SIGTERM/SIGINT.
 *
 * A `review` request opens AGT-1258's editor window on the piece, hosted by
 * this daemon (AGT-1259): at most one window at a time, closed and replaced
 * by a second `Review…`, closed by a menu `approve` of the piece it shows,
 * and closed on shutdown before the process exits — all on the same
 * `signal` this function is given.
 */

import { mkdirSync, watch } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configDir } from "@openthink/pablo-core";
import type { MaterializeTrayBundleOptions, MaterializeTrayBundleResult } from "./bundle";
import type { SupervisedProcess, SuperviseHelperOptions } from "./supervise";
import { listenForTrayRequests } from "./request";
import type { SignalTarget, TrayRequest } from "./request";
import { toTrayPieces, writeTrayState } from "./state";
import type { TrayState } from "./state";
import { pending, readEvents, record } from "../review";
import type { DecideInput, DecideResult } from "../review";
import { stateReviewPath } from "../paths";
import type { OpenEditorOptions, OpenEditorResult } from "../edit";

/** Recorded in `build.json` and shown in the state file's `version`. */
const TRAY_VERSION = "0.1.0";

/** The fixed sentence `lastError` carries — the real reason goes to the log only. */
export const TRAY_LAST_ERROR = "it did not work; the log says why";

/** How often the queue file is polled as a fallback to `fs.watch`. */
const DEFAULT_POLL_MS = 10_000;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  /**
   * Opens the editor window on a piece (AGT-1259) — AGT-1258's `openEditor`
   * in production, called with the daemon's own `signal` so a shutdown that
   * fires mid-open still tears the window down. Every test injects a fake
   * that never mounts a real ui-leaf window or launches a real browser.
   */
  readonly openEditor: (opts: OpenEditorOptions) => Promise<OpenEditorResult>;
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
  const statePath = join(cfgDir, "tray-state.json");
  const parcelPath = join(cfgDir, "tray-request.json");
  const queuePath = stateReviewPath(env);
  const sourcePath = join(import.meta.dir, "..", "..", "tray", "PabloTray.swift");
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;

  let lastError: string | undefined;

  /**
   * The one editor window this daemon may have open, and the piece it shows
   * (AC2). Cleared to `null` the moment it is replaced, closed by a menu
   * approve, or closed on shutdown — always *before* the corresponding
   * `close()`/`closed` settles, so the `onWindowClosed` identity check below
   * can tell a window that is still current from one that has already been
   * superseded.
   */
  let openWindow: { readonly id: string; readonly window: OpenEditorResult } | null = null;
  /** Set when `openWindow`'s own window closed on its own (AC3) — read at the top of the loop, like `queueChanged`. */
  let windowClosed = false;

  /**
   * `window.closed` settles whenever the reader closes it, whether that is a
   * decision made in the window, the disconnect timeout, or `close()` called
   * from here. Only report it when `window` is still the one on screen — a
   * replaced window's `closed` resolving later is not news (AC2), and by the
   * time this runs `openWindow` may already have moved on, including past an
   * `await` this same window was part of.
   */
  function onWindowClosed(window: OpenEditorResult): void {
    if (openWindow?.window !== window) return;
    openWindow = null;
    windowClosed = true;
    waker.wake();
  }

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

  /**
   * `review` — opens AGT-1258's editor on `id` (AC1), replacing any window
   * already open (AC2) and clearing/re-arming `lastError` exactly as
   * `approve` does (AC4).
   */
  async function openReviewWindow(id: string): Promise<void> {
    const found = record(readEvents(queuePath), id);
    if (found === undefined) {
      log(`review ${id} failed: no queued piece with id "${id}"`);
      lastError = TRAY_LAST_ERROR;
      return;
    }

    // Closed BEFORE the new one is mounted, not after: two windows alive at
    // once is exactly what AC2 forbids, and mounting the new one first would
    // hold both for however long that takes. `openWindow` is cleared here,
    // synchronously, so `onWindowClosed` never reports this one once it goes.
    const previous = openWindow;
    openWindow = null;
    if (previous !== null) {
      try {
        previous.window.close();
      } catch {
        // Already gone — the replacement is what matters.
      }
    }

    let window: OpenEditorResult;
    try {
      window = await deps.openEditor({ path: found.piece.path, piece: found.piece, signal });
    } catch (error) {
      log(`review ${id} failed: ${describeError(error)}`);
      lastError = TRAY_LAST_ERROR;
      return;
    }

    // The open can take real time (AC1's own 3s budget), and nothing else in
    // this function is awaited before it — so a shutdown asked for while it
    // was in flight has already run the `finally` block below with nothing
    // in `openWindow` to close. A check made only before this `await` would
    // already be stale by the time we get here; it has to be repeated after.
    if (signal.aborted) {
      try {
        window.close();
      } catch {
        // Shutting down anyway.
      }
      return;
    }

    openWindow = { id, window };
    lastError = undefined;
    log(`opened the editor for ${id}`);
    void window.closed.then(
      () => onWindowClosed(window),
      () => onWindowClosed(window),
    );
  }

  async function serviceRequest(request: TrayRequest): Promise<void> {
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
        // AC3: an approve from the menu for the piece whose window is open
        // closes that window.
        if (openWindow !== null && openWindow.id === request.id) {
          const window = openWindow.window;
          openWindow = null;
          try {
            window.close();
          } catch {
            // Already gone.
          }
        }
      } else {
        log(`approve ${request.id} failed: ${result.detail}`);
        lastError = TRAY_LAST_ERROR;
      }
      return;
    }

    // action === "review"
    await openReviewWindow(request.id);
  }

  try {
    while (!signal.aborted) {
      if (queueChanged) {
        queueChanged = false;
        publish();
      }

      // AC3: a decision or a plain close made in the window rewrites tray
      // state on this pass rather than waiting on the queue watcher or the
      // 10s poll.
      if (windowClosed) {
        windowClosed = false;
        publish();
      }

      while (pendingRequests.length > 0) {
        const request = pendingRequests.shift() as TrayRequest;
        await serviceRequest(request);
        publish();
      }

      if (signal.aborted) break;
      await Promise.race([
        deps.sleep(pollMs),
        waker.wait(),
        new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
      ]);
    }
  } finally {
    stopListening();
    watcher?.close();
    // AC5: shutdown closes an open window, on this same signal, before the
    // helper exits — awaited so the window is actually gone, not merely told
    // to go, before the final state is written.
    if (openWindow !== null) {
      const window = openWindow.window;
      openWindow = null;
      try {
        window.close();
      } catch {
        // Already gone.
      }
      await window.closed.catch(() => {
        // A window that fails to close cleanly still must not hang shutdown.
      });
    }
    if (supervisorDone !== undefined) await supervisorDone;
    lastError = undefined;
    publish(0);
  }
}
