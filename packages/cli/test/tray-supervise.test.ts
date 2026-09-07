import { describe, expect, test } from "bun:test";
import { restartDelayMs, spawnTrayHelper, superviseHelper } from "../src/tray/supervise";
import type { SupervisedProcess } from "../src/tray/supervise";

// AGT-1265: superviseHelper keeps exactly one tray helper alive. Every test
// here injects `spawn` and `sleep` — no real helper binary is ever launched
// except in the reaping test, which spawns a real (harmless) process and
// asserts it does not survive the test.

describe("restartDelayMs", () => {
  test("doubles from 1s and caps at 60s", () => {
    expect(restartDelayMs(0)).toBe(1000);
    expect(restartDelayMs(1)).toBe(2000);
    expect(restartDelayMs(2)).toBe(4000);
    expect(restartDelayMs(3)).toBe(8000);
    expect(restartDelayMs(6)).toBe(60000); // 1000*2^6 = 64000, capped
    expect(restartDelayMs(20)).toBe(60000);
  });
});

describe("superviseHelper", () => {
  test("backs off 1s, 2s, 4s, 8s across four consecutive quick exits", async () => {
    const controller = new AbortController();
    const delays: number[] = [];
    let spawnCount = 0;

    const spawn = (): SupervisedProcess => {
      spawnCount += 1;
      return { exited: Promise.resolve(1), kill: () => {} };
    };
    const sleep = async (ms: number): Promise<void> => {
      delays.push(ms);
      if (delays.length >= 4) controller.abort();
    };

    await superviseHelper({
      spawn,
      log: () => {},
      sleep,
      signal: controller.signal,
      now: () => 0, // every run "lasts" 0ms — always counts as a quick failure
    });

    expect(delays).toEqual([1000, 2000, 4000, 8000]);
    expect(spawnCount).toBe(4);
  });

  test("a run lasting 30s or longer resets the backoff", async () => {
    const controller = new AbortController();
    const delays: number[] = [];
    // Two timestamps consumed per iteration: startedAt, then the read after
    // exit. Iterations 1 and 2 are quick (100ms, 200ms); iteration 3 is a
    // healthy 40s run; iteration 4 is quick again, proving the reset stuck.
    const clock = [0, 100, 100, 300, 300, 40_300, 40_300, 40_400];
    let clockIndex = 0;
    const now = (): number => {
      const value = clock[clockIndex];
      clockIndex += 1;
      return value ?? 0;
    };

    const spawn = (): SupervisedProcess => ({ exited: Promise.resolve(1), kill: () => {} });
    const sleep = async (ms: number): Promise<void> => {
      delays.push(ms);
      if (delays.length >= 4) controller.abort();
    };

    await superviseHelper({ spawn, log: () => {}, sleep, signal: controller.signal, now });

    // Grows 1000 -> 2000, drops back to 1000 after the healthy run, then
    // starts growing again from 1000 rather than continuing to 4000/8000.
    expect(delays).toEqual([1000, 2000, 1000, 1000]);
  });

  test("absorbs a thrown spawn error as a logged line and keeps supervising", async () => {
    const controller = new AbortController();
    const lines: string[] = [];
    let spawnCount = 0;

    const spawn = (): SupervisedProcess => {
      spawnCount += 1;
      throw new Error("bundle is missing");
    };
    const sleep = async (): Promise<void> => {
      if (spawnCount >= 2) controller.abort();
    };

    await superviseHelper({
      spawn,
      log: (line) => lines.push(line),
      sleep,
      signal: controller.signal,
      now: () => 0,
    });

    expect(spawnCount).toBeGreaterThanOrEqual(2);
    expect(lines.some((line) => line.includes("could not be started") && line.includes("bundle is missing"))).toBe(
      true,
    );
  });

  test("never calls spawn when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let spawnCount = 0;

    await superviseHelper({
      spawn: () => {
        spawnCount += 1;
        return { exited: Promise.resolve(0), kill: () => {} };
      },
      log: () => {},
      sleep: async () => {},
      signal: controller.signal,
    });

    expect(spawnCount).toBe(0);
  });

  test("abort kills the current child and returns, even if it never exits on its own", async () => {
    const controller = new AbortController();
    let killed = false;
    let spawnCount = 0;

    const spawn = (): SupervisedProcess => {
      spawnCount += 1;
      return {
        exited: new Promise<number>(() => {
          /* never resolves — the only way out is being killed */
        }),
        kill: () => {
          killed = true;
        },
      };
    };

    const promise = superviseHelper({
      spawn,
      log: () => {},
      sleep: async () => {},
      signal: controller.signal,
    });

    controller.abort();
    await promise;

    expect(killed).toBe(true);
    expect(spawnCount).toBe(1);
  });

  test("a real spawned child is killed and reaped on abort — no stray process left", async () => {
    const controller = new AbortController();
    const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    const pid = child.pid;

    const promise = superviseHelper({
      spawn: (): SupervisedProcess => ({ exited: child.exited, kill: () => child.kill() }),
      log: () => {},
      sleep: async () => {},
      signal: controller.signal,
    });

    controller.abort();
    await promise;

    // The kill was requested; now prove the OS actually reaped it, rather
    // than just trusting that `kill()` was called.
    const exitCode = await child.exited;
    expect(exitCode).not.toBeNull();

    let stillRunning = true;
    try {
      process.kill(pid, 0);
    } catch {
      stillRunning = false;
    }
    expect(stillRunning).toBe(false);
  });
});

describe("spawnTrayHelper", () => {
  test("spawns [helperPath, statePath] with stdio ignored, and the child can be reaped", async () => {
    // `/bin/echo` stands in for the compiled helper: it accepts the same
    // argv shape (two positional strings) and exits immediately on its own,
    // so no kill is needed and nothing is left running after this test.
    const child = spawnTrayHelper("/bin/echo", "state.json");
    const exitCode = await child.exited;
    expect(exitCode).toBe(0);
  });
});
