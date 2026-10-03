/**
 * Turn `PabloTray.swift` (packages/cli/tray/PabloTray.swift, AGT-1256) into a
 * runnable `.app` bundle under Application Support, and skip the work when
 * the bundle already matches the source.
 *
 * A bare Mach-O can put an item in the menu bar, but it also gets a Dock
 * tile, an app-switcher entry and a menu of its own — `LSUIElement` is an
 * `Info.plist` key and a loose executable has no `Info.plist`. So this writes
 * a three-file bundle (`Contents/Info.plist`, `Contents/MacOS/PabloTray`,
 * `build.json`) rather than shipping the compiled binary alone.
 *
 * Modeled on `~/Development/insieme/src/tray.ts`'s `materializeTrayBundle`
 * and `~/Development/insieme/scripts/build-tray.ts`'s swiftc/codesign/`--check`
 * sequence, adapted to compile from source on the author's own Mac (pablo is
 * a linked checkout run under bun, never a downloaded artifact, so there is
 * no Gatekeeper ceremony and an ad-hoc signature is enough) rather than
 * embedding a pre-signed asset.
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

/** The bundle's identifier, and the identifier its ad-hoc signature carries. */
export const TRAY_BUNDLE_ID = "ai.openthink.pablo.tray";
export const TRAY_BUNDLE_NAME = "PabloTray.app";
export const TRAY_HELPER_NAME = "PabloTray";

/** The oldest macOS the helper is compiled to run on. */
const DEPLOYMENT_OS = "macos13.0";

/**
 * The architecture half of `-target`, derived from the host rather than
 * pinned to `arm64`. A hardcoded `arm64` would silently cross-compile on an
 * Intel Mac and then fail at *exec* time with a confusing error instead of a
 * clean pass or a named reason — the exact bug AGT-1256's review caught in
 * `packages/cli/test/tray-helper.test.ts`, whose derivation this mirrors so
 * the two compile invocations cannot drift apart.
 */
function targetTriple(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  return `${arch}-apple-${DEPLOYMENT_OS}`;
}

/** What a compile/sign/check step reports back. Never throws on failure. */
export interface ExecResult {
  code: number;
  stderr: string;
}

/** Runs one external command. Injected so no suite ever shells out for real. */
export type Exec = (cmd: string[]) => Promise<ExecResult>;

export interface MaterializeTrayBundleOptions {
  /** Path to `PabloTray.swift`. */
  source: string;
  /** `~/Library/Application Support/pablo`, or a test's temp dir. */
  appSupportDir: string;
  /** Recorded in `build.json` alongside the source hash. */
  version: string;
  /** Overrides the `swiftc` binary `which` would find. `""` forces "not found". */
  swiftc?: string;
  /** Overrides how swiftc/codesign/the compiled helper's `--check` are run. */
  exec?: Exec;
}

export interface MaterializeTrayBundleResult {
  bundlePath: string;
  helperPath: string;
  /** False when the bundle already matched, or when the build failed. */
  built: boolean;
  /** Set whenever `built` is false because something did not succeed. */
  reason?: string;
}

interface BuildStamp {
  source_sha256: string;
  version: string;
}

function sha256File(path: string): string {
  const hasher = createHash("sha256");
  hasher.update(readFileSync(path));
  return hasher.digest("hex");
}

function readStamp(path: string): BuildStamp | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as Record<string, unknown>)["source_sha256"] === "string" &&
      typeof (parsed as Record<string, unknown>)["version"] === "string"
    ) {
      return parsed as unknown as BuildStamp;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Exactly the text the design doc pins, byte for byte. `LSUIElement` as
 * `<true/>` is the load-bearing key — the same trap
 * `<string>true</string>` sets for `KeepAlive` elsewhere: it lints as valid
 * XML and silently means nothing, and here the symptom would be a Dock icon
 * bouncing every time the daemon starts.
 */
function renderInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>PabloTray</string>
<key>CFBundleIdentifier</key><string>ai.openthink.pablo.tray</string>
<key>CFBundleName</key><string>pablo</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>
`;
}

/**
 * The real `exec`, used when a caller does not inject one. It shells out with
 * `Bun.spawnSync` and folds one extra check into the contract: a `--check`
 * invocation that exits 0 but did not print exactly `pablo-tray ok\n` is
 * turned into a failure here, because the injected type carries only
 * `{code, stderr}` — there is nowhere else for "the stdout was wrong" to be
 * reported.
 */
async function defaultExec(cmd: string[]): Promise<ExecResult> {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  const isCheck = cmd[cmd.length - 1] === "--check";
  if (isCheck && proc.exitCode === 0 && stdout !== "pablo-tray ok\n") {
    return { code: 1, stderr: stderr || `unexpected --check output: ${JSON.stringify(stdout)}` };
  }
  return { code: proc.exitCode ?? 1, stderr };
}

/**
 * Build the bundle, or confirm it is already right.
 *
 * The sha256 of `source` is the idempotence key, compared against
 * `build.json` alongside `version` — not a timestamp (would skip a rebuild
 * after restoring an older source from backup) and not a version check alone
 * (would skip a rebuild after editing the source without bumping a version).
 *
 * Two things about the write are load-bearing, both inherited from
 * insieme's `materializeTrayBundle`: **nothing is overwritten in place**
 * (macOS caches code-signature validity per inode, so new bytes written into
 * the path of a previously-signed binary can produce one the kernel
 * intermittently refuses to exec) and **the stamp is written last**, after
 * both the plist and the binary are in place — an interrupted build leaves
 * either nothing changed or a fresh binary with no matching stamp, which the
 * next call will only ever choose to rebuild, never mistake for done.
 */
export async function materializeTrayBundle(
  opts: MaterializeTrayBundleOptions,
): Promise<MaterializeTrayBundleResult> {
  const bundlePath = join(opts.appSupportDir, TRAY_BUNDLE_NAME);
  const contentsPath = join(bundlePath, "Contents");
  const macosPath = join(contentsPath, "MacOS");
  const helperPath = join(macosPath, TRAY_HELPER_NAME);
  const plistPath = join(contentsPath, "Info.plist");
  const stampPath = join(bundlePath, "build.json");

  let sourceSha256: string;
  try {
    sourceSha256 = sha256File(opts.source);
  } catch (error) {
    return {
      bundlePath,
      helperPath,
      built: false,
      reason: `cannot read source: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const existingStamp = readStamp(stampPath);
  if (existingStamp && existingStamp.source_sha256 === sourceSha256 && existingStamp.version === opts.version) {
    return { bundlePath, helperPath, built: false };
  }

  // `??`, not `||`: `opts.swiftc` left `undefined` means "look it up for
  // real", but a test forces "not found" by passing `swiftc: ""` even on a
  // Mac that has the real compiler installed — an empty string is a value,
  // not an absence, and must not fall through to `Bun.which`.
  const swiftc = opts.swiftc ?? Bun.which("swiftc");
  if (!swiftc) {
    return { bundlePath, helperPath, built: false, reason: "swiftc not found; run xcode-select --install" };
  }

  const exec = opts.exec ?? defaultExec;

  try {
    mkdirSync(macosPath, { recursive: true });

    // A pid-suffixed path in the SAME directory as the final one, so the
    // rename below is same-filesystem (atomic) and never leaves a half
    // compiled binary at `helperPath` if this process is killed mid-build.
    const tmpBinary = join(macosPath, `${TRAY_HELPER_NAME}.${process.pid}.tmp`);
    rmSync(tmpBinary, { force: true });

    const compile = await exec([
      swiftc,
      "-O",
      "-parse-as-library",
      "-target",
      targetTriple(),
      "-framework",
      "AppKit",
      opts.source,
      "-o",
      tmpBinary,
    ]);
    if (compile.code !== 0) {
      rmSync(tmpBinary, { force: true });
      return { bundlePath, helperPath, built: false, reason: compile.stderr || "swiftc failed" };
    }

    const sign = await exec(["codesign", "--force", "--identifier", TRAY_BUNDLE_ID, "-s", "-", tmpBinary]);
    if (sign.code !== 0) {
      rmSync(tmpBinary, { force: true });
      return { bundlePath, helperPath, built: false, reason: sign.stderr || "codesign failed" };
    }

    const check = await exec([tmpBinary, "--check"]);
    if (check.code !== 0) {
      rmSync(tmpBinary, { force: true });
      return { bundlePath, helperPath, built: false, reason: check.stderr || "the compiled helper did not run" };
    }

    // The plist, temp-then-rename, same rule as the binary below.
    const plistTmp = `${plistPath}.${process.pid}.tmp`;
    rmSync(plistTmp, { force: true });
    await Bun.write(plistTmp, renderInfoPlist());
    rmSync(plistPath, { force: true });
    renameSync(plistTmp, plistPath);

    // Never write into an existing executable in place: chmod the temp file,
    // remove whatever is at the destination, then rename over it.
    chmodSync(tmpBinary, 0o755);
    rmSync(helperPath, { force: true });
    renameSync(tmpBinary, helperPath);

    const stampTmp = `${stampPath}.${process.pid}.tmp`;
    rmSync(stampTmp, { force: true });
    const stamp: BuildStamp = { source_sha256: sourceSha256, version: opts.version };
    await Bun.write(stampTmp, `${JSON.stringify(stamp, null, 2)}\n`);
    rmSync(stampPath, { force: true });
    renameSync(stampTmp, stampPath);

    return { bundlePath, helperPath, built: true };
  } catch (error) {
    return {
      bundlePath,
      helperPath,
      built: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
