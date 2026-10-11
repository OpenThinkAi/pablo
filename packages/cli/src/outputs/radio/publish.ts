/**
 * The radio output's publish targets (AGT-1686):
 *
 *   bundle   one directory, `.pablo/out/<slug>-radio-bundle/`, holding every
 *            episode's script and, for each episode with a mixed version, its
 *            newest mixed audio (`epNN.m4a`) and that version's manifest
 *            (`epNN.json`), with `bundle.json` listing them in order. An
 *            episode with no mixed version is listed with its script only and
 *            named in the outcome's notes, so a bundle is the show as far as
 *            it is rendered. Re-publishing replaces the directory's files.
 *   player   the review player: `pablo review --project <slug>` (a window,
 *            not a file), so the target is a refusal naming it.
 *   stream   the progressive render (pablo-casting C19), not built yet.
 *
 * The audio and manifests are copied, never moved: the casting directory is
 * the Python side's and stays as it was.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { stripFrontmatter } from "../../publish";
import type { PublishOutcome } from "../types";
import { radioUnitFiles } from "./plan";
import { renderVersions } from "./state";
import { episodeTag, RADIO_PUBLISH_TARGETS } from "./units";

function refuse(message: string, tried: readonly string[] = []): PublishOutcome {
  return { ok: false, code: 2, message, tried };
}

/** One episode's row in `bundle.json`. */
interface BundleEpisode {
  readonly episode: number;
  readonly script: string;
  readonly audio: string | null;
  readonly manifest: string | null;
  readonly version: number | null;
}

/** The bundle's directory for a work, absolute. */
export function bundleDir(workDir: string, slug: string): string {
  return join(workDir, ".pablo", "out", `${slug}-radio-bundle`);
}

function publishBundle(workDir: string, slug: string, title: string): PublishOutcome {
  const scripts = radioUnitFiles(workDir);
  if (scripts.size === 0) return refuse("pablo: publish: the radio output has no episodes to bundle (pablo write --output radio --unit 1)", [join(workDir, "outputs", "radio", "episodes")]);
  const outDir = join(workDir, ".pablo", "out");
  const where = bundleDir(workDir, slug);
  if (!where.startsWith(outDir + sep)) return refuse(`pablo: publish: marker slug "${slug}" would write outside ${outDir}`);
  mkdirSync(join(where, "scripts"), { recursive: true });
  // A re-publish is the current show: files from an earlier bundle are replaced, never left stale beside it.
  for (const name of readdirSync(where)) if (name !== "scripts") rmSync(join(where, name), { force: true, recursive: true });
  for (const name of readdirSync(join(where, "scripts"))) rmSync(join(where, "scripts", name), { force: true });

  const episodes: BundleEpisode[] = [];
  const notes: string[] = [];
  const files: string[] = [];
  let words = 0;
  for (const [episode, script] of [...scripts.entries()].sort((a, b) => a[0] - b[0])) {
    const scriptName = `scripts/${basename(script)}`;
    copyFileSync(script, join(where, scriptName));
    files.push(scriptName);
    words += stripFrontmatter(readFileSync(script, "utf8")).split(/\s+/).filter((w) => w !== "").length;
    const mixed = renderVersions(workDir, episode).filter((v) => v.audio !== undefined).at(-1);
    if (mixed?.audio === undefined) {
      notes.push(`episode ${episode} has no mixed audio yet (pablo perform, then pablo mix): script only`);
      episodes.push({ episode, script: scriptName, audio: null, manifest: null, version: null });
      continue;
    }
    const tag = episodeTag(episode);
    const ext = mixed.audio.slice(mixed.audio.lastIndexOf("."));
    copyFileSync(mixed.audio, join(where, `${tag}${ext}`));
    copyFileSync(mixed.manifest, join(where, `${tag}.json`));
    files.push(`${tag}${ext}`, `${tag}.json`);
    episodes.push({ episode, script: scriptName, audio: `${tag}${ext}`, manifest: `${tag}.json`, version: mixed.version });
  }
  writeFileSync(join(where, "bundle.json"), `${JSON.stringify({ title, slug, output: "radio", episodes }, null, 2)}\n`, "utf8");
  files.push("bundle.json");
  return { ok: true, code: 0, target: "bundle", where, chapters: episodes.length, words, files, ...(notes.length > 0 ? { notes } : {}) };
}

/** `OUTPUTS.radio.publish.run`. */
export function publishRadio(workDir: string, slug: string, title: string, target: string | undefined): PublishOutcome {
  if (target === undefined) return refuse(`pablo: publish requires --target (${RADIO_PUBLISH_TARGETS.join("|")})`);
  if (!(RADIO_PUBLISH_TARGETS as readonly string[]).includes(target)) {
    return refuse(`pablo: publish: unknown --target "${target}" for the radio output (expected ${RADIO_PUBLISH_TARGETS.join("|")})`);
  }
  if (target === "player") return refuse(`pablo: publish: the radio output's player is the review player; open it with \`pablo review --project ${slug}\``);
  if (target === "stream") return refuse("pablo: publish: the stream target (episodes published as they render) is not built yet; use --target bundle");
  if (!existsSync(workDir)) return refuse(`pablo: publish: no work at ${workDir}`, [workDir]);
  return publishBundle(workDir, slug, title);
}
