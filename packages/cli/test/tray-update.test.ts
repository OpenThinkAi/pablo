import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { markReaderActive, readerActive } from "../src/tray/activity";
import {
  BACKOFF_MS,
  CHECK_INTERVAL_MS,
  compareSemver,
  createUpdater,
  decide,
  isGlobalInstall,
  isNewer,
  parseAutoUpdate,
  parseProbe,
  parseSemver,
  readUpdateRecord,
  uiLeafBinaryCandidates,
  updateRecordPath,
  writeUpdateRecord,
} from "../src/tray/update";
import type { CommandResult, LatestAnswer, UpdateEffects, UpdateRecord } from "../src/tray/update";
import { tempDir } from "./tray-fakes";

// AGT-1598: the tray's self-update. Every effect (registry, bun, the version probe, the clock) is a fake:
// nothing here touches npm, bun's real global directory or launchd.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

class Fx {
  record: UpdateRecord = {};
  etagSeen: (string | undefined)[] = [];
  latest: LatestAnswer = { kind: "modified", version: "0.3.0", etag: '"e1"' };
  bunCalls: string[] = [];
  bunFail: Record<string, CommandResult> = {};
  binary = true;
  probe: string | undefined = "0.3.0";
  enabled = true;
  ineligible: string | undefined = undefined;
  ms = Date.parse("2026-10-04T12:00:00Z");
  logs: string[] = [];
  /** Every effect in the order it ran: the order of operations is the safety. */
  order: string[] = [];

  effects(): UpdateEffects {
    return {
      fetchLatest: async (etag) => {
        this.order.push("fetch");
        this.etagSeen.push(etag);
        return etag !== undefined && this.latest.kind === "modified" && this.latest.etag === etag ? { kind: "unchanged" } : this.latest;
      },
      bun: async (args) => {
        const key = args.join(" ");
        this.bunCalls.push(key);
        this.order.push(key);
        return this.bunFail[key] ?? { code: 0, stderr: "" };
      },
      uiLeafBinaryPresent: () => (this.order.push("binary"), this.binary),
      probeVersion: async () => (this.order.push("probe"), this.probe),
      readRecord: () => this.record,
      writeRecord: (r) => {
        this.order.push("record");
        this.record = r;
      },
      autoUpdate: () => this.enabled,
      ineligible: () => this.ineligible,
      now: () => this.ms,
      log: (l) => this.logs.push(l),
    };
  }
}

describe("pure decisions", () => {
  test("only a plain x.y.z is a version", () => {
    expect(parseSemver("0.2.1")).toEqual([0, 2, 1]);
    for (const bad of ["1.0.0-rc.1", "1.0", "v1.0.0", "1.0.0; rm -rf ~", "01.0.0", "", undefined, 3]) expect(parseSemver(bad)).toBeUndefined();
  });

  test("compares numerically, not as text", () => {
    expect(compareSemver([0, 10, 0], [0, 9, 0])).toBeGreaterThan(0);
    expect(isNewer("0.2.10", "0.2.9")).toBe(true);
    expect(isNewer("0.2.1", "0.2.1")).toBe(false);
    expect(isNewer("0.2.0", "0.2.1")).toBe(false);
    expect(isNewer("garbage", "0.2.1")).toBe(false);
  });

  test("decide: up to date, disabled, backoff, defer, upgrade", () => {
    const base = { current: "0.2.1", latest: "0.3.0", record: {} as UpdateRecord, now: 1000, busy: false, enabled: true };
    expect(decide({ ...base, latest: "0.2.1" })).toEqual({ action: "none", reason: "up-to-date" });
    expect(decide({ ...base, latest: undefined })).toEqual({ action: "none", reason: "up-to-date" });
    expect(decide({ ...base, enabled: false })).toEqual({ action: "none", reason: "disabled" });
    expect(decide({ ...base, busy: true })).toEqual({ action: "defer", version: "0.3.0" });
    expect(decide(base)).toEqual({ action: "upgrade", version: "0.3.0" });
    const failed = { version: "0.3.0", until: 2000, reason: "x" };
    expect(decide({ ...base, record: { failed } })).toEqual({ action: "backoff", version: "0.3.0", until: 2000 });
    expect(decide({ ...base, record: { failed }, now: 2000 })).toEqual({ action: "upgrade", version: "0.3.0" });
    // a failure of one version says nothing about the next
    expect(decide({ ...base, latest: "0.3.1", record: { failed } })).toEqual({ action: "upgrade", version: "0.3.1" });
  });

  test("the config opt-out is only a literal tray.autoUpdate: false", () => {
    expect(parseAutoUpdate(undefined)).toBe(true);
    expect(parseAutoUpdate("{}")).toBe(true);
    expect(parseAutoUpdate("not json")).toBe(true);
    expect(parseAutoUpdate('{"tray":{"autoUpdate":true}}')).toBe(true);
    expect(parseAutoUpdate('{"tray":{"autoUpdate":"no"}}')).toBe(true);
    expect(parseAutoUpdate('{"tray":{"autoUpdate":false}}')).toBe(false);
  });

  test("small parsers", () => {
    expect(parseProbe('{"version":"0.3.0"}')).toBe("0.3.0");
    expect(parseProbe("pablo 0.3.0")).toBeUndefined();
    expect(isGlobalInstall("/Users/a/.bun/install/global/node_modules/@openthink/pablo/src/cli.ts")).toBe(true);
    expect(isGlobalInstall("/Users/a/Development/pablo/packages/cli/src/cli.ts")).toBe(false);
    expect(uiLeafBinaryCandidates({ BUN_INSTALL: "/b" })[0]).toBe("/b/install/global/node_modules/@openthink/ui-leaf/bin/ui-leaf-bin");
  });
});

describe("the updater", () => {
  test("no update: the registry names the running version; nothing is installed", async () => {
    const fx = new Fx();
    fx.latest = { kind: "modified", version: "0.2.1", etag: '"e1"' };
    const out = await createUpdater(fx.effects(), "0.2.1").tick({ check: true, busy: false });
    expect(out).toEqual({ kind: "idle" });
    expect(fx.bunCalls).toEqual([]);
    expect(fx.record.latest).toBe("0.2.1");
  });

  test("update applied: add, trust, binary, probe, record, in that order; then it asks for the restart", async () => {
    const fx = new Fx();
    const updater = createUpdater(fx.effects(), "0.2.1");
    const out = await updater.tick({ check: true, busy: false });
    expect(out).toEqual({ kind: "upgraded", version: "0.3.0" });
    expect(fx.order.filter((s) => s !== "record")).toEqual([
      "fetch",
      "add -g @openthink/pablo@0.3.0",
      "pm -g trust @openthink/ui-leaf",
      "binary",
      "probe",
    ]);
    expect(fx.order.at(-1)).toBe("record"); // the update is recorded last, right before the caller exits
    expect(fx.record.updated).toMatchObject({ from: "0.2.1", to: "0.3.0" });
    expect(fx.record.failed).toBeUndefined();
  });

  test("the menu's 'Updated to' holds only while the updated version is the one running", async () => {
    const fx = new Fx();
    await createUpdater(fx.effects(), "0.2.1").tick({ check: true, busy: false });
    expect(createUpdater(fx.effects(), "0.3.0").updatedTo()).toBe("0.3.0"); // the restarted tray
    expect(createUpdater(fx.effects(), "0.3.1").updatedTo()).toBeUndefined(); // a later install by hand
    expect(createUpdater(fx.effects(), "0.2.1").updatedTo()).toBeUndefined();
  });

  test("deferred while a window is open: nothing touched, and it goes ahead the moment the window closes, without asking the registry again", async () => {
    const fx = new Fx();
    const updater = createUpdater(fx.effects(), "0.2.1");
    expect(await updater.tick({ check: true, busy: true })).toEqual({ kind: "deferred", version: "0.3.0" });
    expect(fx.bunCalls).toEqual([]);
    expect(await updater.tick({ check: false, busy: true })).toEqual({ kind: "deferred", version: "0.3.0" });
    expect(fx.bunCalls).toEqual([]);
    expect(await updater.tick({ check: false, busy: false })).toEqual({ kind: "upgraded", version: "0.3.0" });
    expect(fx.order.filter((s) => s === "fetch")).toHaveLength(1);
  });

  test("a failed probe puts the previous version back, records the failure and backs off", async () => {
    const fx = new Fx();
    fx.probe = "0.2.9"; // the new install does not say it is 0.3.0
    const updater = createUpdater(fx.effects(), "0.2.1");
    const out = await updater.tick({ check: true, busy: false });
    expect(out.kind).toBe("rolled-back");
    expect(fx.bunCalls).toEqual([
      "add -g @openthink/pablo@0.3.0",
      "pm -g trust @openthink/ui-leaf",
      "add -g @openthink/pablo@0.2.1", // the rollback
      "pm -g trust @openthink/ui-leaf",
    ]);
    expect(fx.record.failed).toMatchObject({ version: "0.3.0", until: fx.ms + BACKOFF_MS });
    expect(fx.record.updated).toBeUndefined();
    // no retry of that version for 24h, even with a due check or a quiet moment
    fx.bunCalls.length = 0;
    expect(await updater.tick({ check: true, busy: false })).toEqual({ kind: "backoff", version: "0.3.0" });
    fx.ms += BACKOFF_MS - 1;
    expect(await updater.tick({ check: false, busy: false })).toEqual({ kind: "backoff", version: "0.3.0" });
    expect(fx.bunCalls).toEqual([]);
    fx.ms += 1;
    fx.probe = "0.3.0";
    expect(await updater.tick({ check: false, busy: false })).toEqual({ kind: "upgraded", version: "0.3.0" });
  });

  test("every failing step rolls back: bun add, a missing ui-leaf binary, a probe that throws", async () => {
    for (const [name, arrange] of [
      ["bun add", (fx: Fx) => (fx.bunFail["add -g @openthink/pablo@0.3.0"] = { code: 1, stderr: "no network" })],
      ["binary", (fx: Fx) => (fx.binary = false)],
      ["probe", (fx: Fx) => (fx.probe = undefined)],
    ] as const) {
      const fx = new Fx();
      arrange(fx);
      const out = await createUpdater(fx.effects(), "0.2.1").tick({ check: true, busy: false });
      expect(out.kind).toBe("rolled-back");
      expect(fx.bunCalls).toContain("add -g @openthink/pablo@0.2.1");
      expect(fx.record.failed?.version).toBe("0.3.0");
      expect(fx.logs.join("\n")).toContain("failed");
      void name;
    }
  });

  test("a failing rollback is logged and does not throw: the tray keeps running", async () => {
    const fx = new Fx();
    fx.probe = undefined;
    fx.bunFail["add -g @openthink/pablo@0.2.1"] = { code: 1, stderr: "offline" };
    const out = await createUpdater(fx.effects(), "0.2.1").tick({ check: true, busy: false });
    expect(out.kind).toBe("rolled-back");
    expect(fx.logs.join("\n")).toContain("could not reinstall 0.2.1");
  });

  test("a 304 costs nothing: the stored etag is sent, the stored version is reused, no install", async () => {
    const fx = new Fx();
    fx.latest = { kind: "modified", version: "0.2.1", etag: '"e1"' };
    const updater = createUpdater(fx.effects(), "0.2.1");
    await updater.tick({ check: true, busy: false });
    expect(await updater.tick({ check: true, busy: false })).toEqual({ kind: "idle" });
    expect(fx.etagSeen).toEqual([undefined, '"e1"']);
    expect(fx.bunCalls).toEqual([]);
    expect(fx.record.etag).toBe('"e1"');
    expect(fx.record.latest).toBe("0.2.1");
  });

  test("an etag with no version beside it is not sent (a 304 would then hide the version)", async () => {
    const fx = new Fx();
    fx.record = { etag: '"stale"' };
    await createUpdater(fx.effects(), "0.2.1").tick({ check: true, busy: true });
    expect(fx.etagSeen).toEqual([undefined]);
  });

  test("opt-out and ineligible do nothing, not even ask the registry", async () => {
    const fx = new Fx();
    fx.enabled = false;
    expect(await createUpdater(fx.effects(), "0.2.1").tick({ check: true, busy: false })).toEqual({ kind: "disabled" });
    fx.enabled = true;
    fx.ineligible = "not under launchd";
    expect(await createUpdater(fx.effects(), "0.2.1").tick({ check: true, busy: false })).toEqual({ kind: "ineligible", reason: "not under launchd" });
    expect(fx.order).toEqual([]);
  });

  test("a registry error or a hostile version string installs nothing", async () => {
    const fx = new Fx();
    fx.latest = { kind: "error", reason: "offline" };
    expect(await createUpdater(fx.effects(), "0.2.1").tick({ check: true, busy: false })).toEqual({ kind: "check-failed", reason: "offline" });
    fx.latest = { kind: "modified", version: "9.9.9 --registry=http://evil", etag: undefined };
    expect((await createUpdater(fx.effects(), "0.2.1").tick({ check: true, busy: false })).kind).toBe("check-failed");
    expect(fx.bunCalls).toEqual([]);
  });

  test("between checks with nothing known, a tick is idle and asks nothing", async () => {
    const fx = new Fx();
    expect(await createUpdater(fx.effects(), "0.2.1").tick({ check: false, busy: false })).toEqual({ kind: "idle" });
    expect(fx.order).toEqual([]);
    expect(CHECK_INTERVAL_MS).toBe(6 * 3_600_000);
  });
});

describe("files", () => {
  test("the record round-trips and a damaged file reads as empty", () => {
    const dir = tempDir("pablo-update-");
    dirs.push(dir);
    const path = updateRecordPath(join(dir, "tray"));
    expect(readUpdateRecord(path)).toEqual({});
    writeUpdateRecord(path, { latest: "0.3.0", etag: '"x"' });
    expect(readUpdateRecord(path)).toEqual({ latest: "0.3.0", etag: '"x"' });
    writeFileSync(path, "{nope");
    expect(readUpdateRecord(path)).toEqual({});
  });

  test("reader activity: a live marker is busy, a released one is not, a dead pid's is swept", () => {
    const dir = tempDir("pablo-activity-");
    dirs.push(dir);
    const env = { XDG_STATE_HOME: dir };
    expect(readerActive(env)).toBe(false);
    const release = markReaderActive(env);
    expect(readerActive(env)).toBe(true);
    release();
    expect(readerActive(env)).toBe(false);
    const stale = join(dir, "pablo", "tray", "active");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "999999-1"), "");
    expect(readerActive(env, () => false)).toBe(false);
    expect(readerActive(env, () => true)).toBe(false); // it was swept above
  });
});
