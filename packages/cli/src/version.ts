import { readFileSync } from "node:fs";

/**
 * The installed `@openthink/pablo` version, read from the package's own
 * package.json next to `src/` (the same file in a repo checkout and in an
 * installed npm package — `files` ships `src`, and npm always ships
 * package.json). Read once at load so a release bump can't leave a hand-copied
 * constant stale.
 */
function readVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string") throw new Error("pablo: package.json has no version");
  return manifest.version;
}

export const VERSION: string = readVersion();
