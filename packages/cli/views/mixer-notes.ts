/**
 * Mixer markers (AGT-1792): notes dropped at the playhead while listening, as pure functions so `bun test`
 * checks them without a browser, and so the host (which writes `renders/epNN/notes.json` and the punch list)
 * and the view share one definition. No IO here.
 *
 * A marker records the time, **everything sounding there** (a dialogue line with speaker and text, any SFX /
 * BED / MUSIC clip with its cue description and key), a free-text note and an optional category. The sounding
 * snapshot is stored with the marker, so the punch list stays readable after the mix moves on.
 */

import type { ManifestCue, ManifestLine, MixPayload, TrackName } from "./mixer-protocol";
import type { PlacedClip } from "./mixer-logic";

/** Matt's three keys: f = clipped, s = sound effect, g = general comment (m is an alias for g). */
export const CATEGORIES = ["clipped", "sound effect", "general"] as const;
export type Category = (typeof CATEGORIES)[number];

export const KEY_CATEGORY: Readonly<Record<string, Category>> = { f: "clipped", s: "sound effect", g: "general", m: "general" };
export const CATEGORY_LETTER: Readonly<Record<Category, string>> = { clipped: "F", "sound effect": "S", general: "G" };

/** Only a clipped dialogue marker becomes a flag: the review player's `clipped` reason. */
export const FLAG_REASONS = ["clipped"] as const;

/** One thing sounding at a marker. */
export interface Sounding {
  readonly track: TrackName;
  readonly clip: string;
  /** "LINE" for dialogue, else the cue's kind. */
  readonly kind: "LINE" | "SFX" | "BED" | "MUSIC";
  /** Dialogue: the line sounding at the marker (the clip's first line when the manifest has no timing for it). */
  readonly line?: number;
  readonly speaker?: string;
  readonly text?: string;
  /** Cue clips: the manifest cue index, its description and the cue-library key. */
  readonly cue?: number;
  readonly desc?: string;
  readonly key?: string;
}

export interface Marker {
  readonly id: string;
  /** Seconds into the mixed episode, to 10 ms. */
  readonly time: number;
  readonly mix_version: number;
  readonly sounding: readonly Sounding[];
  readonly category: Category | null;
  readonly note: string;
  readonly created: string;
  readonly updated: string;
}

export interface NotesFile {
  readonly schema: 1;
  readonly episode: number;
  readonly notes: readonly Marker[];
}

export const roundTime = (seconds: number): number => Math.round(Math.max(0, seconds) * 100) / 100;

/** What is sounding at `t`: every placed clip whose `[start, end)` holds it, dialogue first (track order). */
export function soundingAt(manifest: Pick<MixPayload["manifest"], "lines" | "cues">, placed: readonly PlacedClip[], t: number): Sounding[] {
  const out: Sounding[] = [];
  const order: TrackName[] = ["dialogue", "sfx", "beds", "music"];
  const lines = new Map<number, ManifestLine>(manifest.lines.map((l) => [l.i, l]));
  const cues = new Map<number, ManifestCue>(manifest.cues.map((c) => [c.index, c]));
  for (const track of order) {
    for (const p of placed) {
      if (p.track !== track || !(p.startSeconds <= t && t < p.endSeconds)) continue;
      const clip = p.clip;
      if (track === "dialogue") {
        const ids = clip.lines ?? [];
        const timed = ids.find((i) => {
          const l = lines.get(i);
          return l !== undefined && l.start !== null && l.end !== null && l.start <= t && t < l.end;
        });
        const line = timed ?? ids[0];
        const row = line === undefined ? undefined : lines.get(line);
        out.push({ track, clip: clip.id, kind: "LINE", ...(line === undefined ? {} : { line }), ...(row === undefined ? {} : { speaker: row.speaker, text: row.text }) });
      } else {
        const cue = clip.cue === undefined ? undefined : cues.get(clip.cue);
        const kind = cue?.kind ?? (track === "sfx" ? "SFX" : track === "beds" ? "BED" : "MUSIC");
        out.push({
          track,
          clip: clip.id,
          kind,
          ...(clip.cue === undefined ? {} : { cue: clip.cue }),
          ...(cue === undefined ? {} : { desc: cue.desc }),
          ...(clip.source.kind === "cue" ? { key: clip.source.key } : {}),
        });
      }
    }
  }
  return out;
}

/** A new marker at `t`. `id` and `now` are passed in so the function stays pure. */
export function newMarker(args: { id: string; t: number; mixVersion: number; manifest: Pick<MixPayload["manifest"], "lines" | "cues">; placed: readonly PlacedClip[]; now: string; category?: Category | null }): Marker {
  const time = roundTime(args.t);
  return { id: args.id, time, mix_version: args.mixVersion, sounding: soundingAt(args.manifest, args.placed, time), category: args.category ?? null, note: "", created: args.now, updated: args.now };
}

/** A marker id unique among `existing`: `m1`, `m2`, ... after the highest taken. */
export function nextMarkerId(existing: readonly Pick<Marker, "id">[]): string {
  let top = 0;
  for (const m of existing) {
    const n = /^m(\d+)$/.exec(m.id)?.[1];
    if (n !== undefined) top = Math.max(top, Number(n));
  }
  return `m${top + 1}`;
}

/** Insert or replace by id, kept in time order. */
export function upsertMarker(markers: readonly Marker[], marker: Marker): Marker[] {
  return [...markers.filter((m) => m.id !== marker.id), marker].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id, "en", { numeric: true }));
}

export const removeMarker = (markers: readonly Marker[], id: string): Marker[] => markers.filter((m) => m.id !== id);

/** The marker nearest at or after `t` (the next one), or before it; null when there are none. */
export function stepMarker(markers: readonly Marker[], t: number, dir: 1 | -1): Marker | null {
  const eps = 0.005;
  if (dir === 1) return markers.find((m) => m.time > t + eps) ?? null;
  return [...markers].reverse().find((m) => m.time < t - eps) ?? null;
}

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}

/** `mm:ss` (minutes may pass 59). */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds + 1e-6));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** What a marker says is playing, one phrase per thing. */
export function describeSounding(s: Sounding): string {
  if (s.kind === "LINE") {
    const who = s.speaker === undefined ? "" : ` ${s.speaker}`;
    const text = s.text === undefined ? "" : `: "${s.text}"`;
    return `Line ${s.line ?? "?"}${who}${text}`;
  }
  const key = s.key === undefined ? "" : `, key ${s.key.slice(0, 12)}`;
  const cue = s.cue === undefined ? "" : `cue ${s.cue}`;
  const detail = [cue, key.slice(2)].filter((x) => x !== "").join(", ");
  return `${s.kind}: ${s.desc ?? s.clip}${detail === "" ? "" : ` (${detail})`}`;
}

/** The punch list: markdown, one numbered section per marker in time order. */
export function punchList(args: { title: string; episode: number; episodeTitle: string; markers: readonly Marker[]; exported: string }): string {
  const markers = [...args.markers].sort((a, b) => a.time - b.time);
  const lines: string[] = [`# Punch list: ${args.title}, episode ${args.episode}: ${args.episodeTitle}`, ""];
  lines.push(`${markers.length} ${markers.length === 1 ? "note" : "notes"} · exported ${args.exported}`, "");
  if (markers.length === 0) lines.push("No notes yet.", "");
  markers.forEach((m, k) => {
    lines.push(`## ${k + 1}. ${mmss(m.time)}${m.category === null ? "" : ` · ${m.category}`}`, "");
    lines.push(m.note.trim() === "" ? "_(no note)_" : m.note.trim(), "");
    lines.push(`- At ${m.time.toFixed(2)} s (mix v${m.mix_version})`);
    if (m.sounding.length === 0) lines.push("- Playing: silence");
    for (const s of m.sounding) lines.push(`- Playing: ${describeSounding(s)}`);
    lines.push("");
  });
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/** The flag a clipped dialogue marker becomes; null for any other marker. */
export interface FlagDraft {
  readonly episode: number;
  readonly line: number;
  readonly reason: (typeof FLAG_REASONS)[number];
  readonly time: number;
}

export function flagDraft(marker: Marker, episode: number): FlagDraft | null {
  if (marker.category !== "clipped") return null;
  const dialogue = marker.sounding.find((s) => s.kind === "LINE" && s.line !== undefined);
  if (dialogue === undefined || dialogue.line === undefined) return null;
  return { episode, line: dialogue.line, reason: "clipped", time: marker.time };
}

/** What was playing, in one short phrase for a marker row: the line (speaker and text) or else the cue. */
export function playingSummary(marker: Marker): string {
  const line = marker.sounding.find((s) => s.kind === "LINE");
  if (line !== undefined) return `${line.speaker ?? `line ${line.line ?? "?"}`}${line.text === undefined ? "" : `: ${line.text}`}`;
  const cue = marker.sounding[0];
  return cue === undefined ? "silence" : `${cue.kind} ${cue.desc ?? cue.clip}`;
}
