/**
 * Helpers shared by every ui-leaf window the CLI opens (review, mixer, reader):
 * where the views ship, which Chromium-family browser to use, and where
 * ui-leaf's own binary lives.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Where the view files ship (`packages/cli/views`, in the package's `files`). */
export const VIEWS_ROOT = resolve(import.meta.dir, "..", "views");

/** macOS Chromium-family bundle paths ui-leaf's own probe uses; the ui-leaf windows need one of them. */
export const CHROMIUM_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
] as const;

export function executable(path: string): boolean {
  try {
    return (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function findChrome(exists: (path: string) => boolean = executable): string | undefined {
  return CHROMIUM_PATHS.find((path) => exists(path));
}

/** ui-leaf's own `ui-leaf-bin` beside the installed package, when it is there; undefined lets ui-leaf look. */
export function resolveUiLeafBinary(): string | undefined {
  try {
    const entry = Bun.resolveSync("@openthink/ui-leaf", import.meta.dir);
    const bin = join(dirname(entry), "..", "bin", process.platform === "win32" ? "ui-leaf-bin.exe" : "ui-leaf-bin");
    return existsSync(bin) ? resolve(bin) : undefined;
  } catch {
    return undefined;
  }
}
