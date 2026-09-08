import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, decide } from "../src/review";
import type { QueuedEvent } from "../src/review";
import type { OpenEditorOptions, OpenEditorResult } from "../src/edit";
import { runTrayDaemon, TRAY_LAST_ERROR } from "../src/tray/daemon";
import type { TrayDaemonDeps } from "../src/tray/daemon";
import type { SignalTarget, TrayRequest } from "../src/tray/request";
import type { MaterializeTrayBundleResult } from "../src/tray/bundle";
import type { SupervisedProcess } from "../src/tray/supervise";
import type { TrayState } from "../src/tray/state";

// AGT-1267: runTrayDaemon drives `pablo tray`'s whole loop in-process. Every
// test here injects `materialize` and `supervise` (never a real swiftc build,
// never a real spawned helper, never a real NSStatusItem) and a fake
// `signalTarget` (never a real, process-wide SIGUSR1 handler) — the real
// `decide` runs against a temp XDG_STATE_HOME/XDG_CONFIG_HOME so the queue
// file and the state file are exercised end to end.

/** A fake `process` for `listenForTrayRequests` — records the single handler installed and fires it on demand. */
function fakeSignalTarget(): SignalTarget & { fire: () => void; handlerCount: () => number } {
  const handlers = new Set<() => void>();
  return {
    on: (_signal, handler) => {
      handlers.add(handler);
    },
    off: (_signal, handler) => {
      handlers.delete(handler);
    },
    fire: () => {
      for (const handler of handlers) handler();
    },
    handlerCount: () => handlers.size,
  };
}

interface Fixture {
  env: Record<string, string | undefined>;
  queuePath: string;
  statePath: string;
  parcelPath: string;
  cleanup: () => void;
}

function useFixture(): Fixture {
  const stateHome = mkdtempSync(join(tmpdir(), "pablo-tray-daemon-state-"));
  const configHome = mkdtempSync(join(tmpdir(), "pablo-tray-daemon-config-"));
  return {
    env: { XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: configHome },
    queuePath: join(stateHome, "pablo", "review.jsonl"),
    statePath: join(configHome, "pablo", "tray-state.json"),
    parcelPath: join(configHome, "pablo", "tray-request.json"),
    cleanup: () => {
      rmSync(stateHome, { recursive: true, force: true });
      rmSync(configHome, { recursive: true, force: true });
    },
  };
}

function queuedEvent(overrides: Partial<QueuedEvent> = {}): QueuedEvent {
  return {
    type: "queued",
    id: "20260907-chapter-one-aaaa",
    at: "2026-09-07T00:00:00.000Z",
    kind: "chapter",
    title: "Chapter One",
    path: "/tmp/chapter-one.md",
    words: 100,
    prompt_hash: "deadbeef",
    ...overrides,
  };
}

/** A window the fake `openEditor` handed out — never a real ui-leaf mount or browser. */
interface FakeEditorWindow extends OpenEditorResult {
  /** True once `close()` (the daemon's own call) resolved this window's `closed`. */
  hostClosed: boolean;
  /** Test-only: resolves `closed` as the reader would — a decision, or just closing the window. */
  closeFromReader: () => void;
}

/**
 * A fake `openEditor` (never mounts ui-leaf, never launches a browser). Each
 * call opens one `FakeEditorWindow` whose `closed` only settles when this
 * test resolves it, either via the daemon's own `close()` or via
 * `closeFromReader()`. `fails` names piece ids that throw instead of opening,
 * for AC4.
 */
function createFakeOpenEditor(fails: ReadonlySet<string> = new Set()): {
  openEditor: TrayDaemonDeps["openEditor"];
  windows: FakeEditorWindow[];
} {
  const windows: FakeEditorWindow[] = [];
  const openEditor = async (opts: OpenEditorOptions): Promise<OpenEditorResult> => {
    const id = opts.piece?.id ?? opts.path;
    if (fails.has(id)) throw new Error(`fake refusal opening ${id}`);

    let settle: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let done = false;
    const resolveOnce = (): void => {
      if (done) return;
      done = true;
      settle();
    };
    const win: FakeEditorWindow = {
      url: `http://127.0.0.1:0/fake/${id}`,
      closed,
      hostClosed: false,
      close: () => {
        win.hostClosed = true;
        resolveOnce();
      },
      closeFromReader: resolveOnce,
    };
    windows.push(win);
    return win;
  };
  return { openEditor, windows };
}

function readState(statePath: string): TrayState {
  return JSON.parse(readFileSync(statePath, "utf8")) as TrayState;
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      if (check()) return;
    } catch {
      // The state file may not exist yet — keep polling.
    }
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A `materialize` fake that never builds anything — the default for tests that don't care about the helper. */
async function noHelper(): Promise<MaterializeTrayBundleResult> {
  return { bundlePath: "", helperPath: "", built: false, reason: "no helper in test" };
}

/** A `supervise` fake that resolves the moment `signal` aborts, exactly like the real one, without ever spawning anything. */
async function superviseUntilAborted(opts: { signal: AbortSignal }): Promise<void> {
  if (opts.signal.aborted) return;
  await new Promise<void>((resolve) => {
    opts.signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function baseDeps(fixture: Fixture, overrides: Partial<TrayDaemonDeps> = {}): TrayDaemonDeps {
  const logs: string[] = [];
  return {
    env: fixture.env,
    log: (line) => logs.push(line),
    now: () => new Date("2026-09-07T12:00:00.000Z"),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    materialize: noHelper,
    supervise: superviseUntilAborted,
    spawnHelper: () => {
      throw new Error("no test may spawn a real helper");
    },
    decide,
    openEditor: () => {
      throw new Error("no test may open a real editor window");
    },
    pollMs: 30,
    ...overrides,
  };
}

describe("runTrayDaemon", () => {
  test("a queued event appears and the state file lists it", async () => {
    const fixture = useFixture();
    const controller = new AbortController();
    const signalTarget = fakeSignalTarget();

    const run = runTrayDaemon(baseDeps(fixture, { signalTarget }), controller.signal);

    // Let the daemon publish its initial (empty) state before the queue changes.
    await waitFor(() => readState(fixture.statePath).pending.length === 0);

    appendEvent(fixture.queuePath, queuedEvent());

    await waitFor(() => readState(fixture.statePath).pending.length === 1);
    const state = readState(fixture.statePath);
    expect(state.pending[0]).toMatchObject({ id: "20260907-chapter-one-aaaa", title: "Chapter One", words: 100 });
    expect(state.lastError).toBeUndefined();

    controller.abort();
    await run;
    fixture.cleanup();
  });

  test("an approve request clears the piece and logs the outcome", async () => {
    const fixture = useFixture();
    appendEvent(fixture.queuePath, queuedEvent());

    const controller = new AbortController();
    const signalTarget = fakeSignalTarget();
    const logs: string[] = [];

    const run = runTrayDaemon(baseDeps(fixture, { signalTarget, log: (line) => logs.push(line) }), controller.signal);

    await waitFor(() => readState(fixture.statePath).pending.length === 1);

    const request: TrayRequest = { action: "approve", id: "20260907-chapter-one-aaaa" };
    await Bun.write(fixture.parcelPath, JSON.stringify(request));
    // Bun.write is async; give the parcel a moment to land before the signal fires.
    await waitFor(() => {
      readFileSync(fixture.parcelPath, "utf8");
      return true;
    });
    signalTarget.fire();

    await waitFor(() => readState(fixture.statePath).pending.length === 0);
    expect(readState(fixture.statePath).lastError).toBeUndefined();
    expect(logs.some((line) => line.includes("approved 20260907-chapter-one-aaaa"))).toBe(true);

    controller.abort();
    await run;
    fixture.cleanup();
  });

  test("AC1/AC4: a review request opens the editor and clears lastError on success", async () => {
    const fixture = useFixture();
    appendEvent(fixture.queuePath, queuedEvent());

    const controller = new AbortController();
    const signalTarget = fakeSignalTarget();
    const logs: string[] = [];
    const { openEditor, windows } = createFakeOpenEditor();

    const run = runTrayDaemon(
      baseDeps(fixture, { signalTarget, log: (line) => logs.push(line), openEditor }),
      controller.signal,
    );

    await waitFor(() => readState(fixture.statePath).pending.length === 1);

    await Bun.write(fixture.parcelPath, JSON.stringify({ action: "review", id: "20260907-chapter-one-aaaa" }));
    signalTarget.fire();

    await waitFor(() => windows.length === 1);
    expect(logs.some((line) => line.includes("opened the editor for 20260907-chapter-one-aaaa"))).toBe(true);
    expect(readState(fixture.statePath).lastError).toBeUndefined();
    // Reviewing doesn't decide anything on its own.
    expect(readState(fixture.statePath).pending.length).toBe(1);

    controller.abort();
    await run;
    expect(windows[0]?.hostClosed).toBe(true); // AC5, exercised here incidentally
    fixture.cleanup();
  });

  test("AC2: a second Review… closes the first before opening the new one, and the replaced window's closed is not reported", async () => {
    const fixture = useFixture();
    appendEvent(fixture.queuePath, queuedEvent());
    appendEvent(fixture.queuePath, queuedEvent({ id: "20260907-chapter-two-bbbb", title: "Chapter Two", path: "/tmp/chapter-two.md" }));

    const controller = new AbortController();
    const signalTarget = fakeSignalTarget();
    const { openEditor, windows } = createFakeOpenEditor();

    const run = runTrayDaemon(baseDeps(fixture, { signalTarget, openEditor }), controller.signal);

    await waitFor(() => readState(fixture.statePath).pending.length === 2);

    await Bun.write(fixture.parcelPath, JSON.stringify({ action: "review", id: "20260907-chapter-one-aaaa" }));
    signalTarget.fire();
    await waitFor(() => windows.length === 1);

    await Bun.write(fixture.parcelPath, JSON.stringify({ action: "review", id: "20260907-chapter-two-bbbb" }));
    signalTarget.fire();
    await waitFor(() => windows.length === 2);

    expect(windows[0]?.hostClosed).toBe(true); // the daemon closed it, not the reader
    expect(windows[1]?.hostClosed).toBe(false); // the replacement is still up

    // A late `closed` from the replaced window (as if the reader had also
    // clicked something in it right as it was being torn down) must not be
    // reported: `openWindow` has already moved on to window two, so the
    // approve-closes-the-open-window path below must still see window two as
    // current, not `null`.
    windows[0]?.closeFromReader();
    await Bun.write(fixture.parcelPath, JSON.stringify({ action: "approve", id: "20260907-chapter-two-bbbb" }));
    signalTarget.fire();
    await waitFor(() => windows[1]?.hostClosed === true);

    controller.abort();
    await run;
    fixture.cleanup();
  });

  test("AC3: approve from the menu for the open piece closes its window", async () => {
    const fixture = useFixture();
    appendEvent(fixture.queuePath, queuedEvent());

    const controller = new AbortController();
    const signalTarget = fakeSignalTarget();
    const { openEditor, windows } = createFakeOpenEditor();

    const run = runTrayDaemon(baseDeps(fixture, { signalTarget, openEditor }), controller.signal);

    await waitFor(() => readState(fixture.statePath).pending.length === 1);
    await Bun.write(fixture.parcelPath, JSON.stringify({ action: "review", id: "20260907-chapter-one-aaaa" }));
    signalTarget.fire();
    await waitFor(() => windows.length === 1);

    await Bun.write(fixture.parcelPath, JSON.stringify({ action: "approve", id: "20260907-chapter-one-aaaa" }));
    signalTarget.fire();

    await waitFor(() => readState(fixture.statePath).pending.length === 0);
    expect(windows[0]?.hostClosed).toBe(true);

    controller.abort();
    await run;
    fixture.cleanup();
  });

  test("AC3: a decision made in the window rewrites tray state promptly, without waiting for the poll", async () => {
    const fixture = useFixture();
    appendEvent(fixture.queuePath, queuedEvent());

    const controller = new AbortController();
    const signalTarget = fakeSignalTarget();
    const { openEditor, windows } = createFakeOpenEditor();

    // A large poll interval: if this only passed via the 10s-style fallback
    // rather than waking on `closed`, the `waitFor` below would time out.
    const run = runTrayDaemon(baseDeps(fixture, { signalTarget, openEditor, pollMs: 5000 }), controller.signal);

    await waitFor(() => readState(fixture.statePath).pending.length === 1);
    await Bun.write(fixture.parcelPath, JSON.stringify({ action: "review", id: "20260907-chapter-one-aaaa" }));
    signalTarget.fire();
    await waitFor(() => windows.length === 1);

    // The editor's own `approve()` records the decision, then closes itself.
    decide(fixture.queuePath, { id: "20260907-chapter-one-aaaa", kind: "approved", by: "editor", read: true });
    windows[0]?.closeFromReader();

    await waitFor(() => readState(fixture.statePath).pending.length === 0, 1000);

    // The window is gone; a fresh Review… for the same piece is free to open
    // a new one rather than being stuck behind stale bookkeeping.
    await Bun.write(fixture.parcelPath, JSON.stringify({ action: "review", id: "20260907-chapter-one-aaaa" }));
    signalTarget.fire();
    await waitFor(() => windows.length === 2);

    controller.abort();
    await run;
    fixture.cleanup();
  });

  test("AC4: a window that cannot open logs the real reason and sets the fixed lastError sentence, cleared on the next successful open", async () => {
    const fixture = useFixture();
    appendEvent(fixture.queuePath, queuedEvent());

    const controller = new AbortController();
    const signalTarget = fakeSignalTarget();
    const logs: string[] = [];
    const fails = new Set(["20260907-chapter-one-aaaa"]);
    const { openEditor, windows } = createFakeOpenEditor(fails);

    const run = runTrayDaemon(
      baseDeps(fixture, { signalTarget, log: (line) => logs.push(line), openEditor }),
      controller.signal,
    );

    await waitFor(() => readState(fixture.statePath).pending.length === 1);

    // Unknown id: never reaches `openEditor` at all.
    await Bun.write(fixture.parcelPath, JSON.stringify({ action: "review", id: "does-not-exist" }));
    signalTarget.fire();
    await waitFor(() => readState(fixture.statePath).lastError === TRAY_LAST_ERROR);
    expect(logs.some((line) => line.includes('no queued piece with id "does-not-exist"'))).toBe(true);

    // A known piece whose window refuses to open (Chromium probe, mount failure, ...).
    await Bun.write(fixture.parcelPath, JSON.stringify({ action: "review", id: "20260907-chapter-one-aaaa" }));
    signalTarget.fire();
    await waitFor(() => logs.some((line) => line.includes("fake refusal opening 20260907-chapter-one-aaaa")));
    expect(readState(fixture.statePath).lastError).toBe(TRAY_LAST_ERROR);
    expect(windows.length).toBe(0);

    // The next successful open clears it.
    fails.delete("20260907-chapter-one-aaaa");
    await Bun.write(fixture.parcelPath, JSON.stringify({ action: "review", id: "20260907-chapter-one-aaaa" }));
    signalTarget.fire();
    await waitFor(() => readState(fixture.statePath).lastError === undefined);
    expect(windows.length).toBe(1);

    controller.abort();
    await run;
    fixture.cleanup();
  });

  test("AC5: shutdown closes an open window, on the same signal, before the final state is written", async () => {
    const fixture = useFixture();
    appendEvent(fixture.queuePath, queuedEvent());

    const controller = new AbortController();
    const signalTarget = fakeSignalTarget();
    const { openEditor, windows } = createFakeOpenEditor();

    const run = runTrayDaemon(baseDeps(fixture, { signalTarget, openEditor }), controller.signal);

    await waitFor(() => readState(fixture.statePath).pending.length === 1);
    await Bun.write(fixture.parcelPath, JSON.stringify({ action: "review", id: "20260907-chapter-one-aaaa" }));
    signalTarget.fire();
    await waitFor(() => windows.length === 1);

    const start = Date.now();
    controller.abort();
    await run;
    const elapsedMs = Date.now() - start;

    expect(windows[0]?.hostClosed).toBe(true);
    expect(elapsedMs).toBeLessThan(3000);
    expect(readState(fixture.statePath).daemonPid).toBe(0);

    fixture.cleanup();
  });

  test("AC5 hard case: an abort that lands while openEditor is still in flight still closes the window once it resolves", async () => {
    const fixture = useFixture();
    appendEvent(fixture.queuePath, queuedEvent());

    const controller = new AbortController();
    const signalTarget = fakeSignalTarget();
    let openCalled = false;
    let releaseOpen: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    let window: FakeEditorWindow | undefined;

    const openEditor: TrayDaemonDeps["openEditor"] = async (opts) => {
      openCalled = true;
      await gate; // held open by the test until after `controller.abort()`
      const id = opts.piece?.id ?? opts.path;
      let settle: () => void = () => {};
      const closed = new Promise<void>((resolve) => {
        settle = resolve;
      });
      let done = false;
      window = {
        url: `http://127.0.0.1:0/fake/${id}`,
        closed,
        hostClosed: false,
        close: () => {
          if (done) return;
          done = true;
          if (window) window.hostClosed = true;
          settle();
        },
        closeFromReader: () => {
          if (done) return;
          done = true;
          settle();
        },
      };
      return window;
    };

    const run = runTrayDaemon(baseDeps(fixture, { signalTarget, openEditor }), controller.signal);

    await waitFor(() => readState(fixture.statePath).pending.length === 1);
    await Bun.write(fixture.parcelPath, JSON.stringify({ action: "review", id: "20260907-chapter-one-aaaa" }));
    signalTarget.fire();

    // Wait until `openEditor` has actually been called (and is now blocked
    // on `gate`) before aborting — this is the exact race the guard in
    // `openReviewWindow` exists for: `signal.aborted` is checked once more
    // AFTER the `await deps.openEditor(...)` resolves, not only before it.
    await waitFor(() => openCalled);
    controller.abort();
    releaseOpen();

    await run;

    expect(window).toBeDefined();
    expect(window?.hostClosed).toBe(true); // closed by the post-await guard, not left dangling
    expect(readState(fixture.statePath).daemonPid).toBe(0);

    fixture.cleanup();
  });

  test("a failed request (unknown piece) sets the fixed lastError sentence, cleared on the next success", async () => {
    const fixture = useFixture();
    appendEvent(fixture.queuePath, queuedEvent());

    const controller = new AbortController();
    const signalTarget = fakeSignalTarget();
    const logs: string[] = [];

    const run = runTrayDaemon(baseDeps(fixture, { signalTarget, log: (line) => logs.push(line) }), controller.signal);

    await waitFor(() => readState(fixture.statePath).pending.length === 1);

    await Bun.write(fixture.parcelPath, JSON.stringify({ action: "approve", id: "does-not-exist" }));
    signalTarget.fire();

    await waitFor(() => readState(fixture.statePath).lastError === TRAY_LAST_ERROR);
    // The real reason went to the log, not the state.
    expect(logs.some((line) => line.includes('no queued piece with id "does-not-exist"'))).toBe(true);

    // The next successful request clears it.
    await Bun.write(fixture.parcelPath, JSON.stringify({ action: "approve", id: "20260907-chapter-one-aaaa" }));
    signalTarget.fire();

    await waitFor(() => readState(fixture.statePath).lastError === undefined);
    expect(readState(fixture.statePath).pending.length).toBe(0);

    controller.abort();
    await run;
    fixture.cleanup();
  });

  test("abort aborts the supervisor, writes a final daemonPid: 0 state, and returns promptly", async () => {
    const fixture = useFixture();
    appendEvent(fixture.queuePath, queuedEvent());

    const controller = new AbortController();
    const signalTarget = fakeSignalTarget();
    let supervisorAborted = false;
    const supervise = async (opts: { signal: AbortSignal }): Promise<void> => {
      await new Promise<void>((resolve) => {
        opts.signal.addEventListener(
          "abort",
          () => {
            supervisorAborted = true;
            resolve();
          },
          { once: true },
        );
      });
    };

    const run = runTrayDaemon(
      baseDeps(fixture, {
        signalTarget,
        materialize: async () => ({ bundlePath: "", helperPath: "/fake/PabloTray", built: true }),
        supervise,
      }),
      controller.signal,
    );

    await waitFor(() => readState(fixture.statePath).pending.length === 1);

    const start = Date.now();
    controller.abort();
    await run;
    const elapsedMs = Date.now() - start;

    expect(supervisorAborted).toBe(true);
    expect(elapsedMs).toBeLessThan(3000);

    const finalState = readState(fixture.statePath);
    expect(finalState.daemonPid).toBe(0);
    expect(finalState.lastError).toBeUndefined();

    // The SIGUSR1 handler was torn down along with everything else.
    expect(signalTarget.handlerCount()).toBe(0);

    fixture.cleanup();
  });

  test("supervises the helper when materialize succeeds, unless PABLO_TRAY=0", async () => {
    const fixture = useFixture();
    let spawnCalls = 0;
    let superviseCalls = 0;
    const spawnHelper = (): SupervisedProcess => {
      spawnCalls += 1;
      return { exited: new Promise<number>(() => {}), kill: () => {} };
    };
    const supervise = async (opts: { spawn: () => SupervisedProcess; signal: AbortSignal }): Promise<void> => {
      superviseCalls += 1;
      opts.spawn();
      await superviseUntilAborted(opts);
    };

    const controllerOn = new AbortController();
    const runOn = runTrayDaemon(
      baseDeps(fixture, {
        materialize: async () => ({ bundlePath: "", helperPath: "/fake/PabloTray", built: true }),
        supervise,
        spawnHelper,
        signalTarget: fakeSignalTarget(),
      }),
      controllerOn.signal,
    );
    await waitFor(() => superviseCalls === 1);
    expect(spawnCalls).toBe(1);
    controllerOn.abort();
    await runOn;

    const fixtureOff = useFixture();
    const controllerOff = new AbortController();
    const runOff = runTrayDaemon(
      baseDeps(fixtureOff, {
        env: { ...fixtureOff.env, PABLO_TRAY: "0" },
        materialize: async () => ({ bundlePath: "", helperPath: "/fake/PabloTray", built: true }),
        supervise,
        spawnHelper,
        signalTarget: fakeSignalTarget(),
      }),
      controllerOff.signal,
    );
    await waitFor(() => readState(fixtureOff.statePath).pending.length === 0);
    controllerOff.abort();
    await runOff;
    expect(superviseCalls).toBe(1); // unchanged — PABLO_TRAY=0 skipped it entirely

    fixture.cleanup();
    fixtureOff.cleanup();
  });
});
