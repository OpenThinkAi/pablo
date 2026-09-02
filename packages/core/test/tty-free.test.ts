import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `packages/core` is TTY-free by contract: the parser, span model, proposal
 * type and provider adapters must be testable without a terminal, so a
 * renderer swap touches nothing important. This test is the enforcement — if
 * it fails, the import belongs in `packages/tui`, not here.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const MANIFEST = fileURLToPath(new URL("../package.json", import.meta.url));

const FORBIDDEN = /opentui|^node:tty$|^tty$|^ink$|^ink\/|blessed/;

/** Every `from "x"`, `import "x"`, `import("x")` and `require("x")` specifier in a source file. */
const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFilesUnder(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("core sources import no terminal library", () => {
  const files = tsFilesUnder(SRC);
  expect(files.length).toBeGreaterThan(0);

  const offenders = files.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [...source.matchAll(SPECIFIER)]
      .map((match) => match[1] ?? "")
      .filter((specifier) => FORBIDDEN.test(specifier))
      .map((specifier) => `${file} imports ${specifier}`);
  });

  expect(offenders).toEqual([]);
});

test("core declares no dependencies at all", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, unknown>;

  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    expect(manifest[field] ?? {}).toEqual({});
  }
});
