import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listenForTrayRequests, parseTrayRequest, readTrayRequest } from "../src/tray/request";
import type { SignalTarget } from "../src/tray/request";
import { tempDir } from "./tray-fakes";

let dir: string;
beforeEach(() => {
  dir = tempDir("pablo-tray-request-");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("parseTrayRequest (a local parcel is a trust boundary)", () => {
  test("accepts exactly an open of the canonical reading-repo ref", () => {
    expect(parseTrayRequest({ action: "open", ref: "OpenThinkAi/valleys-shadow-reading#12" })).toEqual({
      action: "open",
      ref: { repo: "OpenThinkAi/valleys-shadow-reading", pr: 12 },
    });
  });

  test("refuses other actions, other orgs, non-reading repos, traversal and the short form", () => {
    for (const bad of [
      { action: "approve", ref: "OpenThinkAi/a-reading#1" },
      { action: "open", ref: "evil/a-reading#1" },
      { action: "open", ref: "OpenThinkAi/a#1" },
      { action: "open", ref: "OpenThinkAi/../x-reading#1" },
      { action: "open", ref: "a-reading#1" },
      { action: "open", ref: "OpenThinkAi/a-reading#0x1" },
      { action: "open", ref: 7 },
      { action: "open" },
      null,
      "open",
    ]) {
      expect(parseTrayRequest(bad)).toBeUndefined();
    }
  });
});

describe("readTrayRequest / listenForTrayRequests", () => {
  test("reads and deletes the parcel, even a malformed one", () => {
    const path = join(dir, "tray-request.json");
    writeFileSync(path, JSON.stringify({ action: "open", ref: "OpenThinkAi/a-reading#3" }));
    expect(readTrayRequest(path)?.ref.pr).toBe(3);
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, "{nope");
    expect(readTrayRequest(path)).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(readTrayRequest(join(dir, "missing.json"))).toBeUndefined();
  });

  test("the SIGUSR1 handler delivers a request and is removed by the returned stop", () => {
    const handlers = new Set<() => void>();
    const target: SignalTarget = { on: (_s, h) => void handlers.add(h), off: (_s, h) => void handlers.delete(h) };
    const got: number[] = [];
    const path = join(dir, "tray-request.json");
    const stop = listenForTrayRequests({ parcelPath: path, onRequest: (r) => got.push(r.ref.pr), process: target });
    expect(handlers.size).toBe(1);
    writeFileSync(path, JSON.stringify({ action: "open", ref: "OpenThinkAi/a-reading#4" }));
    handlers.forEach((h) => h());
    handlers.forEach((h) => h()); // a second bell with no parcel does nothing
    expect(got).toEqual([4]);
    stop();
    expect(handlers.size).toBe(0);
  });
});
