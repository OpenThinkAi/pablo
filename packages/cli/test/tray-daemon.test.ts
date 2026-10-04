import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cachedRoundDir } from "../src/read";
import { runTrayDaemon, TRAY_LAST_ERROR } from "../src/tray/daemon";
import type { OpenedRound, TrayDaemonDeps } from "../src/tray/daemon";
import { DEFAULT_INTERVAL_MS, MAX_BACKOFF_MS } from "../src/tray/poll";
import { CHECK_INTERVAL_MS } from "../src/tray/update";
import type { UpdateOutcome, Updater } from "../src/tray/update";
import type { SignalTarget } from "../src/tray/request";
import { notifiedPath, trayDir, trayParcelPath, trayStatePath } from "../src/tray/state";
import type { TrayState } from "../src/tray/state";
import { FakeClock, FakeGitHub, RecordingNotifier, tempDir } from "./tray-fakes";

// AGT-1589: the whole daemon loop in-process, against a fake GitHub, a fake
// clock, a recording notifier and a fake opener. No real notification, launchd
// agent, helper, window or network anywhere.

let home: string;
let env: Record<string, string>;
let gh: FakeGitHub;
let clock: FakeClock;
let notifier: RecordingNotifier;
let controller: AbortController;
let logs: string[];

beforeEach(() => {
  home = tempDir("pablo-tray-daemon-");
  env = { HOME: home, XDG_STATE_HOME: join(home, "state"), PABLO_APP_SUPPORT_DIR: join(home, "support") };
  gh = new FakeGitHub();
  clock = new FakeClock();
  notifier = new RecordingNotifier();
  controller = new AbortController();
  logs = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

type Step = (ms: number) => Promise<void> | void;

/** Deps whose `sleep` advances the fake clock and runs the next scripted step; the loop aborts after the script. */
function deps(steps: Step[], extra: Partial<TrayDaemonDeps> = {}): TrayDaemonDeps {
  let call = 0;
  return {
    env,
    log: (line) => logs.push(line),
    now: clock.now,
    sleep: async (ms) => {
      clock.sleeps.push(ms);
      const step = steps[call];
      call += 1;
      if (step === undefined) {
        controller.abort();
        return;
      }
      clock.advance(ms);
      await step(ms);
    },
    run: gh.run,
    notifier,
    openRound: () => ({ exited: new Promise(() => {}) }),
    materialize: async () => ({ bundlePath: "", helperPath: "", built: false, reason: "swiftc not found; run xcode-select --install" }),
    supervise: async () => {},
    spawnHelper: () => ({ exited: new Promise(() => {}), kill: () => {} }),
    helperSource: "/nonexistent/PabloTray.swift",
    ...extra,
  };
}

const readState = (): TrayState => JSON.parse(readFileSync(trayStatePath(trayDir(env)), "utf8")) as TrayState;

describe("polling and notifying", () => {
  test("one notification per new round, none for an unchanged (304) answer, one for a round that arrives later", async () => {
    gh.setRounds([{ pr: 1, sender: "matt", title: "Valley ch 3" }, { pr: 2 }]);
    await runTrayDaemon(
      deps([
        () => {}, // second poll: nothing changed -> 304
        () => gh.setRounds([{ pr: 1, sender: "matt", title: "Valley ch 3" }, { pr: 2 }, { pr: 3 }]),
      ]),
      controller.signal,
    );
    expect(notifier.events.map((e) => e.ref).sort()).toEqual(["OpenThinkAi/alpha-reading#1", "OpenThinkAi/alpha-reading#2", "OpenThinkAi/alpha-reading#3"]);
    expect(new Set(notifier.events.map((e) => e.ref)).size).toBe(3); // each exactly once
    expect(notifier.events.find((e) => e.ref.endsWith("#1"))).toMatchObject({ sender: "matt", title: "Valley ch 3" });
    // poll 1: 200 (first ask), poll 2: 304, poll 3: 200 after the change
    expect(gh.conditionalCalls.map((c) => c.outcome)).toEqual(["200", "304", "200"]);
    expect(gh.conditionalCalls[1]?.ifNoneMatch).toBeDefined();
    // The 304 poll cost one request and no listing.
    expect(gh.fullListings).toBe(2);
  });

  test("the loop waits the poll interval (30-60s) between healthy polls", async () => {
    gh.setRounds([{ pr: 1 }]);
    await runTrayDaemon(deps([() => {}, () => {}]), controller.signal);
    expect(clock.sleeps.length).toBeGreaterThanOrEqual(3);
    for (const ms of clock.sleeps.slice(0, 3)) {
      expect(ms).toBe(DEFAULT_INTERVAL_MS);
      expect(ms).toBeGreaterThanOrEqual(30_000);
      expect(ms).toBeLessThanOrEqual(60_000);
    }
  });

  test("a restart does not announce a round the reader was already told about", async () => {
    gh.setRounds([{ pr: 1 }]);
    await runTrayDaemon(deps([]), controller.signal);
    expect(notifier.events).toHaveLength(1);
    expect(JSON.parse(readFileSync(notifiedPath(trayDir(env)), "utf8"))).toEqual(["OpenThinkAi/alpha-reading#1"]);
    controller = new AbortController();
    await runTrayDaemon(deps([]), controller.signal);
    expect(notifier.events).toHaveLength(1);
  });

  test("a notification that fails to raise is retried on the next poll, then not repeated", async () => {
    gh.setRounds([{ pr: 1 }]);
    notifier.failNext = 1;
    await runTrayDaemon(deps([() => {}, () => {}]), controller.signal);
    expect(notifier.events).toHaveLength(1);
    expect(logs.some((l) => l.includes("could not notify"))).toBe(true);
  });

  test("a sent round is listed as sent and never notified; the state file carries titles only", async () => {
    gh.setRounds([{ pr: 5, title: "Sent already" }]);
    const ref = { repo: "OpenThinkAi/alpha-reading", pr: 5 };
    const cache = cachedRoundDir(ref, env);
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "round.json"), JSON.stringify({ id: "atara-2026-10-02", repo: ref.repo, pr: 5 }));
    writeFileSync(join(cache, "atara-2026-10-02.sent.json"), JSON.stringify({ id: "atara-2026-10-02" }));
    gh.setRounds([{ pr: 5, title: "Sent already" }, { pr: 6, title: "Waiting one" }]);
    await runTrayDaemon(deps([]), controller.signal);
    expect(notifier.events.map((e) => e.ref)).toEqual(["OpenThinkAi/alpha-reading#6"]);
    const state = readState();
    expect(state.rounds.map((r) => [r.ref, r.status])).toEqual([
      ["OpenThinkAi/alpha-reading#6", "waiting"],
      ["OpenThinkAi/alpha-reading#5", "sent"],
    ]);
    expect(Object.keys(state.rounds[0] ?? {}).sort()).toEqual(["ref", "sender", "status", "title"]);
  });
});

describe("surviving errors", () => {
  test("backs off on consecutive failures, never exits on its own, and returns to the interval once GitHub answers", async () => {
    gh.setRounds([{ pr: 1 }]);
    gh.down = true;
    const recover = (): void => {
      gh.down = false;
    };
    await runTrayDaemon(deps([() => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, recover, () => {}]), controller.signal);
    const waits = clock.sleeps;
    // 90s, 180s, 360s, then the 10 minute cap
    expect(waits.slice(0, 4)).toEqual([DEFAULT_INTERVAL_MS * 2, DEFAULT_INTERVAL_MS * 4, DEFAULT_INTERVAL_MS * 8, MAX_BACKOFF_MS]);
    expect(Math.max(...waits)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
    expect(waits).toContain(MAX_BACKOFF_MS);
    // the poll after recovery waits the plain interval again
    expect(waits[waits.length - 2]).toBe(DEFAULT_INTERVAL_MS);
    expect(notifier.events).toHaveLength(1);
  });

  test("lastError is a fixed sentence while failing and clears on success; the reason goes to the log", async () => {
    gh.setRounds([{ pr: 1 }]);
    gh.down = true;
    let seen: string | undefined;
    await runTrayDaemon(
      deps([
        () => {
          seen = readState().lastError;
          gh.down = false;
        },
      ]),
      controller.signal,
    );
    expect(seen).toBe(TRAY_LAST_ERROR);
    expect(logs.some((l) => l.includes("network is unreachable"))).toBe(true);
    expect(readState().lastError).toBeUndefined();
  });

  test("a runner that throws does not end the loop", async () => {
    let calls = 0;
    await runTrayDaemon(
      deps([() => {}, () => {}], {
        run: () => {
          calls += 1;
          throw new Error("spawn exploded");
        },
      }),
      controller.signal,
    );
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});

describe("opening a round", () => {
  function fakeSignals(): { target: SignalTarget; ring: () => void; installed: () => number } {
    const handlers = new Set<() => void>();
    return {
      target: { on: (_s, h) => void handlers.add(h), off: (_s, h) => void handlers.delete(h) },
      ring: () => handlers.forEach((h) => h()),
      installed: () => handlers.size,
    };
  }
  const parcel = (ref: string): void => {
    mkdirSync(trayDir(env), { recursive: true });
    writeFileSync(trayParcelPath(trayDir(env)), JSON.stringify({ action: "open", ref }));
  };

  test("a click opens the round through the one entry: only a listed round, once while its view is open", async () => {
    gh.setRounds([{ pr: 1 }]);
    const signals = fakeSignals();
    const opened: string[] = [];
    let release: () => void = () => {};
    const view: OpenedRound = { exited: new Promise<void>((resolve) => (release = resolve)) };
    let waits = 0;
    await runTrayDaemon(
      deps([], {
        signalTarget: signals.target,
        openRound: (ref) => {
          opened.push(`${ref.repo}#${ref.pr}`);
          return view;
        },
        sleep: async (ms) => {
          clock.sleeps.push(ms);
          waits += 1;
          if (waits === 1) {
            await new Promise((r) => setTimeout(r, 0)); // a signal arrives while the loop is already waiting
            // While the loop waits: a click on the listed round, a duplicate, a round never listed, junk.
            parcel("OpenThinkAi/alpha-reading#1");
            signals.ring();
            parcel("OpenThinkAi/alpha-reading#1");
            signals.ring();
            parcel("OpenThinkAi/other-reading#99");
            signals.ring();
            writeFileSync(trayParcelPath(trayDir(env)), "not json");
            signals.ring();
            return new Promise<void>(() => {}); // the wait ends by the wake-up, not by the clock
          }
          controller.abort();
        },
      }),
      controller.signal,
    );
    expect(opened).toEqual(["OpenThinkAi/alpha-reading#1"]);
    expect(logs.some((l) => l.includes("ignored a request to open OpenThinkAi/other-reading#99"))).toBe(true);
    expect(existsSync(trayParcelPath(trayDir(env)))).toBe(false); // every parcel is read-and-deleted
    expect(signals.installed()).toBe(0); // the handler is removed on shutdown
    release();
  });

  test("an open that throws is logged and surfaces the fixed error; the loop carries on", async () => {
    gh.setRounds([{ pr: 1 }]);
    const signals = fakeSignals();
    let waits = 0;
    let seen: string | undefined;
    await runTrayDaemon(
      deps([], {
        signalTarget: signals.target,
        openRound: () => {
          throw new Error("no bun");
        },
        sleep: async () => {
          waits += 1;
          if (waits === 1) {
            await new Promise((r) => setTimeout(r, 0));
            parcel("OpenThinkAi/alpha-reading#1");
            signals.ring();
            return new Promise<void>(() => {});
          }
          seen = readState().lastError;
          controller.abort();
        },
      }),
      controller.signal,
    );
    expect(seen).toBe(TRAY_LAST_ERROR);
    expect(logs.some((l) => l.includes("could not open OpenThinkAi/alpha-reading#1: no bun"))).toBe(true);
  });
});

describe("the helper and shutdown", () => {
  test("a built helper is supervised against the state file; PABLO_TRAY=0 skips it", async () => {
    gh.setRounds([{ pr: 1 }]);
    const spawned: string[][] = [];
    const supervised = { count: 0 };
    const build = (): Partial<TrayDaemonDeps> => ({
      materialize: async () => ({ bundlePath: "/b", helperPath: "/b/PabloTray", built: true }),
      supervise: async (opts) => {
        supervised.count += 1;
        opts.spawn();
      },
      spawnHelper: (helper, statePath) => {
        spawned.push([helper, statePath]);
        return { exited: new Promise(() => {}), kill: () => {} };
      },
    });
    await runTrayDaemon(deps([], build()), controller.signal);
    expect(supervised.count).toBe(1);
    expect(spawned).toEqual([["/b/PabloTray", trayStatePath(trayDir(env))]]);

    controller = new AbortController();
    env["PABLO_TRAY"] = "0";
    await runTrayDaemon(deps([], build()), controller.signal);
    expect(supervised.count).toBe(1);
  });

  test("a helper that cannot be built leaves the poller running and says so", async () => {
    gh.setRounds([{ pr: 1 }]);
    await runTrayDaemon(deps([]), controller.signal);
    expect(logs.some((l) => l.includes("no menu-bar icon") && l.includes("xcode-select"))).toBe(true);
    expect(notifier.events).toHaveLength(1);
  });

  test("shutdown writes a final state with daemonPid 0", async () => {
    gh.setRounds([{ pr: 1 }]);
    let during = 0;
    await runTrayDaemon(
      deps([
        () => {
          during = readState().daemonPid;
        },
      ]),
      controller.signal,
    );
    expect(during).toBe(process.pid);
    expect(readState().daemonPid).toBe(0);
  });
});

describe("self-update (AGT-1598)", () => {
  /** An updater that records what the loop told it and answers from a script. */
  function fakeUpdater(answers: UpdateOutcome[], updatedTo?: string): { updater: Updater; ticks: { check: boolean; busy: boolean }[] } {
    const ticks: { check: boolean; busy: boolean }[] = [];
    const updater: Updater = {
      tick: async (options) => {
        ticks.push(options);
        return answers[Math.min(ticks.length - 1, answers.length - 1)] ?? { kind: "idle" };
      },
      updatedTo: () => updatedTo,
    };
    return { updater, ticks };
  }

  test("a verified update stops the loop, winds the helper down, writes the final state, and only then exits 0", async () => {
    gh.setRounds([{ pr: 1 }]);
    const { updater, ticks } = fakeUpdater([{ kind: "upgraded", version: "0.3.0" }]);
    const exits: { code: number; daemonPid: number | undefined; supervisorAborted: boolean }[] = [];
    let supervisorSignal: AbortSignal | undefined;
    await runTrayDaemon(
      deps([], {
        update: updater,
        materialize: async () => ({ bundlePath: "/b", helperPath: "/b/h", built: false }),
        supervise: async (opts) => {
          supervisorSignal = opts.signal;
          await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
        },
        exit: (code) => exits.push({ code, daemonPid: readState().daemonPid, supervisorAborted: supervisorSignal?.aborted === true }),
      }),
      controller.signal,
    );
    expect(ticks).toHaveLength(1); // no second turn of the loop
    expect(exits).toEqual([{ code: 0, daemonPid: 0, supervisorAborted: true }]);
    expect(controller.signal.aborted).toBe(false); // the caller's own signal was never the thing that stopped it
  });

  test("an ordinary shutdown never calls exit", async () => {
    const { updater } = fakeUpdater([{ kind: "idle" }]);
    const exits: number[] = [];
    await runTrayDaemon(deps([], { update: updater, exit: (c) => exits.push(c) }), controller.signal);
    expect(exits).toEqual([]);
  });

  test("the check is due on start and every six hours; between, a tick is only a look at what is known", async () => {
    const { updater, ticks } = fakeUpdater([{ kind: "idle" }]);
    await runTrayDaemon(
      deps([() => {}, () => clock.advance(CHECK_INTERVAL_MS), () => {}], { update: updater }),
      controller.signal,
    );
    expect(ticks.map((t) => t.check)).toEqual([true, false, true, false]);
  });

  test("busy while a reader window is open in another process, and while one this tray opened is", async () => {
    gh.setRounds([{ pr: 1 }]);
    let active = true;
    const { updater, ticks } = fakeUpdater([{ kind: "deferred", version: "0.3.0" }]);
    await runTrayDaemon(deps([() => void (active = false)], { update: updater, readerActive: () => active }), controller.signal);
    expect(ticks.map((t) => t.busy)).toEqual([true, false]);
    expect(logs.filter((l) => l.includes("waiting: a reader window is open"))).toHaveLength(1); // said once, not per poll
  });

  test("the tray's own open view counts as busy until it closes", async () => {
    gh.setRounds([{ pr: 1 }]);
    const { updater, ticks } = fakeUpdater([{ kind: "idle" }]);
    const handlers = new Set<() => void>();
    let release: () => void = () => {};
    let waits = 0;
    mkdirSync(trayDir(env), { recursive: true });
    await runTrayDaemon(
      deps([], {
        update: updater,
        signalTarget: { on: (_s, h) => void handlers.add(h), off: (_s, h) => void handlers.delete(h) },
        openRound: () => ({ exited: new Promise<void>((resolve) => (release = resolve)) }),
        sleep: async () => {
          waits += 1;
          if (waits === 1) {
            await new Promise((r) => setTimeout(r, 0));
            writeFileSync(trayParcelPath(trayDir(env)), JSON.stringify({ action: "open", ref: "OpenThinkAi/alpha-reading#1" }));
            handlers.forEach((h) => h());
            return new Promise<void>(() => {});
          }
          if (waits === 2) return; // the wait ends with the window still open: the next turn sees it
          if (waits === 3) {
            release(); // the window closes
            await new Promise((r) => setTimeout(r, 0));
            return;
          }
          controller.abort();
        },
      }),
      controller.signal,
    );
    expect(ticks.map((t) => t.busy)).toEqual([false, true, false]);
  });

  test("the state file carries pablo's version and, after an update, updatedTo", async () => {
    const { updater } = fakeUpdater([{ kind: "idle" }], "0.3.0");
    await runTrayDaemon(deps([], { update: updater, version: "0.3.0" }), controller.signal);
    // after shutdown the final state keeps both; during the run they were written too
    const final = readState();
    expect(final.version).toBe("0.3.0");
    expect(final.updatedTo).toBe("0.3.0");
  });

  test("an updater that throws is logged and does not end the loop", async () => {
    const updater: Updater = { tick: async () => Promise.reject(new Error("boom")), updatedTo: () => undefined };
    await runTrayDaemon(deps([() => {}], { update: updater }), controller.signal);
    expect(logs.some((l) => l.includes("the updater failed: boom"))).toBe(true);
  });
});
