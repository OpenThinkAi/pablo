import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeTrayBundle } from "../src/tray/bundle";
import type { Exec, ExecResult } from "../src/tray/bundle";

// AGT-1265: materializeTrayBundle compiles packages/cli/tray/PabloTray.swift
// (AGT-1256) into an app bundle. Every test here injects `exec` so no real
// swiftc ever runs and no test writes outside its own mkdtemp dir — the
// constraint is "never build into a real location", not "never build".

function useTempDirs(): { appSupportDir: string; sourcePath: string } {
  const appSupportDir = mkdtempSync(join(tmpdir(), "pablo-tray-support-"));
  const sourceDir = mkdtempSync(join(tmpdir(), "pablo-tray-source-"));
  const sourcePath = join(sourceDir, "PabloTray.swift");
  writeFileSync(sourcePath, "// fixture source v1\n", "utf8");
  return { appSupportDir, sourcePath };
}

/**
 * A fake `exec` that records every command it is asked to run, in order, and
 * — for the swiftc invocation only — writes fixture bytes to the `-o`
 * target, standing in for the compiler actually producing a binary there.
 * `content()` is called at compile time so a second build can write bytes
 * that differ from the first.
 */
function fakeExec(calls: string[][], content: () => string, overrides?: Partial<Record<"swiftc" | "codesign" | "check", ExecResult>>): Exec {
  return async (cmd: string[]): Promise<ExecResult> => {
    calls.push(cmd);
    const tool = cmd[0] ?? "";
    if (tool.includes("swiftc")) {
      const outIndex = cmd.indexOf("-o");
      const outPath = outIndex >= 0 ? cmd[outIndex + 1] : undefined;
      if (outPath) writeFileSync(outPath, content(), "utf8");
      if (overrides?.swiftc) return overrides.swiftc;
      return { code: 0, stderr: "" };
    }
    if (tool === "codesign") {
      if (overrides?.codesign) return overrides.codesign;
      return { code: 0, stderr: "" };
    }
    // Whatever is left is the compiled helper's own `--check`.
    if (overrides?.check) return overrides.check;
    return { code: 0, stderr: "" };
  };
}

describe("materializeTrayBundle", () => {
  test("a stamp matching source and version skips the build without running anything", async () => {
    const { appSupportDir, sourcePath } = useTempDirs();
    const calls: string[][] = [];
    const exec = fakeExec(calls, () => "binary-v1");

    const first = await materializeTrayBundle({
      source: sourcePath,
      appSupportDir,
      version: "0.1.0",
      swiftc: "swiftc",
      exec,
    });
    expect(first.built).toBe(true);
    expect(first.reason).toBeUndefined();

    const shouldNotRun: Exec = async () => {
      throw new Error("exec must not be called when the stamp already matches");
    };
    const second = await materializeTrayBundle({
      source: sourcePath,
      appSupportDir,
      version: "0.1.0",
      swiftc: "swiftc",
      exec: shouldNotRun,
    });
    expect(second.built).toBe(false);
    expect(second.reason).toBeUndefined();
  });

  test("a fake exec records the swiftc, codesign and check commands in order", async () => {
    const { appSupportDir, sourcePath } = useTempDirs();
    const calls: string[][] = [];
    const exec = fakeExec(calls, () => "binary-v1");

    const result = await materializeTrayBundle({
      source: sourcePath,
      appSupportDir,
      version: "0.1.0",
      swiftc: "/usr/bin/swiftc",
      exec,
    });

    expect(result.built).toBe(true);
    expect(calls).toHaveLength(3);

    const [compile, sign, check] = calls as [string[], string[], string[]];
    expect(compile[0]).toBe("/usr/bin/swiftc");
    expect(compile).toContain("-O");
    expect(compile).toContain("-parse-as-library");
    expect(compile).toContain("-target");
    expect(compile).toContain("-framework");
    expect(compile).toContain("AppKit");
    expect(compile).toContain(sourcePath);
    expect(compile).toContain("-o");
    // The target triple is derived from the host arch, never hardcoded.
    const targetIndex = compile.indexOf("-target");
    const target = compile[targetIndex + 1] ?? "";
    expect(target).toMatch(/^(arm64|x86_64)-apple-macos13\.0$/);

    expect(sign[0]).toBe("codesign");
    expect(sign).toContain("--force");
    expect(sign).toContain("--identifier");
    expect(sign).toContain("ai.openthink.pablo.tray");
    expect(sign).toContain("-s");
    expect(sign).toContain("-");

    expect(check).toHaveLength(2);
    expect(check[1]).toBe("--check");

    expect(result.helperPath).toBe(join(appSupportDir, "PabloTray.app", "Contents", "MacOS", "PabloTray"));
    expect(readFileSync(result.helperPath, "utf8")).toBe("binary-v1");
  });

  test("the check failing returns a reason", async () => {
    const { appSupportDir, sourcePath } = useTempDirs();
    const calls: string[][] = [];
    const exec = fakeExec(calls, () => "binary-v1", {
      check: { code: 1, stderr: "pablo-tray: unexpected output" },
    });

    const result = await materializeTrayBundle({
      source: sourcePath,
      appSupportDir,
      version: "0.1.0",
      swiftc: "swiftc",
      exec,
    });

    expect(result.built).toBe(false);
    expect(result.reason).toContain("unexpected output");
  });

  test("missing swiftc returns the named reason without throwing", async () => {
    const { appSupportDir, sourcePath } = useTempDirs();

    const result = await materializeTrayBundle({
      source: sourcePath,
      appSupportDir,
      version: "0.1.0",
      // Forces "not found" regardless of whether this host actually has
      // swiftc — `""` is falsy, so it never falls through to a real lookup.
      swiftc: "",
      exec: async () => {
        throw new Error("exec must not be called when swiftc is missing");
      },
    });

    expect(result.built).toBe(false);
    expect(result.reason).toBe("swiftc not found; run xcode-select --install");
  });

  test("swiftc failing returns the tool's stderr as the reason, never throws", async () => {
    const { appSupportDir, sourcePath } = useTempDirs();
    const calls: string[][] = [];
    const exec = fakeExec(calls, () => "binary-v1", {
      swiftc: { code: 1, stderr: "error: cannot find type 'NSStatusBar'" },
    });

    const result = await materializeTrayBundle({
      source: sourcePath,
      appSupportDir,
      version: "0.1.0",
      swiftc: "swiftc",
      exec,
    });

    expect(result.built).toBe(false);
    expect(result.reason).toContain("NSStatusBar");
    // Only the compile step should have run — codesign and check never do.
    expect(calls).toHaveLength(1);
  });

  test("the plist contains LSUIElement true", async () => {
    const { appSupportDir, sourcePath } = useTempDirs();
    const calls: string[][] = [];
    const exec = fakeExec(calls, () => "binary-v1");

    const result = await materializeTrayBundle({
      source: sourcePath,
      appSupportDir,
      version: "0.1.0",
      swiftc: "swiftc",
      exec,
    });

    expect(result.built).toBe(true);
    const plistPath = join(appSupportDir, "PabloTray.app", "Contents", "Info.plist");
    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toMatch(/<key>LSUIElement<\/key>\s*<true\/>/);
    expect(plist).toContain("<key>CFBundleIdentifier</key><string>ai.openthink.pablo.tray</string>");
    expect(plist).toContain("<key>CFBundleExecutable</key><string>PabloTray</string>");
  });

  test("a second build after a source change replaces the binary (different content)", async () => {
    const { appSupportDir, sourcePath } = useTempDirs();
    const calls: string[][] = [];
    let build = 0;
    const exec = fakeExec(calls, () => `binary-v${++build}`);

    const first = await materializeTrayBundle({
      source: sourcePath,
      appSupportDir,
      version: "0.1.0",
      swiftc: "swiftc",
      exec,
    });
    expect(first.built).toBe(true);
    const firstContent = readFileSync(first.helperPath, "utf8");
    const firstInode = statSync(first.helperPath).ino;
    expect(firstContent).toBe("binary-v1");

    // Change the source so its sha256 no longer matches build.json.
    writeFileSync(sourcePath, "// fixture source v2 — changed\n", "utf8");

    const second = await materializeTrayBundle({
      source: sourcePath,
      appSupportDir,
      version: "0.1.0",
      swiftc: "swiftc",
      exec,
    });
    expect(second.built).toBe(true);
    const secondContent = readFileSync(second.helperPath, "utf8");
    const secondInode = statSync(second.helperPath).ino;

    expect(secondContent).toBe("binary-v2");
    expect(secondContent).not.toBe(firstContent);
    // Never overwritten in place: a fresh inode from the temp-then-rename.
    expect(secondInode).not.toBe(firstInode);
  });
});
