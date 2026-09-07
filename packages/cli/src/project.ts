/**
 * Vault and project resolution for the `pablo` bin.
 *
 * A **project** is a directory under `<vault>/<kind>/<slug>` — the layout the
 * writing vault already uses (see `~/saltline-digital-vault/projects/ai-terminal/README.md`).
 * Resolution never guesses: an unresolvable vault or project is a typed
 * refusal that names every path it tried, so the driving agent can relay
 * exactly what pablo looked for instead of a generic "not found".
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The kinds of work a vault holds, in the order resolution checks them. */
const PROJECT_KINDS = ["novels", "stories", "essays"] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

/**
 * A framework-precondition refusal: exit code 2 everywhere in the CLI.
 * `tried` is every path resolution looked at, in order, so the caller can
 * show its work — `message` restates the same information as one line.
 */
export interface Refusal {
  readonly ok: false;
  readonly code: 2;
  readonly message: string;
  readonly tried: readonly string[];
}

export interface VaultFound {
  readonly ok: true;
  readonly path: string;
}

export type VaultResult = VaultFound | Refusal;

export interface ProjectFound {
  readonly ok: true;
  readonly path: string;
  readonly kind: ProjectKind;
  readonly slug: string;
}

export type ProjectResult = ProjectFound | Refusal;

function refuse(message: string, tried: readonly string[]): Refusal {
  return { ok: false, code: 2, message, tried };
}

/**
 * Finds the writing vault. `PABLO_VAULT` in `env`, when set, is authoritative
 * and is checked (not assumed) to contain `style/`; otherwise this walks up
 * from `cwd` for the nearest ancestor directory containing a `style/`
 * directory, which is the vault's own marker.
 */
export function findVault(cwd: string, env: Record<string, string | undefined> = process.env): VaultResult {
  const override = env["PABLO_VAULT"];
  if (override !== undefined && override !== "") {
    const vaultPath = resolve(override);
    const marker = join(vaultPath, "style");
    if (existsSync(marker)) return { ok: true, path: vaultPath };
    return refuse(
      `pablo: PABLO_VAULT is set to ${vaultPath}, but ${marker} does not exist`,
      [marker],
    );
  }

  const tried: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    const marker = join(dir, "style");
    tried.push(marker);
    if (existsSync(marker)) return { ok: true, path: dir };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return refuse(
    `pablo: no writing vault found above ${resolve(cwd)} (looked for a "style/" directory in every ancestor); set PABLO_VAULT or run inside one`,
    tried,
  );
}

/**
 * Resolves `slug` to a project directory under `vault`, trying each kind in
 * `PROJECT_KINDS` order and returning the first one that exists on disk.
 */
export function resolveProject(vault: string, slug: string): ProjectResult {
  const tried: string[] = [];
  for (const kind of PROJECT_KINDS) {
    const candidate = join(vault, kind, slug);
    tried.push(candidate);
    if (existsSync(candidate)) return { ok: true, path: candidate, kind, slug };
  }

  return refuse(
    `pablo: no project "${slug}" found under ${vault} (looked in ${PROJECT_KINDS.join(", ")})`,
    tried,
  );
}

/**
 * The combined lookup the CLI uses for `--project <slug>`: find the vault
 * from `cwd`, then resolve `slug` inside it. Fails on whichever step fails
 * first, with that step's `tried` paths.
 */
export function resolveProjectFromCwd(
  cwd: string,
  slug: string,
  env: Record<string, string | undefined> = process.env,
): ProjectResult {
  const vault = findVault(cwd, env);
  if (!vault.ok) return vault;
  return resolveProject(vault.path, slug);
}
