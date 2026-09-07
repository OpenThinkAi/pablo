import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultCliPath,
  defaultEnvPath,
  defaultLogDir,
  defaultPlistPath,
  installTray,
  launchdPlist,
  TRAY_LABEL,
  uninstallTray,
} from "../src/tray/launchd";
import type { Exec, ExecResult } from "../src/tray/launchd";

// AGT-1268: `pablo tray install|uninstall`'s launchd agent. Every test here
// injects `exec` — no test ever runs the real `launchctl` — and every path
// that would otherwise touch `~/Library/LaunchAgents` or `~/Library/Logs`
// lives inside a per-test `mkdtemp` dir instead.

const UID_DOMAIN = `gui/${process.getuid?.() ?? 0}`;

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A fake `exec` that records every command, in call order, and returns canned results by tool. */
function fakeExec(calls: string[][], overrides?: { bootout?: ExecResult; bootstrap?: ExecResult }): Exec {
  return async (cmd: string[]): Promise<ExecResult> => {
    calls.push(cmd);
    const action = cmd[1];
    if (action === "bootout" && overrides?.bootout) return overrides.bootout;
    if (action === "bootstrap" && overrides?.bootstrap) return overrides.bootstrap;
    return { code: 0, stderr: "" };
  };
}

describe("launchdPlist", () => {
  test("renders Label, ProgramArguments, RunAtLoad/KeepAlive as <true/>, PATH, and log paths", () => {
    const text = launchdPlist({
      label: TRAY_LABEL,
      bun: "/opt/bun/bin/bun",
      cli: "/repo/packages/cli/src/cli.ts",
      logDir: "/tmp/pablo-logs",
      path: "/opt/bun/bin:/usr/bin:/bin",
    });

    expect(text).toContain("<key>Label</key>\n\t<string>ai.openthink.pablo.tray</string>");
    expect(text).toContain(
      "<key>ProgramArguments</key>\n\t<array>\n\t\t<string>/opt/bun/bin/bun</string>\n\t\t<string>/repo/packages/cli/src/cli.ts</string>\n\t\t<string>tray</string>\n\t</array>",
    );
    expect(text).toContain("<key>RunAtLoad</key>\n\t<true/>");
    expect(text).toContain("<key>KeepAlive</key>\n\t<true/>");
    expect(text).not.toContain("<string>true</string>");
    expect(text).toContain(
      "<key>EnvironmentVariables</key>\n\t<dict>\n\t\t<key>PATH</key>\n\t\t<string>/opt/bun/bin:/usr/bin:/bin</string>\n\t</dict>",
    );
    expect(text).toContain("<key>StandardOutPath</key>\n\t<string>/tmp/pablo-logs/tray.log</string>");
    expect(text).toContain("<key>StandardErrorPath</key>\n\t<string>/tmp/pablo-logs/tray.err</string>");
  });

  test("escapes XML-significant characters in path-shaped values", () => {
    const text = launchdPlist({
      label: TRAY_LABEL,
      bun: "/a & b/bun",
      cli: "/a/cli.ts",
      logDir: "/tmp/logs",
      path: "/a<b>:/usr/bin",
    });
    expect(text).toContain("/a &amp; b/bun");
    expect(text).toContain("/a&lt;b&gt;:/usr/bin");
  });
});

describe("installTray / uninstallTray", () => {
  let dir: string;
  let plistPath: string;
  let logDir: string;

  beforeEach(() => {
    dir = tempDir("pablo-tray-launchd-");
    plistPath = join(dir, "LaunchAgents", `${TRAY_LABEL}.plist`);
    logDir = join(dir, "Logs", "pablo");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes the plist and runs bootout then bootstrap against gui/<uid>", async () => {
    const calls: string[][] = [];
    const plist = launchdPlist({
      label: TRAY_LABEL,
      bun: "/bin/bun",
      cli: "/repo/cli.ts",
      logDir,
      path: "/usr/bin",
    });

    const result = await installTray({ plistPath, plist, logDir, exec: fakeExec(calls) });

    expect(result.ok).toBe(true);
    expect(existsSync(plistPath)).toBe(true);
    expect(readFileSync(plistPath, "utf8")).toBe(plist);
    // logDir is created even though nothing writes into it directly here —
    // StandardOutPath/StandardErrorPath need somewhere to land the moment
    // launchd starts the daemon.
    expect(existsSync(logDir)).toBe(true);

    expect(calls).toEqual([
      ["launchctl", "bootout", UID_DOMAIN, plistPath],
      ["launchctl", "bootstrap", UID_DOMAIN, plistPath],
    ]);
  });

  test("a failing bootstrap is reported, not thrown, and its stderr is returned", async () => {
    const calls: string[][] = [];
    const plist = launchdPlist({ label: TRAY_LABEL, bun: "/bin/bun", cli: "/repo/cli.ts", logDir, path: "/usr/bin" });

    const result = await installTray({
      plistPath,
      plist,
      logDir,
      exec: fakeExec(calls, { bootstrap: { code: 1, stderr: "service already loaded\n" } }),
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toBe("service already loaded\n");
    // The plist is still written before launchctl runs — install fails at
    // the launchctl step, not before it.
    expect(existsSync(plistPath)).toBe(true);
  });

  test("a bootout failure (e.g. nothing was loaded) is ignored, not propagated", async () => {
    const calls: string[][] = [];
    const plist = launchdPlist({ label: TRAY_LABEL, bun: "/bin/bun", cli: "/repo/cli.ts", logDir, path: "/usr/bin" });

    const result = await installTray({
      plistPath,
      plist,
      logDir,
      exec: fakeExec(calls, { bootout: { code: 36, stderr: "Could not find service\n" } }),
    });

    expect(result.ok).toBe(true);
  });

  test("running install twice replaces rather than duplicates: bootout precedes bootstrap each time", async () => {
    const calls: string[][] = [];
    const plistV1 = launchdPlist({ label: TRAY_LABEL, bun: "/bin/bun", cli: "/repo/cli.ts", logDir, path: "v1" });
    const plistV2 = launchdPlist({ label: TRAY_LABEL, bun: "/bin/bun", cli: "/repo/cli.ts", logDir, path: "v2" });
    const exec = fakeExec(calls);

    const first = await installTray({ plistPath, plist: plistV1, logDir, exec });
    const second = await installTray({ plistPath, plist: plistV2, logDir, exec });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // Exactly one plist on disk, holding the second install's content.
    expect(readFileSync(plistPath, "utf8")).toBe(plistV2);
    expect(calls).toEqual([
      ["launchctl", "bootout", UID_DOMAIN, plistPath],
      ["launchctl", "bootstrap", UID_DOMAIN, plistPath],
      ["launchctl", "bootout", UID_DOMAIN, plistPath],
      ["launchctl", "bootstrap", UID_DOMAIN, plistPath],
    ]);
  });

  test("uninstall with nothing installed is a clean no-op: exec is never called", async () => {
    const calls: string[][] = [];
    const result = await uninstallTray({ plistPath, exec: fakeExec(calls) });

    expect(result.removed).toBe(false);
    expect(calls).toEqual([]);
  });

  test("uninstall with an agent installed runs bootout and removes the plist", async () => {
    const calls: string[][] = [];
    const plist = launchdPlist({ label: TRAY_LABEL, bun: "/bin/bun", cli: "/repo/cli.ts", logDir, path: "/usr/bin" });
    await installTray({ plistPath, plist, logDir, exec: fakeExec([]) });
    expect(existsSync(plistPath)).toBe(true);

    const result = await uninstallTray({
      plistPath,
      exec: fakeExec(calls, { bootout: { code: 36, stderr: "not loaded\n" } }),
    });

    expect(result.removed).toBe(true);
    expect(existsSync(plistPath)).toBe(false);
    expect(calls).toEqual([["launchctl", "bootout", UID_DOMAIN, plistPath]]);
  });

  test("uninstall never removes a file at plistPath it did not write (a stray file is left alone by exec but still removed once found)", async () => {
    // installTray/uninstallTray operate purely on the passed-in path; the
    // "never delete a file it did not write" guarantee comes from checking
    // existence first, not from tracking provenance. A plist written by
    // anything else at this exact path is still what "installed" means.
    mkdirSync(join(dir, "LaunchAgents"), { recursive: true });
    writeFileSync(join(dir, "LaunchAgents", `${TRAY_LABEL}.plist`), "not ours", "utf8");
    const calls: string[][] = [];
    const result = await uninstallTray({ plistPath, exec: fakeExec(calls) });
    expect(result.removed).toBe(true);
    expect(existsSync(plistPath)).toBe(false);
  });
});

describe("default* derivation", () => {
  const ORIGINAL_HOME = process.env["HOME"];
  let home: string;

  beforeEach(() => {
    home = tempDir("pablo-tray-home-");
    process.env["HOME"] = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (ORIGINAL_HOME !== undefined) process.env["HOME"] = ORIGINAL_HOME;
  });

  test("defaultPlistPath and defaultLogDir resolve under the current HOME", () => {
    expect(defaultPlistPath()).toBe(join(home, "Library", "LaunchAgents", `${TRAY_LABEL}.plist`));
    expect(defaultLogDir()).toBe(join(home, "Library", "Logs", "pablo"));
  });

  test("defaultEnvPath starts with dirname(process.execPath) and includes the standard bins and ~/.bun/bin", () => {
    const path = defaultEnvPath();
    const parts = path.split(":");
    expect(parts[0]).toBe(process.execPath.slice(0, process.execPath.lastIndexOf("/")));
    expect(parts).toContain("/usr/bin");
    expect(parts).toContain("/bin");
    expect(parts).toContain("/usr/sbin");
    expect(parts).toContain("/sbin");
    expect(parts).toContain(join(home, ".bun", "bin"));
  });

  test("defaultCliPath resolves to a real, absolute packages/cli/src/cli.ts", () => {
    const cliPath = defaultCliPath();
    expect(cliPath.endsWith("cli.ts")).toBe(true);
    expect(existsSync(cliPath)).toBe(true);
  });
});
