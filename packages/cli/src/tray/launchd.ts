/**
 * `pablo tray install|uninstall` — the launchd agent that keeps `pablo tray`
 * (the reader's poller, which also supervises the menu-bar helper) running
 * after login without a terminal holding it open (AGT-1589; the pattern is the
 * retired AGT-1520 tray's, which in turn copies insieme's launch agent).
 *
 * `launchdPlist` renders the plist text; `installTray`/`uninstallTray` do the
 * filesystem and `launchctl` work, with the command runner injected as
 * `exec` so no test ever shells out to the real `launchctl` or touches the
 * author's real `~/Library/LaunchAgents`. `cli.ts` supplies the real values
 * (`process.execPath`, this file's own `cli.ts` path, the derived `PATH`,
 * `process.getuid()`) and a real `exec` built on `Bun.spawn`.
 */

import { existsSync, mkdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * `$HOME`, read directly rather than through `os.homedir()` — Bun's
 * `homedir()` resolves once from the account record and does not track a
 * `process.env.HOME` reassignment made afterward, which is exactly how
 * `tray-launchd.test.ts` points every `default*` path at a temp directory
 * with no real launchd/log/plist location ever touched.
 */
function home(): string {
  return process.env["HOME"] ?? homedir();
}

/** The plist's `Label`, and the filename `~/Library/LaunchAgents/<TRAY_LABEL>.plist`. */
export const TRAY_LABEL = "ai.openthink.pablo.tray";

/** What one `exec` call reports back. Never throws on a non-zero exit. */
export interface ExecResult {
  code: number;
  stderr: string;
}

/** Runs one external command (`launchctl ...`). Injected so no suite shells out for real. */
export type Exec = (cmd: string[]) => Promise<ExecResult>;

export interface LaunchdPlistOptions {
  label: string;
  /** `process.execPath` — the `bun` binary that runs the daemon. */
  bun: string;
  /** Absolute path to `packages/cli/src/cli.ts`. */
  cli: string;
  /** `~/Library/Logs/pablo` (or a test's temp dir); holds `tray.log`/`tray.err`. */
  logDir: string;
  /** The `PATH` launchd hands the daemon — it starts with none of its own. */
  path: string;
  /** Extra environment for the daemon (e.g. the installer's `XDG_STATE_HOME`, so the daemon and the reader's shell agree on the round cache). */
  env?: Readonly<Record<string, string>>;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Renders the plist text, byte for byte in the shape the design doc and
 * AC1 pin: `<true/>` for both booleans (never `<string>true</string>`,
 * `bundle.ts`'s `LSUIElement` trap for `Info.plist`), `ProgramArguments`
 * exactly `[bun, cli, "tray"]` so the daemon starts in the same mode a
 * terminal running `pablo tray` would, and logs redirected to `<logDir>/
 * tray.log` / `tray.err` since launchd has no terminal to inherit.
 */
export function launchdPlist(opts: LaunchdPlistOptions): string {
  const outPath = join(opts.logDir, "tray.log");
  const errPath = join(opts.logDir, "tray.err");
  const extraEnv = Object.entries(opts.env ?? {})
    .filter(([key]) => key !== "PATH")
    .map(([key, value]) => `\n\t\t<key>${escapeXml(key)}</key>\n\t\t<string>${escapeXml(value)}</string>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${escapeXml(opts.label)}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${escapeXml(opts.bun)}</string>
		<string>${escapeXml(opts.cli)}</string>
		<string>tray</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${escapeXml(opts.path)}</string>${extraEnv}
	</dict>
	<key>StandardOutPath</key>
	<string>${escapeXml(outPath)}</string>
	<key>StandardErrorPath</key>
	<string>${escapeXml(errPath)}</string>
</dict>
</plist>
`;
}

/**
 * `process.getuid()`, the `<uid>` half of the `gui/<uid>` domain both
 * `launchctl bootout` and `bootstrap` target. Thrown rather than defaulted:
 * a launchd agent is a macOS/Linux-only concept, and a missing `getuid`
 * means there is no sane uid to fall back to.
 */
function launchdUid(): number {
  if (typeof process.getuid !== "function") {
    throw new Error("pablo tray install|uninstall requires a POSIX uid (process.getuid is unavailable)");
  }
  return process.getuid();
}

export interface InstallTrayOptions {
  /** `~/Library/LaunchAgents/<TRAY_LABEL>.plist` (or a test's temp path). */
  plistPath: string;
  /** The rendered text from `launchdPlist`. */
  plist: string;
  /** Created if missing, so `StandardOutPath`/`StandardErrorPath` have somewhere to write. */
  logDir: string;
  exec: Exec;
}

export interface InstallTrayResult {
  ok: boolean;
  /** Set only when `ok` is false — the failing `launchctl` call's stderr. */
  stderr?: string;
}

/**
 * Writes the plist (temp-then-rename, alongside `state.ts`/`bundle.ts`'s
 * pattern — a half-written plist left for launchd to read is worse than
 * none), then `launchctl bootout`s any agent already loaded at this label
 * before `bootstrap`ing the fresh one. `bootout` first is what makes running
 * `install` twice converge on exactly one loaded agent rather than erroring
 * on a label that is already bootstrapped; its result is ignored on purpose
 * — "nothing was loaded" is the common, expected case on a first install,
 * not a failure.
 */
export async function installTray(opts: InstallTrayOptions): Promise<InstallTrayResult> {
  mkdirSync(opts.logDir, { recursive: true });
  mkdirSync(dirname(opts.plistPath), { recursive: true });

  // pid-suffixed, so it cannot collide with a leftover from a prior run.
  const tmp = `${opts.plistPath}.${process.pid}.tmp`;
  writeFileSync(tmp, opts.plist, "utf8");
  rmSync(opts.plistPath, { force: true });
  renameSync(tmp, opts.plistPath);

  const domain = `gui/${launchdUid()}`;
  await opts.exec(["launchctl", "bootout", domain, opts.plistPath]);

  const bootstrap = await opts.exec(["launchctl", "bootstrap", domain, opts.plistPath]);
  if (bootstrap.code !== 0) {
    return { ok: false, stderr: bootstrap.stderr };
  }
  return { ok: true };
}

export interface UninstallTrayOptions {
  plistPath: string;
  exec: Exec;
  /** Everything else the tray wrote (log files, the helper bundle, its state directory): removed after the agent is unloaded. Only paths the caller derived from its own defaults. */
  leftovers?: readonly string[];
  /** Directories removed only when empty once the leftovers are gone (e.g. `~/Library/Logs/pablo`). */
  prune?: readonly string[];
}

export interface UninstallTrayResult {
  /** False when `plistPath` did not exist — nothing was installed. */
  removed: boolean;
  /** The leftovers that existed and were removed. */
  cleaned: string[];
}

/**
 * Idempotent and safe to run with nothing installed: the agent is unloaded
 * (`bootout`, whose result — including the common "not loaded" case — is never
 * surfaced as a failure) and the plist removed only when it was found on disk,
 * so it can never delete a plist it did not write. The leftovers go after the
 * unload, so the daemon cannot rewrite its state behind the cleanup. Running
 * it with nothing installed is a clean no-op that still sweeps strays.
 */
export async function uninstallTray(opts: UninstallTrayOptions): Promise<UninstallTrayResult> {
  const removed = existsSync(opts.plistPath);
  if (removed) {
    const domain = `gui/${launchdUid()}`;
    await opts.exec(["launchctl", "bootout", domain, opts.plistPath]);
    rmSync(opts.plistPath, { force: true });
  }
  const cleaned: string[] = [];
  for (const path of opts.leftovers ?? []) {
    if (!existsSync(path)) continue;
    rmSync(path, { recursive: true, force: true });
    cleaned.push(path);
  }
  for (const dir of opts.prune ?? []) {
    try {
      rmdirSync(dir); // fails (and is ignored) unless the directory is empty
    } catch {
      // not there, or not empty: not ours to remove
    }
  }
  return { removed, cleaned };
}

/** `~/Library/LaunchAgents/<TRAY_LABEL>.plist`. */
export function defaultPlistPath(): string {
  return join(home(), "Library", "LaunchAgents", `${TRAY_LABEL}.plist`);
}

/** `~/Library/Logs/pablo`. */
export function defaultLogDir(): string {
  return join(home(), "Library", "Logs", "pablo");
}

/**
 * `dirname(process.execPath)` (the directory `bun` itself lives in, first so
 * the daemon's own runtime always resolves), Homebrew's bin directories (where
 * `gh` lives), the standard system bin directories and `~/.bun/bin` (bun's own installer target, which is not
 * always on launchd's minimal default `PATH`).
 */
export function defaultEnvPath(): string {
  return [
    dirname(process.execPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    join(home(), ".bun", "bin"),
  ].join(":");
}

/** Absolute path to `packages/cli/src/cli.ts`, resolved from this file's own location. */
export function defaultCliPath(): string {
  return join(import.meta.dir, "..", "cli.ts");
}

/** `~/Library/Application Support/pablo`: where the compiled menu-bar helper bundle lives. */
export function defaultAppSupportDir(env: Record<string, string | undefined> = process.env): string {
  return env["PABLO_APP_SUPPORT_DIR"] ?? join(home(), "Library", "Application Support", "pablo");
}
