/**
 * The tray's self-update (AGT-1598): a reader who installed pablo once never runs the installer again.
 * Same discipline as insieme's `src/update.ts`: pure decisions, injected effects, and the ORDER of the
 * operations is the safety.
 *
 *   1. ask the registry for `latest`, conditionally (an unchanged ETag, a 304, costs nothing)
 *   2. is it a newer plain `x.y.z` than the running pablo, not backed off, auto-update on?
 *   3. is a reader window open or a submit in flight?  then wait; nothing is touched
 *   4. `bun add -g @openthink/pablo@<v>`
 *   5. `bun pm -g trust @openthink/ui-leaf`    (bun skips install scripts; ui-leaf's downloads the window program)
 *   6. the ui-leaf binary exists on disk
 *   7. the NEWLY INSTALLED pablo, run as a fresh process, prints `<v>` for `--version`
 *   8. record "updated to <v>" on disk, then exit 0: the launchd agent has `KeepAlive` true (launchd.ts), so
 *      launchd starts the tray again on the new code
 *
 * Any failing step 4-7 reinstalls the version that was running (`bun add -g @openthink/pablo@<old>`),
 * records the failure and refuses that version for 24 hours. The running process never stops serving
 * through a failure: until step 8 nothing it has loaded has changed (it is already in memory), and the exit
 * only happens after the new code has proven itself.
 *
 * The version string reaches a command line, so only a strict `x.y.z` ever does (`parseSemver`): the
 * registry's answer is data, never a command.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const PABLO_PACKAGE = "@openthink/pablo";
export const UILEAF_PACKAGE = "@openthink/ui-leaf";
export const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PABLO_PACKAGE}/latest`;

/** On start and then every six hours. */
export const CHECK_INTERVAL_MS = 6 * 3_600_000;
/** After a registry error (offline at login, say) ask again sooner than six hours. */
export const CHECK_RETRY_MS = 15 * 60_000;
/** A version that failed is not tried again for a day. */
export const BACKOFF_MS = 24 * 3_600_000;

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

export type Semver = readonly [number, number, number];

/** A plain `x.y.z` only. A pre-release, a build tag or anything else is not a version we install. */
export function parseSemver(text: unknown): Semver | undefined {
  if (typeof text !== "string") return undefined;
  const match = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.exec(text);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative when `a` is older than `b`. */
export function compareSemver(a: Semver, b: Semver): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function isNewer(candidate: string, current: string): boolean {
  const c = parseSemver(candidate);
  const r = parseSemver(current);
  return c !== undefined && r !== undefined && compareSemver(c, r) > 0;
}

export interface UpdateRecord {
  /** The registry's ETag for `latest`, so the next ask can be a 304. */
  etag?: string;
  /** The version `latest` named when the etag was taken. */
  latest?: string;
  checkedAt?: string;
  /** A version that failed, and until when it is not tried again. */
  failed?: { version: string; until: number; reason: string };
  /** The last applied update; the menu says "Updated to <v>" while it is still the running version. */
  updated?: { from: string; to: string; at: string };
}

export type Decision =
  | { readonly action: "none"; readonly reason: "up-to-date" | "disabled" }
  | { readonly action: "backoff"; readonly version: string; readonly until: number }
  | { readonly action: "defer"; readonly version: string }
  | { readonly action: "upgrade"; readonly version: string };

/** What to do about the newest known version. Pure: nothing here reads a clock or a disk. */
export function decide(input: { current: string; latest: string | undefined; record: UpdateRecord; now: number; busy: boolean; enabled: boolean }): Decision {
  const { current, latest, record, now, busy, enabled } = input;
  if (!enabled) return { action: "none", reason: "disabled" };
  if (latest === undefined || !isNewer(latest, current)) return { action: "none", reason: "up-to-date" };
  if (record.failed !== undefined && record.failed.version === latest && now < record.failed.until) {
    return { action: "backoff", version: latest, until: record.failed.until };
  }
  if (busy) return { action: "defer", version: latest };
  return { action: "upgrade", version: latest };
}

// ---------------------------------------------------------------------------
// Effects (all injected)
// ---------------------------------------------------------------------------

export type LatestAnswer =
  | { readonly kind: "modified"; readonly version: unknown; readonly etag: string | undefined }
  | { readonly kind: "unchanged" }
  | { readonly kind: "error"; readonly reason: string };

export interface CommandResult {
  readonly code: number;
  readonly stderr: string;
}

export interface UpdateEffects {
  /** One conditional GET of the registry's `latest`. */
  readonly fetchLatest: (etag: string | undefined) => Promise<LatestAnswer>;
  /** `bun <args>`; never throws for a non-zero exit. */
  readonly bun: (args: readonly string[]) => Promise<CommandResult>;
  /** Whether the ui-leaf binary is on disk. */
  readonly uiLeafBinaryPresent: () => boolean;
  /** The version the newly installed pablo prints for `--version`, run as a fresh process; undefined when it cannot. */
  readonly probeVersion: () => Promise<string | undefined>;
  readonly readRecord: () => UpdateRecord;
  readonly writeRecord: (record: UpdateRecord) => void;
  /** `tray.autoUpdate` in the config; read at each decision, so a change needs no restart. */
  readonly autoUpdate: () => boolean;
  /** A reason this tray must not replace its own code (not under launchd, not the global install), or undefined. */
  readonly ineligible: () => string | undefined;
  readonly now: () => number;
  readonly log: (line: string) => void;
}

export type UpdateOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "disabled" }
  | { readonly kind: "ineligible"; readonly reason: string }
  | { readonly kind: "check-failed"; readonly reason: string }
  | { readonly kind: "backoff"; readonly version: string }
  | { readonly kind: "deferred"; readonly version: string }
  | { readonly kind: "rolled-back"; readonly version: string; readonly reason: string }
  /** Installed, verified and recorded: the caller must now stop and exit 0 so launchd restarts the tray. */
  | { readonly kind: "upgraded"; readonly version: string };

export interface Updater {
  /** `check`: whether the six-hour check is due. Between checks a known newer version is still acted on (no network). */
  tick(options: { check: boolean; busy: boolean }): Promise<UpdateOutcome>;
  /** The version a past update moved this tray to, while it is still the running one. */
  updatedTo(): string | undefined;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createUpdater(fx: UpdateEffects, current: string): Updater {
  let record: UpdateRecord = fx.readRecord();
  const save = (next: UpdateRecord): void => {
    record = next;
    try {
      fx.writeRecord(record);
    } catch (error) {
      fx.log(`could not record the update state: ${reasonOf(error)}`);
    }
  };

  async function refreshLatest(): Promise<string | undefined | { error: string }> {
    // An etag is only worth sending alongside the version it named.
    const etag = record.latest === undefined ? undefined : record.etag;
    const answer = await fx.fetchLatest(etag).catch((error: unknown): LatestAnswer => ({ kind: "error", reason: reasonOf(error) }));
    if (answer.kind === "error") return { error: answer.reason };
    if (answer.kind === "unchanged") {
      save({ ...record, checkedAt: new Date(fx.now()).toISOString() });
      return record.latest;
    }
    const version = parseSemver(answer.version) === undefined ? undefined : (answer.version as string);
    if (version === undefined) return { error: "the registry's answer had no plain x.y.z version" };
    const { etag: _drop, ...rest } = record;
    save({ ...rest, ...(answer.etag === undefined ? {} : { etag: answer.etag }), latest: version, checkedAt: new Date(fx.now()).toISOString() });
    return version;
  }

  async function fail(version: string, reason: string): Promise<UpdateOutcome> {
    fx.log(`update to ${version} failed (${reason}); putting ${current} back`);
    save({ ...record, failed: { version, until: fx.now() + BACKOFF_MS, reason } });
    // The previous version back, then its window component's setup: best effort, the tray keeps running either way.
    try {
      const back = await fx.bun(["add", "-g", `${PABLO_PACKAGE}@${current}`]);
      if (back.code !== 0) fx.log(`could not reinstall ${current}: ${back.stderr.trim()}`);
      await fx.bun(["pm", "-g", "trust", UILEAF_PACKAGE]);
    } catch (error) {
      fx.log(`could not reinstall ${current}: ${reasonOf(error)}`);
    }
    return { kind: "rolled-back", version, reason };
  }

  async function apply(version: string): Promise<UpdateOutcome> {
    fx.log(`updating pablo ${current} -> ${version}`);
    try {
      const added = await fx.bun(["add", "-g", `${PABLO_PACKAGE}@${version}`]);
      if (added.code !== 0) return await fail(version, `bun add failed: ${added.stderr.trim()}`);
      // Bun skips install scripts; this one downloads the chapter window's program. Already trusted is fine:
      // whether the binary really arrived is the next check.
      await fx.bun(["pm", "-g", "trust", UILEAF_PACKAGE]);
      if (!fx.uiLeafBinaryPresent()) return await fail(version, "the chapter-window program (ui-leaf) did not download");
      const probed = await fx.probeVersion();
      if (probed !== version) return await fail(version, `the new pablo reported ${probed === undefined ? "nothing" : probed}, not ${version}`);
    } catch (error) {
      return await fail(version, reasonOf(error));
    }
    const { failed: _failed, ...rest } = record;
    save({ ...rest, updated: { from: current, to: version, at: new Date(fx.now()).toISOString() } });
    fx.log(`pablo ${version} is installed and verified; restarting the tray on it`);
    return { kind: "upgraded", version };
  }

  return {
    updatedTo: () => (record.updated?.to === current ? current : undefined),
    async tick({ check, busy }) {
      if (!fx.autoUpdate()) return { kind: "disabled" };
      // A known newer version needs no network to act on; otherwise there is nothing to do between checks.
      const known = record.latest !== undefined && isNewer(record.latest, current) ? record.latest : undefined;
      if (!check && known === undefined) return { kind: "idle" };
      const why = fx.ineligible();
      if (why !== undefined) return { kind: "ineligible", reason: why };

      let latest = known;
      if (check) {
        const fresh = await refreshLatest();
        if (typeof fresh === "object") {
          fx.log(`update check failed: ${fresh.error}`);
          return { kind: "check-failed", reason: fresh.error };
        }
        latest = fresh;
      }
      const decision = decide({ current, latest, record, now: fx.now(), busy, enabled: true });
      switch (decision.action) {
        case "none":
          return { kind: "idle" };
        case "backoff":
          return { kind: "backoff", version: decision.version };
        case "defer":
          return { kind: "deferred", version: decision.version };
        case "upgrade":
          return await apply(decision.version);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Real pieces (not built by any test, except the pure ones below)
// ---------------------------------------------------------------------------

export const updateRecordPath = (trayDirectory: string): string => join(trayDirectory, "update-state.json");

export function readUpdateRecord(path: string): UpdateRecord {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as UpdateRecord) : {};
  } catch {
    return {};
  }
}

export function writeUpdateRecord(path: string, record: UpdateRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record), "utf8");
  renameSync(tmp, path);
}

/** `tray.autoUpdate` from the config text: false only when it is literally `false`; anything unreadable means on. */
export function parseAutoUpdate(configText: string | undefined): boolean {
  if (configText === undefined) return true;
  try {
    const raw: unknown = JSON.parse(configText);
    const tray = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>)["tray"] : undefined;
    const flag = tray !== null && typeof tray === "object" ? (tray as Record<string, unknown>)["autoUpdate"] : undefined;
    return flag !== false;
  } catch {
    return true;
  }
}

/** The ui-leaf binary, where `bun add -g` puts it (the same two places `install-reader.sh` looks). */
export function uiLeafBinaryCandidates(env: Record<string, string | undefined>): string[] {
  const home = env["BUN_INSTALL"] ?? join(env["HOME"] ?? "", ".bun");
  const base = join(home, "install", "global", "node_modules");
  const bin = process.platform === "win32" ? "ui-leaf-bin.exe" : "ui-leaf-bin";
  return [join(base, UILEAF_PACKAGE, "bin", bin), join(base, PABLO_PACKAGE, "node_modules", UILEAF_PACKAGE, "bin", bin)];
}

export const uiLeafBinaryOnDisk = (env: Record<string, string | undefined>): boolean => uiLeafBinaryCandidates(env).some((p) => existsSync(p));

/** Whether `cli` is the file of a bun global install (`.../node_modules/@openthink/pablo/src/cli.ts`), not a checkout. */
export function isGlobalInstall(cli: string): boolean {
  return /[\\/]node_modules[\\/]@openthink[\\/]pablo[\\/]/.test(cli);
}

/** `{"version": "x.y.z"}` from `pablo --version --json`; undefined for anything else. */
export function parseProbe(stdout: string): string | undefined {
  try {
    const version = (JSON.parse(stdout) as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}
