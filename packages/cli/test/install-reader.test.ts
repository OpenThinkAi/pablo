import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * AGT-1590: install-reader.sh run against stubbed commands. Nothing real is reachable: PATH holds only a
 * temp dir of stubs plus symlinks to a short whitelist of harmless coreutils (so an un-stubbed `brew`, `curl`,
 * `bun`, `gh`, `xcode-select`, `launchctl` or `pablo` is "command not found", never the real thing), HOME is a
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
  apps: string;
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
  const apps = join(root, "Applications");
  for (const dir of [home, stubs, tools, apps]) mkdirSync(dir, { recursive: true });
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
    apps,
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
          PABLO_INSTALL_APPS: apps,
          PABLO_INSTALL_TTY: "/dev/null",
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

const UILEAF = (home: string): string => join(home, ".bun", "install", "global", "node_modules", "@openthink", "ui-leaf", "bin");

/** Payload scripts the stubbed installers drop into place (written by the test, copied by the stubs). */
function payload(sb: Sandbox): void {
  const dir = join(dirname(sb.log), "payload");
  mkdirSync(dir, { recursive: true });
  const ul = UILEAF(sb.home);
  const put = (name: string, body: string): void => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  // bun: logs; `add -g` "installs" pablo (on PATH via ~/.bun/bin) and ui-leaf's binary.
  put(
    "bun",
    `echo "bun $*" >> "${sb.log}"
if [ "$1 $2" = "add -g" ]; then
  mkdir -p "${ul}" "${sb.home}/.bun/bin"
  : > "${ul}/ui-leaf-bin"
  cp "${dir}/pablo" "${sb.home}/.bun/bin/pablo"
fi
exit 0`,
  );
  put("pablo", `echo "pablo $*" >> "${sb.log}"`);
  put(
    "gh",
    `echo "gh $*" >> "${sb.log}"
if [ "$1 $2" = "auth status" ]; then [ -f "${sb.home}/.gh-signed-in" ]; exit $?; fi
if [ "$1 $2" = "auth login" ]; then : > "${sb.home}/.gh-signed-in"; fi
exit 0`,
  );
}
const PAYLOAD = (sb: Sandbox): string => join(dirname(sb.log), "payload");

/** A Mac where everything installs fine and nothing is present yet. Individual tests override pieces. */
function freshMac(sb: Sandbox, opts: { brew?: boolean } = {}): void {
  payload(sb);
  sb.stub("uname", `if [ "\${1:-}" = "-m" ]; then echo arm64; else echo Darwin; fi`);
  sb.stub("xcode-select", `[ "\${1:-}" = "-p" ] && echo /Library/Developer/CommandLineTools; exit 0`);
  mkdirSync(join(sb.apps, "Google Chrome.app"), { recursive: true });
  if (opts.brew !== false) {
    // brew "installs" bun and gh by dropping the payload on the stub PATH.
    sb.stub(
      "brew",
      `case "$*" in
  *oven-sh/bun/bun*) cp "${PAYLOAD(sb)}/bun" "${sb.stubs}/bun";;
  *"install gh"*) cp "${PAYLOAD(sb)}/gh" "${sb.stubs}/gh";;
esac`,
    );
  }
}

function installedBun(sb: Sandbox): void {
  sb.stub("bun", `exec /bin/sh "${PAYLOAD(sb)}/bun" "$@"`);
}
function installedGh(sb: Sandbox, signedIn: boolean): void {
  if (signedIn) writeFileSync(join(sb.home, ".gh-signed-in"), "");
  sb.stub("gh", `exec /bin/sh "${PAYLOAD(sb)}/gh" "$@"`);
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

test("fresh Mac with Homebrew: installs bun and gh with brew, pablo with bun, signs in, starts the tray, in order", () => {
  const sb = sandbox();
  freshMac(sb);
  const { code, out, calls } = sb.run();
  expect(out).toContain("All done");
  expect(code).toBe(0);
  const order = [
    "brew install oven-sh/bun/bun",
    "brew install gh",
    "bun add -g --trust @openthink/pablo@latest",
    "bun pm -g trust @openthink/ui-leaf",
    "gh auth login",
    "pablo tray install",
  ].map((c) => calls.findIndex((x) => x === c));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(out).toContain("[1]");
  expect(out).not.toContain("Google Chrome is not installed");
});

test("no Homebrew: Bun comes from bun.sh's installer and gh from GitHub's own release download", () => {
  const sb = sandbox();
  freshMac(sb, { brew: false });
  sb.stub(
    "curl",
    `case "$*" in
  *bun.sh/install*) out=$3; printf '#!/bin/sh\\n' > "$out";;
  *api.github.com*) printf '{"tag_name": "v2.99.0"}\\n';;
  *gh_2.99.0_macOS_arm64.zip*) : > "$4";;
esac`,
  );
  sb.stub("bash", `mkdir -p "${join(sb.home, ".bun", "bin")}"; cp "${PAYLOAD(sb)}/bun" "${join(sb.home, ".bun", "bin", "bun")}"`);
  sb.stub("unzip", `d="$4/gh_2.99.0_macOS_arm64/bin"; mkdir -p "$d"; cp "${PAYLOAD(sb)}/gh" "$d/gh"`);
  const { code, out, calls } = sb.run();
  expect(out).toContain("All done");
  expect(code).toBe(0);
  expect(calls.some((c) => c.startsWith("curl -fsSL https://bun.sh/install"))).toBe(true);
  expect(calls.some((c) => c.startsWith("curl -fsSL https://api.github.com/repos/cli/cli/releases/latest"))).toBe(true);
  expect(calls.some((c) => c.includes("releases/download/v2.99.0/gh_2.99.0_macOS_arm64.zip"))).toBe(true);
  expect(existsSync(join(sb.home, ".bun", "bin", "gh"))).toBe(true);
  expect(calls).toContain("pablo tray install");
  expect(calls.some((c) => c.startsWith("brew"))).toBe(false);
});

test("re-run when everything is present: nothing is reinstalled, pablo is upgraded, sign-in is skipped, the tray is refreshed", () => {
  const sb = sandbox();
  freshMac(sb, { brew: false });
  installedBun(sb);
  installedGh(sb, true);
  sb.stub("brew");
  const { code, out, calls } = sb.run();
  expect(code).toBe(0);
  expect(calls.some((c) => c.startsWith("brew"))).toBe(false);
  expect(calls.some((c) => c.startsWith("curl"))).toBe(false);
  expect(calls).toContain("bun add -g --trust @openthink/pablo@latest");
  expect(calls).not.toContain("gh auth login");
  expect(calls).toContain("pablo tray install");
  expect(out).toContain("already signed in");
});

test("no Chrome: says so plainly, points at the download, does not install it, and still finishes", () => {
  const sb = sandbox();
  freshMac(sb, { brew: false });
  rmSync(join(sb.apps, "Google Chrome.app"), { recursive: true });
  installedBun(sb);
  installedGh(sb, true);
  const { code, out, calls } = sb.run();
  expect(code).toBe(0);
  expect(out).toContain("Google Chrome is not installed");
  expect(out).toContain("https://www.google.com/chrome/");
  expect(out.split("https://www.google.com/chrome/").length).toBeGreaterThan(2); // repeated in the closing summary
  expect(calls.some((c) => /chrome/i.test(c))).toBe(false);
  expect(calls).toContain("pablo tray install");
});

test("missing Xcode Command Line Tools: opens Apple's installer and stops before installing anything", () => {
  const sb = sandbox();
  freshMac(sb);
  sb.stub("xcode-select", `[ "\${1:-}" = "-p" ] && exit 2; exit 0`);
  const { code, out, calls } = sb.run();
  expect(code).not.toBe(0);
  expect(calls).toContain("xcode-select --install");
  expect(calls.some((c) => c.startsWith("brew") || c.startsWith("bun") || c.startsWith("pablo"))).toBe(false);
  expect(out).toContain("run this command again");
});

test("not a Mac: refuses before doing anything", () => {
  const sb = sandbox();
  freshMac(sb);
  sb.stub("uname", `echo Linux`);
  const { code, out, calls } = sb.run();
  expect(code).not.toBe(0);
  expect(out).toContain("for Macs");
  expect(calls.filter((c) => !c.startsWith("uname"))).toEqual([]);
});

test("a failed pablo install stops with a clear message and never reaches sign-in or the tray", () => {
  const sb = sandbox();
  freshMac(sb, { brew: false });
  installedGh(sb, false);
  sb.stub("bun", `[ "$1 $2" = "add -g" ] && { echo "network down" >&2; exit 1; }; exit 0`);
  const { code, out, calls } = sb.run();
  expect(code).not.toBe(0);
  expect(out).toContain("Stopped: Installing pablo did not work");
  expect(out).toContain("run the same command again");
  expect(calls).not.toContain("gh auth login");
  expect(calls).not.toContain("pablo tray install");
});

test("the chapter-window binary missing after install is caught, with the fix named", () => {
  const sb = sandbox();
  freshMac(sb, { brew: false });
  installedGh(sb, true);
  sb.stub(
    "bun",
    `[ "$1 $2" = "add -g" ] && { printf '#!/bin/sh\\n' > "${sb.stubs}/pablo"; chmod +x "${sb.stubs}/pablo"; }; exit 0`,
  );
  const { code, out, calls } = sb.run();
  expect(code).not.toBe(0);
  expect(out).toContain("chapter-window component did not finish downloading");
  expect(out).toContain("bun pm -g trust @openthink/ui-leaf");
  expect(calls).not.toContain("pablo tray install");
});

test("GitHub sign-in with no terminal to type in is a clear stop; a failed sign-in is too", () => {
  const sb = sandbox();
  freshMac(sb, { brew: false });
  installedBun(sb);
  installedGh(sb, false);
  const noTty = sb.run({ PABLO_INSTALL_TTY: "/nonexistent/tty" });
  expect(noTty.code).not.toBe(0);
  expect(noTty.out).toContain("needs a Terminal window you can type in");
  expect(noTty.calls).not.toContain("gh auth login");

  const sb2 = sandbox();
  freshMac(sb2, { brew: false });
  installedBun(sb2);
  sb2.stub("gh", `[ "$1 $2" = "auth status" ] && exit 1; [ "$1 $2" = "auth login" ] && exit 1; exit 0`);
  const failed = sb2.run();
  expect(failed.code).not.toBe(0);
  expect(failed.out).toContain("sign-in did not finish");
  expect(failed.calls).not.toContain("pablo tray install");
});
