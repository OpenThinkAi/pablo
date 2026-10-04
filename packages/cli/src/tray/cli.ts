/**
 * `pablo tray [install|uninstall]` (AGT-1589). Bare `tray` runs the daemon in
 * the foreground until SIGTERM/SIGINT; `install` writes and loads the launchd
 * agent that keeps it running after login; `uninstall` unloads it and removes
 * everything the tray wrote. CLI-only: never an MCP tool, no `--project`.
 *
 * Every external effect is in `TrayCliDeps`, so the tests exercise all three
 * paths without a real `launchctl`, `~/Library/LaunchAgents`, notification,
 * helper or GitHub call. `realTrayDeps()` is the production wiring.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { configPath } from "@openthink/pablo-core";
import { VERSION } from "../version";
import { readerActive } from "./activity";
import { materializeTrayBundle, TRAY_BUNDLE_NAME } from "./bundle";
import { defaultHelperSource, runTrayDaemon } from "./daemon";
import type { OpenedRound, TrayDaemonDeps } from "./daemon";
import {
  defaultAppSupportDir,
  defaultCliPath,
  defaultEnvPath,
  defaultLogDir,
  defaultPlistPath,
  installTray,
  launchdPlist,
  TRAY_LABEL,
  uninstallTray,
} from "./launchd";
import type { Exec } from "./launchd";
import { osascriptNotifier } from "./notify";
import { trayDir } from "./state";
import {
  createUpdater,
  isGlobalInstall,
  parseAutoUpdate,
  parseProbe,
  readUpdateRecord,
  REGISTRY_LATEST_URL,
  uiLeafBinaryOnDisk,
  updateRecordPath,
  writeUpdateRecord,
} from "./update";
import type { LatestAnswer, UpdateEffects } from "./update";
import { spawnTrayHelper, superviseHelper } from "./supervise";
import { roundRefLabel } from "../read";
import type { RoundRef } from "../read";
import type { Runner, RunResult } from "../share";

export interface TrayCliDeps {
  readonly env: Record<string, string | undefined>;
  readonly exec: Exec;
  /** `process.execPath`: the `bun` that runs the daemon. */
  readonly bun: string;
  /** Absolute path of `cli.ts`. */
  readonly cli: string;
  readonly plistPath: string;
  readonly logDir: string;
  readonly appSupportDir: string;
  /** The compiler the menu-bar helper needs, or undefined. */
  readonly swiftc: string | undefined;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Runs the foreground daemon until `signal` aborts. */
  readonly runDaemon: (signal: AbortSignal) => Promise<void>;
  /** Wires SIGTERM/SIGINT to `abort`; returns the cleanup. Injected so a test never installs real handlers. */
  readonly onStop: (abort: () => void) => () => void;
}

const EXIT_OK = 0;
const EXIT_ERROR = 1;

/** `bun cli.ts read <ref>`: the single entry that opens a round's view (AGT-1586 owns what it shows). */
export function openRoundArgs(bun: string, cli: string, ref: RoundRef): string[] {
  return [bun, cli, "read", roundRefLabel(ref)];
}

export async function runTray(sub: string | undefined, deps: TrayCliDeps): Promise<number> {
  if (sub === "install") {
    const xdg = deps.env["XDG_STATE_HOME"];
    const plist = launchdPlist({
      label: TRAY_LABEL,
      bun: deps.bun,
      cli: deps.cli,
      logDir: deps.logDir,
      path: defaultEnvPath(),
      env: xdg !== undefined && xdg !== "" ? { XDG_STATE_HOME: xdg } : undefined,
    });
    const result = await installTray({ plistPath: deps.plistPath, plist, logDir: deps.logDir, exec: deps.exec });
    if (!result.ok) {
      deps.err(result.stderr || "pablo: tray install: launchctl bootstrap failed");
      return EXIT_ERROR;
    }
    deps.out(`installed ${deps.plistPath}`);
    if (deps.swiftc === undefined) {
      deps.err("pablo: tray: swiftc not found, so there is no menu-bar icon (notifications still work); run xcode-select --install, then `pablo tray install` again");
    }
    return EXIT_OK;
  }
  if (sub === "uninstall") {
    const result = await uninstallTray({
      plistPath: deps.plistPath,
      exec: deps.exec,
      leftovers: [join(deps.logDir, "tray.log"), join(deps.logDir, "tray.err"), join(deps.appSupportDir, TRAY_BUNDLE_NAME), trayDir(deps.env)],
      prune: [deps.logDir, deps.appSupportDir],
    });
    deps.out(result.removed ? "uninstalled" : "nothing installed");
    return EXIT_OK;
  }
  if (sub !== undefined) {
    deps.err(`pablo: tray: unknown subcommand "${sub}" (expected install or uninstall)`);
    return EXIT_ERROR;
  }

  const controller = new AbortController();
  const release = deps.onStop(() => controller.abort());
  try {
    await deps.runDaemon(controller.signal);
  } finally {
    release();
  }
  return EXIT_OK;
}

/** A `gh`/`git` runner whose every call is bounded: a stalled network must not wedge the poller forever. */
export const boundedRunner: Runner = (command, args, options = {}): RunResult => {
  try {
    const result = Bun.spawnSync([command, ...args], {
      cwd: options.cwd,
      stdin: options.input === undefined ? "ignore" : Buffer.from(options.input, "utf8"),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
    return { code: result.exitCode ?? 1, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") };
  } catch (error) {
    return { code: 1, stdout: "", stderr: (error as Error).message };
  }
};

async function launchctlExec(cmd: string[]): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

async function runCommand(cmd: string[], env: Record<string, string | undefined>, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env, timeout: timeoutMs });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, stdout, stderr };
  } catch (error) {
    return { code: 1, stdout: "", stderr: (error as Error).message };
  }
}

/** The registry's `latest`, asked with `If-None-Match` so an unchanged answer is a bodiless 304. */
async function fetchLatestFromRegistry(etag: string | undefined): Promise<LatestAnswer> {
  try {
    const response = await fetch(REGISTRY_LATEST_URL, {
      headers: { accept: "application/json", ...(etag === undefined ? {} : { "if-none-match": etag }) },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 304) return { kind: "unchanged" };
    if (!response.ok) return { kind: "error", reason: `the registry answered ${response.status}` };
    const body = (await response.json()) as { version?: unknown };
    return { kind: "modified", version: body.version, etag: response.headers.get("etag") ?? undefined };
  } catch (error) {
    return { kind: "error", reason: (error as Error).message };
  }
}

/** The real updater effects: the registry, `bun add -g`, the installed pablo as a fresh process. Never built by a test. */
function realUpdateEffects(env: Record<string, string | undefined>, cli: string, log: (line: string) => void): UpdateEffects {
  const recordPath = updateRecordPath(trayDir(env));
  return {
    fetchLatest: fetchLatestFromRegistry,
    bun: async (args) => {
      const { code, stderr } = await runCommand([process.execPath, ...args], env, 300_000);
      return { code, stderr };
    },
    uiLeafBinaryPresent: () => uiLeafBinaryOnDisk(env),
    // The command launchd will run next: `bun <cli> tray`, here `--version --json`, from the same path on disk.
    probeVersion: async () => {
      const result = await runCommand([process.execPath, cli, "--version", "--json"], env, 30_000);
      return result.code === 0 ? parseProbe(result.stdout) : undefined;
    },
    readRecord: () => readUpdateRecord(recordPath),
    writeRecord: (record) => writeUpdateRecord(recordPath, record),
    autoUpdate: () => {
      try {
        return parseAutoUpdate(readFileSync(configPath(env), "utf8"));
      } catch {
        return true;
      }
    },
    ineligible: () => {
      // Exit 0 only restarts the tray under launchd (KeepAlive), and only a bun global install is what `bun add -g` replaces.
      if (env["XPC_SERVICE_NAME"] !== TRAY_LABEL) return "this tray was not started by its launchd agent (pablo tray install)";
      if (!isGlobalInstall(cli)) return "this pablo is not the global install (a checkout updates with git)";
      return undefined;
    },
    now: () => Date.now(),
    log,
  };
}

/** The production wiring. Never built by a test. */
export function realTrayDeps(env: Record<string, string | undefined> = process.env): TrayCliDeps {
  const cli = defaultCliPath();
  const daemonDeps = (): TrayDaemonDeps => {
    const log = (line: string): void => {
      process.stderr.write(`${line}\n`);
    };
    return {
      env,
      log,
      now: () => new Date(),
      sleep: (ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms).unref();
        }),
      run: boundedRunner,
      notifier: osascriptNotifier(),
      openRound: (ref): OpenedRound => {
        const child = Bun.spawn(openRoundArgs(process.execPath, cli, ref), { stdin: "ignore", stdout: "ignore", stderr: "ignore", env });
        return { exited: child.exited };
      },
      materialize: materializeTrayBundle,
      supervise: superviseHelper,
      spawnHelper: spawnTrayHelper,
      helperSource: defaultHelperSource(),
      version: VERSION,
      update: createUpdater(realUpdateEffects(env, cli, (line) => log(`${new Date().toISOString()} ${line}`)), VERSION),
      readerActive: () => readerActive(env),
      exit: (code) => process.exit(code),
    };
  };
  return {
    env,
    exec: launchctlExec,
    bun: process.execPath,
    cli,
    plistPath: defaultPlistPath(),
    logDir: defaultLogDir(),
    appSupportDir: defaultAppSupportDir(env),
    swiftc: Bun.which("swiftc") ?? undefined,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    runDaemon: (signal) => runTrayDaemon(daemonDeps(), signal),
    onStop: (abort) => {
      process.on("SIGTERM", abort);
      process.on("SIGINT", abort);
      return () => {
        process.off("SIGTERM", abort);
        process.off("SIGINT", abort);
      };
    },
  };
}
