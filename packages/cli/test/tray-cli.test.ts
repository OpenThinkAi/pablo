import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTray, openRoundArgs } from "../src/tray/cli";
import type { TrayCliDeps } from "../src/tray/cli";
import { defaultEnvPath, launchdPlist, TRAY_LABEL } from "../src/tray/launchd";
import { tempDir } from "./tray-fakes";

// AGT-1589: `pablo tray install|uninstall` and the bare daemon path, with every
// effect injected: no real launchctl, ~/Library/LaunchAgents, helper or daemon.

let root: string;
let calls: string[][];
let out: string[];
let err: string[];

beforeEach(() => {
  root = tempDir("pablo-tray-cli-");
  calls = [];
  out = [];
  err = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function deps(extra: Partial<TrayCliDeps> = {}): TrayCliDeps {
  return {
    env: { HOME: root, XDG_STATE_HOME: join(root, "state") },
    exec: async (cmd) => {
      calls.push(cmd);
      return { code: 0, stderr: "" };
    },
    bun: "/opt/bun/bin/bun",
    cli: "/repo/packages/cli/src/cli.ts",
    plistPath: join(root, "Library", "LaunchAgents", `${TRAY_LABEL}.plist`),
    logDir: join(root, "Library", "Logs", "pablo"),
    appSupportDir: join(root, "Library", "Application Support", "pablo"),
    swiftc: "/usr/bin/swiftc",
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    runDaemon: async () => {},
    onStop: () => () => {},
    ...extra,
  };
}

describe("install", () => {
  test("writes the plist for `bun cli.ts tray`, loads it through launchctl, and keeps the reader's XDG_STATE_HOME", async () => {
    const d = deps();
    expect(await runTray("install", d)).toBe(0);
    const plist = readFileSync(d.plistPath, "utf8");
    expect(plist).toContain("<string>/opt/bun/bin/bun</string>\n\t\t<string>/repo/packages/cli/src/cli.ts</string>\n\t\t<string>tray</string>");
    expect(plist).toContain(`<key>XDG_STATE_HOME</key>\n\t\t<string>${join(root, "state")}</string>`);
    expect(plist).toContain("<key>KeepAlive</key>\n\t<true/>");
    expect(calls.map((c) => c.slice(0, 2))).toEqual([
      ["launchctl", "bootout"],
      ["launchctl", "bootstrap"],
    ]);
    expect(out[0]).toContain("installed");
    expect(err).toEqual([]);
  });

  test("a launchctl failure is reported and exits 1", async () => {
    const code = await runTray("install", deps({ exec: async (cmd) => (cmd[1] === "bootstrap" ? { code: 5, stderr: "Bootstrap failed: 5" } : { code: 0, stderr: "" }) }));
    expect(code).toBe(1);
    expect(err).toEqual(["Bootstrap failed: 5"]);
  });

  test("a Mac without swiftc is told the icon will be missing, and the install still succeeds", async () => {
    expect(await runTray("install", deps({ swiftc: undefined }))).toBe(0);
    expect(err.join("\n")).toContain("xcode-select --install");
  });

  test("the plist's PATH reaches Homebrew, where gh lives", () => {
    expect(defaultEnvPath()).toContain("/opt/homebrew/bin");
    expect(launchdPlist({ label: "l", bun: "b", cli: "c", logDir: "/x", path: "/p", env: { PATH: "ignored", A: "1&2" } })).toContain("<key>A</key>\n\t\t<string>1&amp;2</string>");
  });
});

describe("uninstall", () => {
  test("unloads the agent and leaves nothing behind (plist, logs, helper bundle, tray state), but keeps the round cache", async () => {
    const d = deps();
    await runTray("install", d);
    // What a running tray would have written:
    mkdirSync(d.logDir, { recursive: true });
    writeFileSync(join(d.logDir, "tray.log"), "log");
    writeFileSync(join(d.logDir, "tray.err"), "err");
    mkdirSync(join(d.appSupportDir, "PabloTray.app", "Contents"), { recursive: true });
    const stateRoot = join(root, "state", "pablo");
    mkdirSync(join(stateRoot, "tray"), { recursive: true });
    writeFileSync(join(stateRoot, "tray", "tray-state.json"), "{}");
    writeFileSync(join(stateRoot, "tray", "notified.json"), "[]");
    mkdirSync(join(stateRoot, "rounds", "OpenThinkAi", "a-reading", "1"), { recursive: true });
    writeFileSync(join(stateRoot, "rounds", "OpenThinkAi", "a-reading", "1", "x.marks.json"), "{}");
    calls.length = 0;

    expect(await runTray("uninstall", d)).toBe(0);
    expect(calls).toEqual([["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}`, d.plistPath]]);
    expect(existsSync(d.plistPath)).toBe(false);
    expect(existsSync(d.logDir)).toBe(false);
    expect(existsSync(d.appSupportDir)).toBe(false);
    expect(existsSync(join(stateRoot, "tray"))).toBe(false);
    // the reader's own marks are not the tray's to delete
    expect(existsSync(join(stateRoot, "rounds", "OpenThinkAi", "a-reading", "1", "x.marks.json"))).toBe(true);
    expect(out.slice(-1)).toEqual(["uninstalled"]);
  });

  test("with nothing installed it is a no-op that touches no launchctl", async () => {
    expect(await runTray("uninstall", deps())).toBe(0);
    expect(calls).toEqual([]);
    expect(out).toEqual(["nothing installed"]);
  });

  test("a directory that still holds other files is not removed", async () => {
    const d = deps();
    mkdirSync(d.logDir, { recursive: true });
    writeFileSync(join(d.logDir, "tray.log"), "log");
    writeFileSync(join(d.logDir, "something-else.log"), "keep");
    await runTray("uninstall", d);
    expect(existsSync(join(d.logDir, "tray.log"))).toBe(false);
    expect(existsSync(join(d.logDir, "something-else.log"))).toBe(true);
  });
});

describe("the bare verb and the opener", () => {
  test("bare `tray` runs the daemon until the stop signal, then removes its signal handlers", async () => {
    let stopped = false;
    let aborted: AbortSignal | undefined;
    let abort: () => void = () => {};
    const code = await runTray(
      undefined,
      deps({
        onStop: (a) => {
          abort = a;
          return () => {
            stopped = true;
          };
        },
        runDaemon: async (signal) => {
          aborted = signal;
          abort();
        },
      }),
    );
    expect(code).toBe(0);
    expect(aborted?.aborted).toBe(true);
    expect(stopped).toBe(true);
  });

  test("an unknown subcommand is refused", async () => {
    expect(await runTray("restart", deps())).toBe(1);
    expect(err[0]).toContain('unknown subcommand "restart"');
  });

  test("a round opens through `pablo read <ref>`, the single entry the view owns", () => {
    expect(openRoundArgs("/bun", "/cli.ts", { repo: "OpenThinkAi/a-reading", pr: 4 })).toEqual(["/bun", "/cli.ts", "read", "OpenThinkAi/a-reading#4"]);
  });
});

describe("packaging and the Swift helper", () => {
  const pkgRoot = fileURLToPath(new URL("..", import.meta.url));

  test("the helper source ships in the npm package", () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("tray");
    expect(existsSync(join(pkgRoot, "tray", "PabloTray.swift"))).toBe(true);
  });

  // AppKit exists only on macOS: Linux CI runners can have swiftc but no AppKit to check against.
  const swiftc = process.platform === "darwin" ? Bun.which("swiftc") : null;
  test.skipIf(swiftc === null)(
    "PabloTray.swift type-checks (compiled for checking only; the helper is never run)",
    () => {
      const result = Bun.spawnSync([swiftc as string, "-typecheck", "-parse-as-library", "-framework", "AppKit", join(pkgRoot, "tray", "PabloTray.swift")], { stderr: "pipe" });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
    },
    120_000,
  );
});
