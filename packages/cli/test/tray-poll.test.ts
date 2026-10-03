import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cachedRoundDir } from "../src/read";
import {
  askRounds,
  DEFAULT_INTERVAL_MS,
  FULL_REFRESH_MS,
  MAX_BACKOFF_MS,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  nextDelayMs,
  parseHttpResponse,
  pollIntervalMs,
  RoundPoller,
} from "../src/tray/poll";
import { FakeGitHub, tempDir } from "./tray-fakes";

// AGT-1589: the poller against a fake GitHub. No network, no real `gh`.

let state: string;
let env: Record<string, string>;
beforeEach(() => {
  state = tempDir("pablo-tray-poll-");
  env = { XDG_STATE_HOME: state, HOME: state };
});
afterEach(() => rmSync(state, { recursive: true, force: true }));

describe("intervals", () => {
  test("the interval is clamped to 30-60s and defaults to the middle", () => {
    expect(pollIntervalMs({})).toBe(DEFAULT_INTERVAL_MS);
    expect(pollIntervalMs({ PABLO_TRAY_POLL_SECONDS: "5" })).toBe(MIN_INTERVAL_MS);
    expect(pollIntervalMs({ PABLO_TRAY_POLL_SECONDS: "600" })).toBe(MAX_INTERVAL_MS);
    expect(pollIntervalMs({ PABLO_TRAY_POLL_SECONDS: "40" })).toBe(40_000);
    expect(pollIntervalMs({ PABLO_TRAY_POLL_SECONDS: "soon" })).toBe(DEFAULT_INTERVAL_MS);
    expect(DEFAULT_INTERVAL_MS).toBeGreaterThanOrEqual(30_000);
    expect(DEFAULT_INTERVAL_MS).toBeLessThanOrEqual(60_000);
  });

  test("backoff doubles per consecutive failure, is bounded, and a success returns to the interval", () => {
    expect(nextDelayMs(0, 45_000)).toBe(45_000);
    expect(nextDelayMs(1, 45_000)).toBe(90_000);
    expect(nextDelayMs(2, 45_000)).toBe(180_000);
    expect(nextDelayMs(50, 45_000)).toBe(MAX_BACKOFF_MS);
    expect(nextDelayMs(1_000_000, 60_000)).toBe(MAX_BACKOFF_MS);
  });
});

describe("parseHttpResponse / askRounds", () => {
  test("parses the status, lower-cased headers and body of `gh api -i`", () => {
    const parsed = parseHttpResponse('HTTP/2.0 200 OK\r\nEtag: W/"abc"\r\nX-Other: 1\r\n\r\n{"items":[]}');
    expect(parsed?.status).toBe(200);
    expect(parsed?.headers.get("etag")).toBe('W/"abc"');
    expect(parsed?.body).toBe('{"items":[]}');
    expect(parseHttpResponse("gh: nothing")).toBeUndefined();
  });

  test("the first ask is unconditional; the next carries If-None-Match and a 304 reads as unchanged", () => {
    const gh = new FakeGitHub();
    gh.setRounds([{ pr: 1 }]);
    const first = askRounds(gh.run, undefined);
    expect(first).toEqual({ kind: "modified", etag: gh.etag });
    expect(gh.conditionalCalls[0]?.ifNoneMatch).toBeUndefined();
    const second = askRounds(gh.run, gh.etag);
    expect(second).toEqual({ kind: "unchanged" });
    expect(gh.conditionalCalls[1]?.ifNoneMatch).toBe(gh.etag);
  });

  test("an outage, a missing gh and a rate limit are errors, not changes", () => {
    const gh = new FakeGitHub();
    gh.down = true;
    expect(askRounds(gh.run, undefined).kind).toBe("error");
    expect(askRounds(() => ({ code: 127, stdout: "", stderr: "gh: command not found" }), undefined)).toEqual({ kind: "error", reason: "gh: command not found" });
    expect(askRounds(() => ({ code: 1, stdout: "HTTP/2.0 403 Forbidden\r\n\r\n{}", stderr: "" }), "x")).toEqual({ kind: "error", reason: "GitHub answered 403" });
  });
});

describe("RoundPoller", () => {
  test("a 304 reuses the list without asking for it again", () => {
    const gh = new FakeGitHub();
    gh.setRounds([{ pr: 1, sender: "matt" }]);
    const poller = new RoundPoller({ run: gh.run, env });
    const first = poller.tick();
    expect(first.ok && first.source).toBe("github");
    const listingsAfterFirst = gh.fullListings;
    const second = poller.tick();
    expect(second.ok && second.source).toBe("not-modified");
    expect(second.ok && second.rounds.map((r) => r.ref)).toEqual(["OpenThinkAi/alpha-reading#1"]);
    expect(gh.fullListings).toBe(listingsAfterFirst);
    expect(gh.conditionalCalls.map((c) => c.outcome)).toEqual(["200", "304"]);
  });

  test("a changed answer re-lists; the new etag is used next", () => {
    const gh = new FakeGitHub();
    gh.setRounds([{ pr: 1 }]);
    const poller = new RoundPoller({ run: gh.run, env });
    poller.tick();
    gh.setRounds([{ pr: 1 }, { pr: 2 }]);
    const changed = poller.tick();
    expect(changed.ok && changed.rounds.length).toBe(2);
    expect(gh.conditionalCalls.map((c) => c.outcome)).toEqual(["200", "200"]);
    poller.tick();
    expect(gh.conditionalCalls[2]?.outcome).toBe("304");
  });

  test("an etag is only kept once the list was read, so a failed listing cannot hide the change", () => {
    const gh = new FakeGitHub();
    gh.setRounds([{ pr: 1 }]);
    let failListing = true;
    const run: typeof gh.run = (command, args) => (failListing && !args.includes("-i") && args.includes("search/issues") ? { code: 1, stdout: "", stderr: "boom" } : gh.run(command, args));
    const poller = new RoundPoller({ run, env });
    expect(poller.tick().ok).toBe(false);
    failListing = false;
    const next = poller.tick();
    expect(next.ok && next.source).toBe("github"); // not a 304: the etag was never kept
    expect(next.ok && next.rounds.length).toBe(1);
  });

  test("an unchanged answer still re-reads the whole list every FULL_REFRESH_MS", () => {
    const gh = new FakeGitHub();
    gh.setRounds([{ pr: 1 }]);
    let now = 1_000_000;
    const poller = new RoundPoller({ run: gh.run, env, now: () => now });
    poller.tick();
    now += FULL_REFRESH_MS - 1;
    expect((poller.tick() as { source: string }).source).toBe("not-modified");
    now += 2;
    expect((poller.tick() as { source: string }).source).toBe("github");
  });

  test("a submit made on this machine shows as sent on a 304 tick, before GitHub changes", () => {
    const gh = new FakeGitHub();
    gh.setRounds([{ pr: 7 }]);
    const poller = new RoundPoller({ run: gh.run, env });
    const first = poller.tick();
    expect(first.ok && first.rounds[0]?.status).toBe("waiting");
    const ref = { repo: "OpenThinkAi/alpha-reading", pr: 7 };
    const dir = cachedRoundDir(ref, env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "round.json"), JSON.stringify({ id: "atara-2026-10-02", repo: ref.repo, pr: 7 }));
    writeFileSync(join(dir, "atara-2026-10-02.sent.json"), JSON.stringify({ id: "atara-2026-10-02", repo: ref.repo, pr: 7, commit: "a".repeat(40), reviewId: 1, reviewUrl: "u", sentAt: "t" }));
    const second = poller.tick();
    expect(second.ok && second.source).toBe("not-modified");
    expect(second.ok && second.rounds[0]?.status).toBe("sent");
  });

  test("never throws: a runner that throws is a failed tick", () => {
    const poller = new RoundPoller({
      run: () => {
        throw new Error("spawn failed");
      },
      env,
    });
    expect(poller.tick()).toEqual({ ok: false, reason: "spawn failed" });
  });
});
