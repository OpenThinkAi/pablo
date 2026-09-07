import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// AGT-1256: PabloTray.swift is a single-file AppKit menu-bar helper with no
// Xcode project. This compiles it with the real toolchain — the same flags
// `bun run test:tray` (and eventually AGT-1265's build script) will use — and
// drives `--check`/`--menu` as subprocesses, because those two modes are the
// only ones provable without a status item existing anywhere (see the file's
// own header). No status item, no NSApplication, and no real state file is
// ever created outside a temp directory.

const SOURCE = fileURLToPath(new URL("../tray/PabloTray.swift", import.meta.url));
const SWIFTC = Bun.which("swiftc");

// The ticket's AC 6 pins `arm64-apple-macos13.0` — right for the fleet this
// ships to (both of Matt's Macs are Apple Silicon), but a hardcoded arm64
// target cross-compiles silently on an Intel host and then fails at *exec*
// time with a confusing "Exec format error" instead of a clean pass or skip.
// Deriving the arch keeps the exact pinned target on arm64 hosts and stays
// runnable on x86_64 ones.
const TARGET = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos13.0`;

function writeState(dir: string, name: string, body: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(body), "utf8");
  return path;
}

function run(binary: string, args: string[]): { stdout: string; exitCode: number } {
  const result = Bun.spawnSync([binary, ...args]);
  return { stdout: result.stdout.toString(), exitCode: result.exitCode ?? -1 };
}

if (!SWIFTC) {
  describe.skip("PabloTray.swift (swiftc not on PATH — skipping compiled-helper suite)", () => {
    test("skipped", () => {});
  });
} else {
  describe("PabloTray.swift", () => {
    let buildDir: string;
    let stateDir: string;
    let binary: string;

    beforeAll(() => {
      buildDir = mkdtempSync(join(tmpdir(), "pablo-tray-build-"));
      stateDir = mkdtempSync(join(tmpdir(), "pablo-tray-state-"));
      binary = join(buildDir, "PabloTray");
      const result = Bun.spawnSync(
        [
          SWIFTC,
          "-O",
          "-parse-as-library",
          "-target",
          TARGET,
          "-framework",
          "AppKit",
          SOURCE,
          "-o",
          binary,
        ],
        { stderr: "pipe" },
      );
      if (result.exitCode !== 0) {
        throw new Error(`swiftc failed to compile PabloTray.swift:\n${result.stderr.toString()}`);
      }
    });

    afterAll(() => {
      rmSync(buildDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    });

    test("--check prints pablo-tray ok and exits 0", () => {
      const { stdout, exitCode } = run(binary, ["--check"]);
      expect(exitCode).toBe(0);
      expect(stdout).toBe("pablo-tray ok\n");
    });

    test("--menu with an empty pending list shows the disabled Nothing waiting line", () => {
      const path = writeState(stateDir, "empty.json", { daemonPid: 0, version: "0.1.0", pending: [] });
      const { stdout, exitCode } = run(binary, ["--menu", path]);
      expect(exitCode).toBe(0);
      expect(stdout).toBe(["label: Nothing waiting", "separator", "label: pablo 0.1.0", ""].join("\n"));
    });

    test("a missing state file renders as empty pending, not an error", () => {
      const { stdout, exitCode } = run(binary, ["--menu", join(stateDir, "does-not-exist.json")]);
      expect(exitCode).toBe(0);
      expect(stdout).toBe(["label: Nothing waiting", "separator", "label: pablo", ""].join("\n"));
    });

    test("a malformed state file (not JSON) renders as empty pending", () => {
      const path = join(stateDir, "malformed.json");
      writeFileSync(path, "not json at all {{{", "utf8");
      const { stdout, exitCode } = run(binary, ["--menu", path]);
      expect(exitCode).toBe(0);
      expect(stdout).toBe(["label: Nothing waiting", "separator", "label: pablo", ""].join("\n"));
    });

    test("--menu with three pending pieces: newest first, each a submenu with Approve and Review…", () => {
      const path = writeState(stateDir, "three.json", {
        daemonPid: 4242,
        version: "0.1.0",
        pending: [
          { id: "a1", kind: "chapter", title: "First", words: 100, at: "2026-09-01T00:00:00Z" },
          { id: "b2", kind: "prose", title: "Second", words: 412, at: "2026-09-03T00:00:00Z" },
          { id: "c3", kind: "chapter", title: "Third", words: 250, at: "2026-09-02T00:00:00Z" },
        ],
      });
      const { stdout, exitCode } = run(binary, ["--menu", path]);
      expect(exitCode).toBe(0);
      expect(stdout).toBe(
        [
          'submenu: "Second" · 412 words · prose',
          "  action: Approve [approve b2]",
          "  action: Review… [review b2]",
          'submenu: "Third" · 250 words · chapter',
          "  action: Approve [approve c3]",
          "  action: Review… [review c3]",
          'submenu: "First" · 100 words · chapter',
          "  action: Approve [approve a1]",
          "  action: Review… [review a1]",
          "separator",
          "label: pablo 0.1.0",
          "",
        ].join("\n"),
      );
    });

    test("--menu with six pending pieces shows only the five newest", () => {
      const pending = Array.from({ length: 6 }, (_, i) => ({
        id: `id${i}`,
        kind: "chapter",
        title: `Piece ${i}`,
        words: 10 * i,
        at: `2026-09-0${i + 1}T00:00:00Z`,
      }));
      const path = writeState(stateDir, "six.json", { daemonPid: 4242, version: "0.1.0", pending });
      const { stdout, exitCode } = run(binary, ["--menu", path]);
      expect(exitCode).toBe(0);

      const submenuLines = stdout.split("\n").filter((line) => line.startsWith("submenu:"));
      expect(submenuLines).toHaveLength(5);
      // Newest (`id5`, at 2026-09-06) first; oldest shown is `id1` — `id0` (the
      // sixth, oldest piece) is dropped.
      expect(submenuLines[0]).toContain("Piece 5");
      expect(submenuLines[4]).toContain("Piece 1");
      expect(stdout).not.toContain("Piece 0");
    });

    test("--menu with lastError set shows a disabled error line before the separator", () => {
      const path = writeState(stateDir, "error.json", {
        daemonPid: 0,
        version: "0.1.0",
        pending: [],
        lastError: "the writer refused",
      });
      const { stdout, exitCode } = run(binary, ["--menu", path]);
      expect(exitCode).toBe(0);
      expect(stdout).toBe(
        ["label: Nothing waiting", "label: the writer refused", "separator", "label: pablo 0.1.0", ""].join("\n"),
      );
    });
  });
}
