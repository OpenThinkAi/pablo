import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent, readEvents } from "../src/review";
import type { DecisionEvent, QueuedEvent } from "../src/review";
import { reviewCore } from "../src/review-verbs";

/**
 * `pablo review list|show|approve|reject|wait` (AGT-1261), exercised end to
 * end through the real CLI binary (mirrors `save.test.ts`/`prose.test.ts`'s
 * `runCli` pattern) against a throwaway `XDG_STATE_HOME` — never the real
 * `~/.local/state/pablo/review.jsonl`. `review` never shells out to `think`
 * or resolves a vault, so no `NO_THINK_PATH`/`PABLO_VAULT` is needed here.
 */
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempStateHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-review-verbs-state-"));
  cleanupDirs.push(dir);
  return dir;
}

function queuePath(stateHome: string): string {
  return join(stateHome, "pablo", "review.jsonl");
}

function runCli(
  args: string[],
  stateHome: string,
  env: Record<string, string> = {},
): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync(["bun", "run", CLI, ...args], {
    env: { ...process.env, XDG_STATE_HOME: stateHome, ...env },
  });
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode };
}

function queuedEvent(overrides: Partial<QueuedEvent> = {}): QueuedEvent {
  return {
    type: "queued",
    id: "20260907-hello-abcd",
    at: "2026-09-07T10:00:00.000Z",
    kind: "chapter",
    title: "Hello",
    path: "/tmp/hello.md",
    words: 500,
    prompt_hash: "deadbeef",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// review list
// ---------------------------------------------------------------------------

describe("pablo review list", () => {
  test("an empty queue prints \"nothing waiting\" and exits 0", () => {
    const stateHome = tempStateHome();
    const result = runCli(["review", "list"], stateHome);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("nothing waiting");
  });

  test("an empty queue with --json prints an empty array and exits 0", () => {
    const stateHome = tempStateHome();
    const result = runCli(["review", "list", "--json"], stateHome);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  test("pending pieces print newest first, one line each <id>  <kind>  <words>w  <title>  <path>", () => {
    const stateHome = tempStateHome();
    const path = queuePath(stateHome);
    appendEvent(path, queuedEvent({ id: "a", at: "2026-09-07T10:00:00.000Z", title: "First" }));
    appendEvent(path, queuedEvent({ id: "b", at: "2026-09-07T11:00:00.000Z", title: "Second" }));

    const result = runCli(["review", "list"], stateHome);

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toEqual(["b  chapter  500w  Second  /tmp/hello.md", "a  chapter  500w  First  /tmp/hello.md"]);
  });

  test("--json prints the array of pending records", () => {
    const stateHome = tempStateHome();
    const path = queuePath(stateHome);
    appendEvent(path, queuedEvent({ id: "a" }));

    const result = runCli(["review", "list", "--json"], stateHome);

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body).toEqual([
      { id: "a", at: "2026-09-07T10:00:00.000Z", kind: "chapter", title: "Hello", path: "/tmp/hello.md", words: 500, prompt_hash: "deadbeef" },
    ]);
  });

  test("a decided piece is excluded from the default listing but included with --all, carrying its decision", () => {
    const stateHome = tempStateHome();
    const path = queuePath(stateHome);
    appendEvent(path, queuedEvent({ id: "a", at: "2026-09-07T10:00:00.000Z" }));
    appendEvent(path, queuedEvent({ id: "b", at: "2026-09-07T11:00:00.000Z", title: "Still pending" }));
    const decision: DecisionEvent = { type: "approved", id: "a", at: "2026-09-07T12:00:00.000Z", by: "cli", read: true };
    appendEvent(path, decision);

    const withoutAll = runCli(["review", "list", "--json"], stateHome);
    expect(JSON.parse(withoutAll.stdout).map((r: { id: string }) => r.id)).toEqual(["b"]);

    const withAll = runCli(["review", "list", "--all"], stateHome);
    expect(withAll.exitCode).toBe(0);
    const lines = withAll.stdout.trim().split("\n");
    expect(lines).toEqual([
      "b  chapter  500w  Still pending  /tmp/hello.md",
      "a  chapter  500w  Hello  /tmp/hello.md  [approved]",
    ]);

    const withAllJson = runCli(["review", "list", "--all", "--json"], stateHome);
    const body = JSON.parse(withAllJson.stdout) as Array<{ id: string; decision?: DecisionEvent }>;
    expect(body.find((r) => r.id === "a")?.decision).toEqual(decision);
    expect(body.find((r) => r.id === "b")?.decision).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// review show
// ---------------------------------------------------------------------------

describe("pablo review show", () => {
  test("prints the record, and \"pending\"/\"no edits\" when there is no decision or edit yet", () => {
    const stateHome = tempStateHome();
    appendEvent(queuePath(stateHome), queuedEvent());

    const result = runCli(["review", "show", "20260907-hello-abcd"], stateHome);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("20260907-hello-abcd  chapter  500w  Hello  /tmp/hello.md");
    expect(result.stdout).toContain("pending");
    expect(result.stdout).toContain("no edits");
  });

  test("--json prints {piece, decision, edits}", () => {
    const stateHome = tempStateHome();
    const path = queuePath(stateHome);
    appendEvent(path, queuedEvent());
    const decision: DecisionEvent = { type: "rejected", id: "20260907-hello-abcd", at: "2026-09-07T11:00:00.000Z", by: "cli", read: true, reason: "not this one" };
    appendEvent(path, decision);
    appendEvent(path, { type: "edited", id: "20260907-hello-abcd", at: "2026-09-07T10:30:00.000Z", words: 520 });

    const result = runCli(["review", "show", "20260907-hello-abcd", "--json"], stateHome);

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body).toEqual({
      piece: { id: "20260907-hello-abcd", at: "2026-09-07T10:00:00.000Z", kind: "chapter", title: "Hello", path: "/tmp/hello.md", words: 500, prompt_hash: "deadbeef" },
      decision,
      edits: [{ type: "edited", id: "20260907-hello-abcd", at: "2026-09-07T10:30:00.000Z", words: 520 }],
    });
  });

  test("an unknown id prints \"unknown piece <id>\" to stderr and exits 2", () => {
    const stateHome = tempStateHome();
    const result = runCli(["review", "show", "nope"], stateHome);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown piece nope");
    expect(result.stdout.trim()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// review approve / reject
// ---------------------------------------------------------------------------

describe("pablo review approve", () => {
  test("success prints \"approved <id>\", exits 0, and appends an approved event with by: cli, read: true", () => {
    const stateHome = tempStateHome();
    const path = queuePath(stateHome);
    appendEvent(path, queuedEvent());

    const result = runCli(["review", "approve", "20260907-hello-abcd"], stateHome);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("approved 20260907-hello-abcd");
    const events = readEvents(path);
    const decision = events.find((e): e is DecisionEvent => e.type === "approved");
    expect(decision).toMatchObject({ id: "20260907-hello-abcd", by: "cli", read: true });
  });

  test("--unread records read: false, and --json prints the appended event", () => {
    const stateHome = tempStateHome();
    const path = queuePath(stateHome);
    appendEvent(path, queuedEvent());

    const result = runCli(["review", "approve", "20260907-hello-abcd", "--unread", "--json"], stateHome);

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({ type: "approved", id: "20260907-hello-abcd", by: "cli", read: false });
    const events = readEvents(path);
    expect(events.find((e): e is DecisionEvent => e.type === "approved")).toMatchObject({ read: false });
  });

  test("an unknown piece exits 2 with the detail on stderr, and appends nothing", () => {
    const stateHome = tempStateHome();
    const path = queuePath(stateHome);

    const result = runCli(["review", "approve", "nope"], stateHome);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('no queued piece with id "nope"');
    expect(readEvents(path)).toEqual([]);
  });

  test("an already-decided piece exits 2 with the detail on stderr, and appends no second decision", () => {
    const stateHome = tempStateHome();
    const path = queuePath(stateHome);
    appendEvent(path, queuedEvent());
    appendEvent(path, { type: "approved", id: "20260907-hello-abcd", at: "2026-09-07T11:00:00.000Z", by: "cli", read: true });

    const result = runCli(["review", "approve", "20260907-hello-abcd"], stateHome);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("was already approved");
    expect(readEvents(path).filter((e) => e.type === "approved")).toHaveLength(1);
  });
});

describe("pablo review reject", () => {
  test("success prints \"rejected <id>\", exits 0, and appends a rejected event carrying --reason", () => {
    const stateHome = tempStateHome();
    const path = queuePath(stateHome);
    appendEvent(path, queuedEvent());

    const result = runCli(["review", "reject", "20260907-hello-abcd", "--reason", "voice is off"], stateHome);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("rejected 20260907-hello-abcd");
    const decision = readEvents(path).find((e): e is DecisionEvent => e.type === "rejected");
    expect(decision).toMatchObject({ id: "20260907-hello-abcd", by: "cli", read: true, reason: "voice is off" });
  });

  test("with no --reason, reason is omitted from the appended event", () => {
    const stateHome = tempStateHome();
    const path = queuePath(stateHome);
    appendEvent(path, queuedEvent());

    const result = runCli(["review", "reject", "20260907-hello-abcd"], stateHome);

    expect(result.exitCode).toBe(0);
    const decision = readEvents(path).find((e): e is DecisionEvent => e.type === "rejected");
    expect(decision).toBeDefined();
    expect(decision && "reason" in decision).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// review wait — every case below resolves on the very first poll (a decision
// already on disk, an unknown id, or a --timeout of 0), so none of them ever
// calls the real `setTimeout`-based sleep: see `reviewCore`'s own polling
// test at the bottom of this file for the injectable-`sleep` path.
// ---------------------------------------------------------------------------

describe("pablo review wait", () => {
  test("a piece already approved returns immediately: prints \"approved <id>\", exits 0", () => {
    const stateHome = tempStateHome();
    const path = queuePath(stateHome);
    appendEvent(path, queuedEvent());
    appendEvent(path, { type: "approved", id: "20260907-hello-abcd", at: "2026-09-07T11:00:00.000Z", by: "cli", read: true });

    const result = runCli(["review", "wait", "20260907-hello-abcd"], stateHome);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("approved 20260907-hello-abcd");
  });

  test("a piece already rejected returns immediately: prints \"rejected <id>\", exits 2", () => {
    const stateHome = tempStateHome();
    const path = queuePath(stateHome);
    appendEvent(path, queuedEvent());
    appendEvent(path, { type: "rejected", id: "20260907-hello-abcd", at: "2026-09-07T11:00:00.000Z", by: "cli", read: true });

    const result = runCli(["review", "wait", "20260907-hello-abcd"], stateHome);

    expect(result.exitCode).toBe(2);
    expect(result.stdout.trim()).toBe("rejected 20260907-hello-abcd");
  });

  test("--json prints {id, status, event}", () => {
    const stateHome = tempStateHome();
    const path = queuePath(stateHome);
    appendEvent(path, queuedEvent());
    const decision: DecisionEvent = { type: "approved", id: "20260907-hello-abcd", at: "2026-09-07T11:00:00.000Z", by: "cli", read: true };
    appendEvent(path, decision);

    const result = runCli(["review", "wait", "20260907-hello-abcd", "--json"], stateHome);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ id: "20260907-hello-abcd", status: "approved", event: decision });
  });

  test("an unknown piece exits 2, prints \"unknown piece <id>\" to stderr", () => {
    const stateHome = tempStateHome();

    const result = runCli(["review", "wait", "nope"], stateHome);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown piece nope");
  });

  test("--timeout 0 with no decision yet times out immediately: exits 1, no real sleep", () => {
    const stateHome = tempStateHome();
    appendEvent(queuePath(stateHome), queuedEvent());

    const started = Date.now();
    const result = runCli(["review", "wait", "20260907-hello-abcd", "--timeout", "0"], stateHome);
    const elapsedMs = Date.now() - started;

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("timeout waiting for 20260907-hello-abcd");
    // Generous bound for process spawn overhead — this is not "did it finish
    // fast", it's "did it avoid the default 500ms poll interval entirely".
    expect(elapsedMs).toBeLessThan(3000);
  });
});

// ---------------------------------------------------------------------------
// unknown action
// ---------------------------------------------------------------------------

test("pablo review <unknown action> exits 1 and names the valid actions on stderr", () => {
  const stateHome = tempStateHome();
  const result = runCli(["review", "bogus"], stateHome);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('unknown action "bogus"');
  expect(result.stderr).toContain("list, show, approve, reject, or wait");
});

// ---------------------------------------------------------------------------
// reviewCore's polling path, in-process — AGT-1255's `waitForDecision` takes
// an injectable `sleep`, and `reviewCore` threads it straight through so a
// test can exercise "wait polls, then a decision lands" without ever
// touching the real clock (the CLI subprocess tests above never need this,
// since every case there resolves on the first poll).
// ---------------------------------------------------------------------------

test("reviewCore's wait polls via the injected sleep until a decision appears, never the real clock", async () => {
  const stateHome = tempStateHome();
  const path = queuePath(stateHome);
  appendEvent(path, queuedEvent());

  let sleepCalls = 0;
  const fakeSleep = async (_ms: number): Promise<void> => {
    sleepCalls++;
    // The decision lands "during" the second poll's wait, simulating another
    // process (the tray, the editor) deciding it mid-loop.
    if (sleepCalls === 2) {
      appendEvent(path, { type: "approved", id: "20260907-hello-abcd", at: "2026-09-07T11:00:00.000Z", by: "tray", read: false });
    }
  };

  const outcome = await reviewCore(
    { action: "wait", id: "20260907-hello-abcd", timeoutSeconds: 60 },
    { path, by: "cli", sleep: fakeSleep },
  );

  expect(outcome.exitCode).toBe(0);
  expect(outcome.body).toMatchObject({ status: "approved" });
  expect(sleepCalls).toBeGreaterThanOrEqual(2);
});

// ---------------------------------------------------------------------------
// by: "mcp" — reviewCore's `deps.by` is what verbs.ts's `review` verb sets
// from `VerbContext.caller`; this pins the field reviewCore actually writes,
// independent of the CLI/MCP wiring around it (that wiring is covered by
// verbs.test.ts's "review's args require action" test and mcp.test.ts's
// tool listing).
// ---------------------------------------------------------------------------

test("reviewCore records by: \"mcp\" when told to, distinct from the CLI's by: \"cli\"", async () => {
  const stateHome = tempStateHome();
  const path = queuePath(stateHome);
  appendEvent(path, queuedEvent());

  const outcome = await reviewCore({ action: "approve", id: "20260907-hello-abcd" }, { path, by: "mcp" });

  expect(outcome.exitCode).toBe(0);
  expect(outcome.body).toMatchObject({ by: "mcp" });
});
