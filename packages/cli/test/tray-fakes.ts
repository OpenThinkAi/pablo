// Shared fakes for the tray suites (AGT-1589): a fake GitHub behind the injected
// `Runner`, a fake clock, and a notifier that records instead of raising a banner.
// Nothing here reaches the network, a real notification, launchd or a window.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Notifier, RoundEvent } from "../src/tray/notify";
import type { Runner, RunResult } from "../src/share";

export interface FakeRound {
  readonly pr: number;
  readonly slug?: string;
  readonly title?: string;
  readonly sender?: string;
}

export interface GhCall {
  readonly args: readonly string[];
  /** The `-i` conditional search the poller uses as its cheap question. */
  readonly conditional: boolean;
  readonly ifNoneMatch: string | undefined;
  readonly outcome: string;
}

/** A fake GitHub: open rounds for the reader, a changing ETag, and an outage switch. */
export class FakeGitHub {
  rounds: FakeRound[] = [];
  down = false;
  etagVersion = 1;
  readonly calls: GhCall[] = [];

  setRounds(rounds: FakeRound[]): void {
    this.rounds = rounds;
    this.etagVersion += 1;
  }

  get etag(): string {
    return `"v${this.etagVersion}"`;
  }

  private repo(round: FakeRound): string {
    return `OpenThinkAi/${round.slug ?? "alpha"}-reading`;
  }

  private searchBody(): string {
    return JSON.stringify({
      items: this.rounds.map((round) => ({
        number: round.pr,
        title: round.title ?? `Round ${round.pr}`,
        html_url: `https://github.com/${this.repo(round)}/pull/${round.pr}`,
        repository_url: `https://api.github.com/repos/${this.repo(round)}`,
        created_at: `2026-10-0${round.pr % 9 || 1}T10:00:00Z`,
        user: { login: round.sender ?? "matt" },
      })),
    });
  }

  readonly run: Runner = (command, args): RunResult => {
    const conditional = args.includes("-i");
    const header = args.indexOf("-H");
    const ifNoneMatch = header >= 0 ? args[header + 1]?.replace(/^If-None-Match: /, "") : undefined;
    const record = (outcome: string): void => {
      this.calls.push({ args, conditional, ifNoneMatch, outcome });
    };
    if (this.down) {
      record("down");
      return { code: 1, stdout: "", stderr: "dial tcp: network is unreachable" };
    }
    if (command !== "gh") {
      record("not gh");
      return { code: 1, stdout: "", stderr: "unexpected command" };
    }
    const endpoint = args.find((a) => a === "search/issues" || a.startsWith("repos/")) ?? "";
    if (endpoint === "search/issues") {
      if (conditional) {
        if (ifNoneMatch === this.etag) {
          record("304");
          // gh prints the headers of a 304 and exits non-zero.
          return { code: 1, stdout: `HTTP/2.0 304 Not Modified\r\nEtag: ${this.etag}\r\n\r\n`, stderr: "gh: HTTP 304" };
        }
        record("200");
        return { code: 0, stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\nEtag: ${this.etag}\r\n\r\n${this.searchBody()}`, stderr: "" };
      }
      record("search");
      return { code: 0, stdout: this.searchBody(), stderr: "" };
    }
    const files = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/files$/.exec(endpoint);
    if (files) {
      record("files");
      return { code: 0, stdout: JSON.stringify([{ filename: "novels/valley/chapters/03-the-pass.md" }]), stderr: "" };
    }
    const pull = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(endpoint);
    if (pull) {
      record("pull");
      const found = this.rounds.find((r) => this.repo(r) === pull[1] && r.pr === Number(pull[2]));
      return { code: 0, stdout: JSON.stringify({ state: found ? "open" : "closed", title: found?.title ?? "gone", html_url: "https://github.com/x/y/pull/1", user: { login: "matt" }, created_at: "2026-10-01T10:00:00Z" }), stderr: "" };
    }
    record("unknown");
    return { code: 1, stdout: "", stderr: `no fake for ${endpoint}` };
  };

  /** How many full (non-conditional) searches ran. */
  get fullListings(): number {
    return this.calls.filter((c) => c.outcome === "search").length;
  }

  get conditionalCalls(): GhCall[] {
    return this.calls.filter((c) => c.conditional);
  }
}

export class RecordingNotifier implements Notifier {
  readonly events: RoundEvent[] = [];
  failNext = 0;
  async notify(event: RoundEvent): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("osascript exited 1");
    }
    this.events.push(event);
  }
}

/** A fake clock: `sleep` advances it instead of waiting. */
export class FakeClock {
  ms = Date.parse("2026-10-02T12:00:00Z");
  readonly sleeps: number[] = [];
  now = (): Date => new Date(this.ms);
  advance(ms: number): void {
    this.ms += ms;
  }
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
