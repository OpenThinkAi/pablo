/**
 * Voice directories (AGT-1240): where `--voice <name>` finds who is
 * speaking. See the design doc's extension
 * (`~/saltline-digital-vault/projects/ai-terminal/prose.md`, "Voices"):
 *
 *     voices/<name>/
 *       voice.md        who is speaking, to whom, the register, the rules —
 *                        with `Flagged:` lines exactly like style/prose.md
 *       exemplars/       pieces kept as-is; newest first into every pack
 *       never.md         optional: words, claims and moves this voice never makes
 *
 * Resolution order for a bare name (`resolveVoice`): `<vault>/voices/<name>/`
 * first, then the global `$XDG_CONFIG_HOME/pablo/voices/<name>/` (default
 * `~/.config/pablo/voices/`). `fiction` is a standing alias to `<vault>/style/`
 * — `write` keeps reading that directory unchanged, and `voices/fiction`
 * resolves to it. A name containing "/" or ending in ".md" is instead
 * resolved as a one-off path (`--voice ./x.md`), the way the design doc
 * describes; it must already exist.
 *
 * `readVoice` turns whichever directory (or single file) `resolveVoice`
 * found into the shape a pack assembles from: `rules` (the `voice.md` body,
 * frontmatter stripped — or, for `fiction`, `style/*.md` sorted by name,
 * exactly as `readStyle` already reads it for `write`), `exemplars` (newest
 * first by filename), an optional `never`, and an optional `model` (from
 * `voice.md`'s frontmatter).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { configDir, readStyle, readTextSource } from "@openthink/pablo-core";
import type { TextSource } from "@openthink/pablo-core";
import { gitCommit, SLUG_PATTERN } from "./init";
import { parseFrontmatter } from "./novel/machine";
import { findVault } from "./project";
import type { Refusal } from "./project";

function refuse(message: string, tried: readonly string[]): Refusal {
  return { ok: false, code: 2, message, tried };
}

/** Where a voice directory (or one-off file) resolution ended up. */
export type VoiceScope = "vault" | "global" | "fiction" | "path";

export interface VoiceLocation {
  readonly ok: true;
  readonly path: string;
  readonly scope: VoiceScope;
}

export type VoiceResolution = VoiceLocation | Refusal;

/** The global voices directory: `$XDG_CONFIG_HOME/pablo/voices`, else `~/.config/pablo/voices`. */
export function globalVoicesDir(env: Record<string, string | undefined> = process.env): string {
  return join(configDir(env), "voices");
}

/**
 * Resolves `name` to a voice directory (or, for a one-off, a single markdown
 * file): `<vault>/voices/<name>/` first, else the global voices directory;
 * `fiction` always means `<vault>/style/`; a `name` shaped like a path
 * (contains "/" or ends in ".md") is resolved against `cwd` instead and must
 * already exist. An unresolvable name is a refusal (exit 2) naming every
 * path tried.
 */
export function resolveVoice(
  name: string,
  opts: { readonly cwd: string; readonly env?: Record<string, string | undefined> },
): VoiceResolution {
  const env = opts.env ?? process.env;
  const trimmed = name.trim();

  if (trimmed === "") {
    return refuse("pablo: voice name must not be empty", []);
  }

  if (trimmed.includes("/") || trimmed.endsWith(".md")) {
    const resolved = resolve(opts.cwd, trimmed);
    if (!existsSync(resolved)) return refuse(`pablo: no voice at ${resolved}`, [resolved]);
    return { ok: true, path: resolved, scope: "path" };
  }

  // A plain name is joined onto a directory below, so it must be a slug and
  // nothing else. Without this a bare `..` (no `/`, no `.md` suffix, so it
  // misses the path branch above) would `join()` its way to the vault root and
  // be read as a voice — inside the vault, but not a voice the user named.
  if (!SLUG_PATTERN.test(trimmed)) {
    return refuse(
      `pablo: "${trimmed}" is not a voice name (lowercase letters, digits and dashes; use a path with "/" or ".md" for a one-off voice file)`,
      [],
    );
  }

  const vaultResult = findVault(opts.cwd, env);

  if (trimmed === "fiction") {
    if (!vaultResult.ok) {
      return refuse(
        `pablo: voice "fiction" needs a vault (none found above ${resolve(opts.cwd)})`,
        vaultResult.tried,
      );
    }
    const styleDir = join(vaultResult.path, "style");
    if (existsSync(styleDir)) return { ok: true, path: styleDir, scope: "fiction" };
    return refuse(`pablo: no voice "fiction" (no style/ directory in ${vaultResult.path})`, [styleDir]);
  }

  const tried: string[] = [];
  if (vaultResult.ok) {
    const vaultVoiceDir = join(vaultResult.path, "voices", trimmed);
    tried.push(vaultVoiceDir);
    if (existsSync(vaultVoiceDir)) return { ok: true, path: vaultVoiceDir, scope: "vault" };
  }

  const globalVoiceDir = join(globalVoicesDir(env), trimmed);
  tried.push(globalVoiceDir);
  if (existsSync(globalVoiceDir)) return { ok: true, path: globalVoiceDir, scope: "global" };

  return refuse(`pablo: no voice "${trimmed}" (looked in ${tried.join(", ")})`, tried);
}

/** The assembled voice, in the shape a pack draws from. */
export interface Voice {
  readonly name: string;
  readonly rules: readonly TextSource[];
  readonly exemplars: readonly TextSource[];
  readonly never?: TextSource;
  readonly model?: string;
}

/** Strips a leading YAML frontmatter block, the same regex `write.ts`'s `chapterTail` uses for a chapter file. */
function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "");
}

/**
 * `voice.md`'s body (frontmatter stripped) as `rules`, plus its `model:`
 * field if present. Not read via core's `readTextSource` — that reads a file
 * verbatim, and `voice.md`'s leading frontmatter is metadata for pablo, never
 * prose for a pack, so it always needs stripping before wrapping.
 */
function readVoiceMd(voiceDir: string): { readonly model?: string; readonly rules: readonly TextSource[] } {
  const voiceMdPath = join(voiceDir, "voice.md");
  if (!existsSync(voiceMdPath)) return { rules: [] };

  const raw = readFileSync(voiceMdPath, "utf8");
  const frontmatter = parseFrontmatter(raw);
  const body = stripFrontmatter(raw).trim();
  const rules: readonly TextSource[] = body === "" ? [] : [{ path: "voice.md", text: body }];
  return { model: frontmatter["model"], rules };
}

/**
 * Reads whichever `resolveVoice` returned: a single `.md` file (a one-off
 * voice), the `fiction` alias (`<vault>/style/`), or a voice directory.
 *
 * The `fiction` case is detected structurally, not by trusting the caller: a
 * directory named `style` with no `voice.md` in it is the fiction alias (real
 * vaults never put a `voice.md` inside `style/`); a directory named `style`
 * that DOES have a `voice.md` is an ordinary (if confusingly named) scaffolded
 * voice, e.g. one created by `pablo voice new style --global`.
 */
export function readVoice(voicePath: string): Voice {
  if (!existsSync(voicePath)) {
    return { name: basename(voicePath), rules: [], exemplars: [] };
  }

  if (!statSync(voicePath).isDirectory()) {
    // A one-off `.md` file: the whole (frontmatter-stripped) file is the voice.
    const raw = readFileSync(voicePath, "utf8");
    const frontmatter = parseFrontmatter(raw);
    const body = stripFrontmatter(raw).trim();
    return {
      name: basename(voicePath).replace(/\.md$/, ""),
      rules: body === "" ? [] : [{ path: basename(voicePath), text: body }],
      exemplars: [],
      model: frontmatter["model"],
    };
  }

  if (basename(voicePath) === "style" && !existsSync(join(voicePath, "voice.md"))) {
    const vaultRoot = dirname(voicePath);
    return { name: "fiction", rules: readStyle(vaultRoot), exemplars: [] };
  }

  const name = basename(voicePath);
  const { model, rules } = readVoiceMd(voicePath);

  const exemplarsDir = join(voicePath, "exemplars");
  const exemplars: TextSource[] = [];
  if (existsSync(exemplarsDir)) {
    const files = readdirSync(exemplarsDir)
      .filter((entry) => entry.endsWith(".md"))
      .sort()
      .reverse(); // newest first by filename
    for (const file of files) {
      const source = readTextSource(voicePath, join(exemplarsDir, file));
      if (source) exemplars.push(source);
    }
  }

  const never = readTextSource(voicePath, join(voicePath, "never.md"));

  return { name, rules, exemplars, never, model };
}

const VOICE_TEMPLATE = `# Voice: {{NAME}}

## Who is speaking

(who this voice belongs to — a person, a brand, a persona)

## To whom

(the audience this voice addresses)

## Register

(formal or casual; short or long sentences; first, second, or third person —
the shape of the prose, not its topic)

## Do

- (a rule this voice follows)

## Don't

- (a move this voice never makes)

## Flagged

Flagged: "(a real rejected sentence, verbatim — the best documentation a
voice can have)"
`;

export interface VoiceScaffolded {
  readonly ok: true;
  readonly path: string;
  readonly scope: "vault" | "global";
  readonly committed: boolean;
  readonly notice?: string;
}

export type ScaffoldResult = VoiceScaffolded | Refusal;

/**
 * `pablo voice new <name> [--global]`: scaffolds `voice.md` and
 * `exemplars/.keep` under `<vault>/voices/<name>/` (or the global voices
 * directory, with `--global` or when no vault resolves from `cwd`). Refuses
 * (exit 2) on an invalid name or an existing voice. Writing into a resolved
 * vault commits the created files the way `initNovel` does; a global-scope
 * scaffold never commits (there is no vault git repo to commit into).
 */
export function scaffoldVoice(
  name: string,
  opts: { readonly cwd: string; readonly env?: Record<string, string | undefined>; readonly global?: boolean },
): ScaffoldResult {
  if (!SLUG_PATTERN.test(name)) {
    return refuse(
      `pablo: voice new: invalid name "${name}" (only lowercase letters, digits, and hyphens are allowed)`,
      [],
    );
  }

  const env = opts.env ?? process.env;

  let scope: "vault" | "global" = "global";
  let voicesRoot = globalVoicesDir(env);
  let vaultRoot: string | undefined;

  if (!opts.global) {
    const vaultResult = findVault(opts.cwd, env);
    if (vaultResult.ok) {
      scope = "vault";
      vaultRoot = vaultResult.path;
      voicesRoot = join(vaultResult.path, "voices");
    }
  }

  const dest = join(voicesRoot, name);
  if (existsSync(dest)) {
    return refuse(`pablo: voice new: ${dest} already exists`, [dest]);
  }

  mkdirSync(join(dest, "exemplars"), { recursive: true });
  const voiceMdPath = join(dest, "voice.md");
  const keepPath = join(dest, "exemplars", ".keep");
  writeFileSync(voiceMdPath, VOICE_TEMPLATE.split("{{NAME}}").join(name), "utf8");
  writeFileSync(keepPath, "", "utf8");

  if (scope === "vault" && vaultRoot !== undefined) {
    const { committed, notice } = gitCommit(vaultRoot, `voice: create ${name}`, [voiceMdPath, keepPath]);
    return { ok: true, path: dest, scope, committed, ...(notice ? { notice } : {}) };
  }

  return { ok: true, path: dest, scope, committed: false };
}

/** One voice as `voice list` reports it. */
export interface VoiceListing {
  readonly name: string;
  readonly scope: VoiceScope;
  readonly path: string;
}

function listNamedVoices(dir: string, scope: "vault" | "global"): VoiceListing[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, scope, path: join(dir, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every voice pablo can find from `cwd`: the `fiction` alias (if the vault
 * has a `style/` directory), every `<vault>/voices/<name>/`, and every
 * global `voices/<name>/` — in that order.
 */
export function listVoices(opts: {
  readonly cwd: string;
  readonly env?: Record<string, string | undefined>;
}): readonly VoiceListing[] {
  const env = opts.env ?? process.env;
  const listings: VoiceListing[] = [];

  const vaultResult = findVault(opts.cwd, env);
  if (vaultResult.ok) {
    const styleDir = join(vaultResult.path, "style");
    if (existsSync(styleDir)) listings.push({ name: "fiction", scope: "fiction", path: styleDir });
    listings.push(...listNamedVoices(join(vaultResult.path, "voices"), "vault"));
  }

  listings.push(...listNamedVoices(globalVoicesDir(env), "global"));

  return listings;
}
