import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenForTrayRequests, readTrayRequest } from "../src/tray/request";
import type { SignalTarget, TrayRequest } from "../src/tray/request";

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function useTempDir(): string {
  dir = mkdtempSync(join(tmpdir(), "pablo-tray-request-"));
  return dir;
}

function parcelPath(base: string): string {
  return join(base, "tray-request.json");
}

/** A fake `process` so no suite ever installs a real, process-wide SIGUSR1
 * handler — it just remembers the single handler it was given. */
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

describe("readTrayRequest", () => {
  test("returns the parsed request and deletes the parcel", () => {
    const base = useTempDir();
    const path = parcelPath(base);
    writeFileSync(path, JSON.stringify({ action: "approve", id: "abc" }), "utf8");

    const request = readTrayRequest(path);

    expect(request).toEqual({ action: "approve", id: "abc" });
    expect(existsSync(path)).toBe(false);
  });

  test("a missing parcel returns undefined", () => {
    const base = useTempDir();
    expect(readTrayRequest(parcelPath(base))).toBeUndefined();
  });

  test("a malformed parcel returns undefined and is still deleted", () => {
    const base = useTempDir();
    const path = parcelPath(base);
    writeFileSync(path, "not json", "utf8");

    const request = readTrayRequest(path);

    expect(request).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  test("well-formed JSON with the wrong shape returns undefined and is still deleted", () => {
    const base = useTempDir();
    const path = parcelPath(base);
    writeFileSync(path, JSON.stringify({ action: "delete-everything", id: "abc" }), "utf8");

    const request = readTrayRequest(path);

    expect(request).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });
});

describe("listenForTrayRequests", () => {
  test("fires onRequest with the parcel when the signal arrives", () => {
    const base = useTempDir();
    const path = parcelPath(base);
    const target = fakeSignalTarget();
    const received: TrayRequest[] = [];

    const stop = listenForTrayRequests({
      parcelPath: path,
      onRequest: (request) => received.push(request),
      process: target,
    });

    writeFileSync(path, JSON.stringify({ action: "review", id: "xyz" }), "utf8");
    target.fire();

    expect(received).toEqual([{ action: "review", id: "xyz" }]);
    expect(existsSync(path)).toBe(false);

    stop();
  });

  test("a malformed parcel yields no call and is still gone", () => {
    const base = useTempDir();
    const path = parcelPath(base);
    const target = fakeSignalTarget();
    const received: TrayRequest[] = [];

    const stop = listenForTrayRequests({
      parcelPath: path,
      onRequest: (request) => received.push(request),
      process: target,
    });

    writeFileSync(path, "not json", "utf8");
    target.fire();

    expect(received).toEqual([]);
    expect(existsSync(path)).toBe(false);

    stop();
  });

  test("a signal with no parcel waiting yields no call", () => {
    const base = useTempDir();
    const path = parcelPath(base);
    const target = fakeSignalTarget();
    const received: TrayRequest[] = [];

    const stop = listenForTrayRequests({
      parcelPath: path,
      onRequest: (request) => received.push(request),
      process: target,
    });

    target.fire();

    expect(received).toEqual([]);
    stop();
  });

  test("the returned function removes the handler", () => {
    const target = fakeSignalTarget();

    const stop = listenForTrayRequests({
      parcelPath: join(useTempDir(), "tray-request.json"),
      onRequest: () => {},
      process: target,
    });

    expect(target.handlerCount()).toBe(1);
    stop();
    expect(target.handlerCount()).toBe(0);
  });
});
