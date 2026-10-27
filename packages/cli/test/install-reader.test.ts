import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * AGT-1590: install-reader.sh run against stubbed commands. Nothing real is reachable: PATH holds only a
 * temp dir of stubs plus symlinks to a short whitelist of harmless coreutils (so an un-stubbed `launchctl`, `bun`, `gh`, `brew` or `pablo` is "command not found", never the real thing), HOME is a
 * temp dir, and every stub just appends its argv to a log. The script is run with `/bin/sh`.
 */
// Each case spawns a shell that spawns stubs; a loaded machine can be slow.
setDefaultTimeout(30_000);

const SCRIPT = join(import.meta.dir, "..", "..", "..", "install-reader.sh");
const SAFE_TOOLS = ["uname", "sed", "head", "mktemp", "rm", "mkdir", "cp", "chmod", "cat", "dirname", "basename", "tr", "grep"];
const SYSTEM_BINS = ["/bin", "/usr/bin"];

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

interface Sandbox {
  home: string;
  stubs: string;
  log: string;
  /** a stub: a script body; argv is logged first. */
  stub(name: string, body?: string, dir?: string): void;
  run(extraEnv?: Record<string, string>): { code: number; out: string; calls: string[] };
}

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "pablo-install-reader-"));
  dirs.push(root);
  const home = join(root, "home");
  const stubs = join(root, "stubs");
  const tools = join(root, "tools");
  for (const dir of [home, stubs, tools]) mkdirSync(dir, { recursive: true });
  const log = join(root, "calls.log");
  writeFileSync(log, "");
  for (const tool of SAFE_TOOLS) {
    const real = SYSTEM_BINS.map((d) => join(d, tool)).find((p) => existsSync(p));
    if (real) symlinkSync(real, join(tools, tool));
  }
  const sb: Sandbox = {
    home,
    stubs,
    log,
    stub(name, body = "", dir = stubs) {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, name);
      writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
      chmodSync(file, 0o755);
    },
    run(extraEnv = {}) {
      const res = Bun.spawnSync(["/bin/sh", SCRIPT], {
        env: {
          PATH: `${stubs}:${tools}`,
          HOME: home,
          ...extraEnv,
        },
        stdin: "ignore",
      });
      const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
      return { code: res.exitCode, out: `${res.stdout.toString()}${res.stderr.toString()}`, calls };
    },
  };
  return sb;
}

test("the script is plain POSIX sh with set -eu, parses, and only runs main on its last line", () => {
  const text = readFileSync(SCRIPT, "utf8");
  expect(text.startsWith("#!/bin/sh\n")).toBe(true);
  expect(text).toMatch(/^set -eu$/m);
  const lines = text.trimEnd().split("\n");
  expect(lines[lines.length - 1]).toBe('main "$@"');
  // no top-level command other than assignments, function definitions and the final main call
  expect(text.match(/^main /gm)?.length).toBe(1);
  expect(Bun.spawnSync(["/bin/sh", "-n", SCRIPT]).exitCode).toBe(0);
  // a truncated download (cut before the last line) does nothing at all
  const cut = lines.slice(0, -1).join("\n");
  const sb = sandbox();
  const file = join(dirname(sb.log), "cut.sh");
  writeFileSync(file, cut);
  const res = Bun.spawnSync(["/bin/sh", file], { env: { PATH: "/nonexistent", HOME: sb.home } });
  expect(res.exitCode).toBe(0);
  expect(res.stdout.toString()).toBe("");
});

test("not a Mac: refuses before doing anything", () => {
  const sb = sandbox();
  sb.stub("uname", `echo Linux`);
  const { code, out, calls } = sb.run();
  expect(code).not.toBe(0);
  expect(out).toContain("for Macs");
  expect(calls.filter((c) => !c.startsWith("uname"))).toEqual([]);
});

test("on a Mac with no old tray: installs nothing, needs no Chrome, and points at the GitHub pull request", () => {
  const sb = sandbox();
  sb.stub("uname", `echo Darwin`);
  const { code, out, calls } = sb.run();
  expect(code).toBe(0);
  expect(calls.filter((c) => !c.startsWith("uname"))).toEqual([]);
  expect(out).toContain("Next: open the pull request your author sent you on GitHub and review the chapters there.");
  expect(out).not.toContain("Step");
});

test("an old tray is booted out and its files removed", () => {
  const sb = sandbox();
  sb.stub("uname", `echo Darwin`);
  sb.stub("launchctl");
  sb.stub("id", `echo 501`);
  const plist = join(sb.home, "Library", "LaunchAgents", "ai.openthink.pablo.tray.plist");
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, "x");
  const { code, out, calls } = sb.run();
  expect(code).toBe(0);
  expect(existsSync(plist)).toBe(false);
  expect(calls).toContain("launchctl bootout gui/501/ai.openthink.pablo.tray");
  expect(out).toContain("The old tray is removed.");
});

test("the script no longer mentions Chrome, the reader window or a removed verb, and installs nothing", () => {
  const script = readFileSync(SCRIPT, "utf8");
  expect(script).not.toMatch(/chrome/i);
  expect(script).not.toMatch(/pablo read\b/);
  expect(script).not.toMatch(/brew install|bun add|gh auth login/);
  expect(script).toContain("open the pull request your author sent you on GitHub");
});
