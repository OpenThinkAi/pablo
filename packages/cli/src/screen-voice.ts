// `a v` on the screen (AGT-1547): the selected sentences become a flagged line (a rejected tell) or an exemplar (kept)
// in the project's voice, through the same `flagLine` / `addExemplar` the `voice flag` / `voice exemplar` verbs call. The
// tui cannot import this package, so cli.ts passes the function in through runScreen's options (like `screenWriter`).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { addExemplar, flagLine, resolveVoice } from "./voice";

export type VoiceKind = "flag" | "exemplar";
/** What the screen gets back: lines for the content area saying where it was written, or why it was not. */
export type ScreenVoiceResult =
  | { readonly ok: true; readonly lines: readonly string[] }
  | { readonly ok: false; readonly message: string };
export type ScreenVoicer = (kind: VoiceKind, sentences: readonly string[]) => Promise<ScreenVoiceResult>;

/**
 * The voice a project writes in, by name: the `voices/<name>` its `pablo.json` `voice` list points into, else `fiction`
 * (the vault's `style/`, which every novel's list names by default).
 */
export function projectVoiceName(vaultRoot: string, projectPath: string): string {
  let entries: unknown;
  try {
    entries = (JSON.parse(readFileSync(join(projectPath, "pablo.json"), "utf8")) as { voice?: unknown }).voice;
  } catch {
    return "fiction";
  }
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry !== "string") continue;
    const parts = relative(join(vaultRoot, "voices"), resolve(projectPath, entry)).split(sep);
    if (parts[0] !== undefined && parts[0] !== ".." && parts[0] !== "") return parts[0];
  }
  return "fiction";
}

/** `<first words>` of the text as an exemplar's title: the file is named from it. */
const titleOf = (text: string) => text.split(/\s+/).slice(0, 6).join(" ").replace(/[^\p{L}\p{N} '-]/gu, "").trim() || "exemplar";

export function screenVoicer(vaultRoot: string, projectPath: string, deps: { env?: Record<string, string | undefined>; now?: () => Date } = {}): ScreenVoicer {
  return async (kind, sentences) => {
    const text = sentences.join(" ").trim();
    if (text === "") return { ok: false, message: "Nothing is selected." };
    const env = deps.env ?? process.env;
    const name = projectVoiceName(vaultRoot, projectPath);
    const located = resolveVoice(name, { cwd: projectPath, env });
    if (!located.ok) return { ok: false, message: located.message };
    const shown = (path: string) => (path.startsWith(vaultRoot + sep) ? relative(vaultRoot, path) : path);

    if (kind === "flag") {
      const r = flagLine(located, text);
      if (!r.ok) return { ok: false, message: r.message };
      const where = shown(r.path);
      if (r.notice?.includes("already flagged")) return { ok: true, lines: [r.notice] };
      return { ok: true, lines: [`Flagged in ${where} (voice ${name})${r.committed ? ", committed" : ""}.`, `Flagged: "${text}"`, ...(r.notice ? [r.notice] : [])] };
    }

    // An exemplar is a piece copied verbatim from a file: the selection goes through a temporary one, outside the vault.
    const dir = mkdtempSync(join(tmpdir(), "pablo-exemplar-"));
    try {
      const file = join(dir, "exemplar.md");
      writeFileSync(file, `${text}\n`, "utf8");
      const r = addExemplar(located, file, { title: titleOf(text), ...(deps.now ? { now: deps.now } : {}) });
      if (!r.ok) return { ok: false, message: located.scope === "fiction" ? `${r.message} Flag it instead, or give the project a voices/<name> voice.` : r.message };
      return { ok: true, lines: [`Kept as an exemplar in ${shown(r.path)} (voice ${name})${r.committed ? ", committed" : ""}.`, text, ...(r.notice ? [r.notice] : [])] };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
