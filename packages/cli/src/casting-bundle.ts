/**
 * `casting-bundle.ts` (AGT-1678) — copies the casting sources into the npm
 * package at pack time.
 *
 * npm's `files` cannot reach outside the package directory, and the casting
 * sources live in `packages/casting`, a sibling of `packages/cli`. So
 * `prepack` copies them into `packages/cli/casting/` (gitignored) and
 * `postpack` removes the copy; `files` lists `casting`. Only sources travel:
 * `pyproject.toml`, `uv.lock` and `src/` — never a `.venv`, weights, caches or
 * the tests. `casting.ts`'s `castingLayout` finds the copy at `../casting`.
 *
 *   bun run src/casting-bundle.ts          # prepack: copy
 *   bun run src/casting-bundle.ts --clean  # postpack: remove
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The top-level entries copied; everything else in `packages/casting` stays behind. */
export const BUNDLED = ["pyproject.toml", "uv.lock", "src"] as const;

/** Names never copied, at any depth. */
const EXCLUDED = new Set([".venv", "__pycache__", ".pytest_cache", ".DS_Store"]);

export function bundleCasting(from: string, to: string): void {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  for (const entry of BUNDLED) {
    const source = join(from, entry);
    if (!existsSync(source)) throw new Error(`casting-bundle: ${source} is missing`);
    cpSync(source, join(to, entry), {
      recursive: true,
      filter: (path) => !EXCLUDED.has(basename(path)) && !path.endsWith(".egg-info") && !path.endsWith(".pyc"),
    });
  }
}

if (import.meta.main) {
  const to = fileURLToPath(new URL("../casting", import.meta.url));
  if (process.argv.includes("--clean")) rmSync(to, { recursive: true, force: true });
  else bundleCasting(fileURLToPath(new URL("../../casting", import.meta.url)), to);
}
