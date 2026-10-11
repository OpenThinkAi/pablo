/**
 * The mixer's editing model (AGT-1769, `pm project show pablo-mixer`, "Clips" and "The mixer view"): every edit
 * the window makes to a mix document, as pure functions from a document to the next one, plus the in-session
 * undo/redo history and what a save sends. Nothing here draws or plays; `mixer.tsx` turns mouse and keys into
 * these calls, and `mixer-logic.ts` places and plays whatever document comes out.
 *
 *  - **Move.** `moveClip` re-anchors a clip to the line edge (a line's start or end) nearest where it was dropped,
 *    snapping onto the edge when it is close, so the clip rides along when that line moves. A free move (Alt) keeps
 *    the clip's anchor and changes only its offset. A clip is never anchored to a line whose position depends on
 *    the clip itself (its own lines, or lines voiced by clips anchored, through others, to it): that is a cycle.
 *  - **Trim.** `trimIn` / `trimOut` move a clip's `in` / `out` within its source (the audio under the clip stays
 *    where it is: trimming the head moves the clip's start with it); fades shrink to fit.
 *  - **Split.** `splitClip` cuts a clip at a timeline second into two clips over the same source: the left keeps
 *    the fade-in, the right keeps the fade-out and rides on the same anchor (a later offset), so the two halves
 *    play exactly what the one did.
 *  - **Fades, gain, tracks.** `setFade` (length and curve), `setGain`, `setTrack` (volume, mute, solo: saved).
 *  - **History.** `editReducer` keeps the document, what it was saved (or loaded) as, and undo/redo stacks; a
 *    gesture (a drag, a slider) is one undo step however many moves it makes.
 *
 * Every function returns the same document object when the edit changes nothing.
 */

import { placeClips, samples, SR, TRACK_ORDER, VOLUME_MAX_DB, VOLUME_MIN_DB } from "./mixer-logic";
import type { Placement } from "./mixer-logic";
import type { FadeCurve, ManifestLine, MixAnchor, MixClip, MixDocument, MixFade, MixProposal, MixTrack, TrackName } from "./mixer-protocol";

/** The shortest clip a trim leaves. */
export const MIN_CLIP_SECONDS = 0.02;
export const GAIN_MIN_DB = -60;
export const GAIN_MAX_DB = 12;
export const CURVES: readonly FadeCurve[] = ["linear", "scurve", "log", "exp"];

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

export interface Located {
  readonly track: TrackName;
  readonly lane: string;
  readonly index: number;
  readonly clip: MixClip;
}

/** Where clip `id` lives in the document. */
export function findClip(doc: MixDocument, id: string): Located | undefined {
  for (const track of TRACK_ORDER) {
    for (const [lane, body] of Object.entries(doc.tracks[track]?.lanes ?? {})) {
      const index = body.clips.findIndex((c) => c.id === id);
      if (index >= 0) return { track, lane, index, clip: body.clips[index] as MixClip };
    }
  }
  return undefined;
}

/** The document with clip `id` replaced by `next` (one clip, or several in its place). Unchanged: the same object. */
function replaceClip(doc: MixDocument, id: string, next: (clip: MixClip) => MixClip | readonly MixClip[]): MixDocument {
  const at = findClip(doc, id);
  if (at === undefined) return doc;
  const out = next(at.clip);
  const list = Array.isArray(out) ? (out as readonly MixClip[]) : [out as MixClip];
  if (list.length === 1 && JSON.stringify(list[0]) === JSON.stringify(at.clip)) return doc;
  const track = doc.tracks[at.track];
  const clips = [...(track.lanes[at.lane]?.clips ?? [])];
  clips.splice(at.index, 1, ...list);
  return { ...doc, tracks: { ...doc.tracks, [at.track]: { ...track, lanes: { ...track.lanes, [at.lane]: { ...track.lanes[at.lane], clips } } } } };
}

/** The anchor moved `d` seconds later (an `{at}` never before 0). */
export function shiftAnchor(anchor: MixAnchor, d: number): MixAnchor {
  if ("at" in anchor) return { at: round6(Math.max(0, anchor.at + d)) };
  return { ...anchor, offset: round6((anchor.offset ?? 0) + d) };
}

// ---------------------------------------------------------------------------
// Line edges and the anchor graph
// ---------------------------------------------------------------------------

export interface LineEdge {
  readonly line: number;
  readonly edge: "start" | "end";
  /** Seconds on the timeline. */
  readonly t: number;
}

/** Every voiced line's start and end on the timeline (the earliest start / latest end of the clips voicing it). */
export function lineEdges(placement: Placement): LineEdge[] {
  const span = new Map<number, { start: number; end: number }>();
  for (const p of placement.placed) {
    if (p.track !== "dialogue") continue;
    for (const line of p.clip.lines ?? []) {
      const s = span.get(line);
      span.set(line, s === undefined ? { start: p.start, end: p.end } : { start: Math.min(s.start, p.start), end: Math.max(s.end, p.end) });
    }
  }
  return [...span.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([line, s]) => [
      { line, edge: "start" as const, t: s.start / SR },
      { line, edge: "end" as const, t: s.end / SR },
    ]);
}

/** Clip `id` and every clip whose place depends on it (anchored to a line it voices, through any chain). */
export function riders(doc: MixDocument, id: string): Set<string> {
  const all = TRACK_ORDER.flatMap((t) => Object.values(doc.tracks[t]?.lanes ?? {}).flatMap((l) => l.clips));
  const group = new Set([id]);
  const lines = new Set<number>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of all) if (group.has(c.id)) for (const l of c.lines ?? []) lines.add(l);
    for (const c of all) {
      if (!group.has(c.id) && "line" in c.anchor && lines.has(c.anchor.line)) {
        group.add(c.id);
        grew = true;
      }
    }
  }
  return group;
}

/** The lines clip `id` may anchor to: every voiced line whose position does not depend on the clip. */
export function anchorableLines(doc: MixDocument, id: string): Set<number> {
  const group = riders(doc, id);
  const banned = new Set<number>();
  for (const t of TRACK_ORDER) for (const l of Object.values(doc.tracks[t]?.lanes ?? {})) for (const c of l.clips) if (group.has(c.id)) for (const n of c.lines ?? []) banned.add(n);
  const ok = new Set<number>();
  for (const t of TRACK_ORDER) for (const l of Object.values(doc.tracks[t]?.lanes ?? {})) for (const c of l.clips) for (const n of c.lines ?? []) if (!banned.has(n)) ok.add(n);
  return ok;
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

export interface MoveOptions {
  /** Alt: keep the anchor, change only its offset (no re-anchoring, no snapping). */
  readonly free?: boolean;
  /** Within this many seconds of a line edge the clip snaps onto it (offset 0). */
  readonly snap?: number;
}

/** Clip `id` moved to start at timeline second `start`: re-anchored to the nearest line edge, or (free) just offset. */
export function moveClip(doc: MixDocument, id: string, start: number, options: MoveOptions = {}): MixDocument {
  const placement = placeClips(doc);
  const p = placement.placed.find((q) => q.clip.id === id);
  if (p === undefined) return doc;
  const to = Math.max(0, start);
  if (options.free === true) {
    const d = to - p.startSeconds;
    return replaceClip(doc, id, (c) => ({ ...c, anchor: "at" in c.anchor ? { at: round6(to) } : shiftAnchor(c.anchor, d) }));
  }
  const allowed = anchorableLines(doc, id);
  let best: LineEdge | undefined;
  for (const e of lineEdges(placement)) {
    if (!allowed.has(e.line)) continue;
    if (best === undefined || Math.abs(e.t - to) < Math.abs(best.t - to)) best = e;
  }
  const snap = options.snap ?? 0;
  const anchor: MixAnchor =
    best === undefined ? { at: round6(to) } : { line: best.line, edge: best.edge, offset: Math.abs(best.t - to) <= snap ? 0 : round6(to - best.t) };
  return replaceClip(doc, id, (c) => ({ ...c, anchor }));
}

/** A clip's fades shortened (fade-in first when `prefer` is "in", else fade-out) to fit its length. */
function fitFades(clip: MixClip, prefer: "in" | "out"): MixClip {
  const length = clip.out - clip.in;
  let fin = clip.fade_in?.len ?? 0;
  let fout = clip.fade_out?.len ?? 0;
  if (fin + fout <= length + 1e-9) return clip;
  if (prefer === "in") {
    fin = Math.max(0, length - fout);
    fout = Math.min(fout, length - fin);
  } else {
    fout = Math.max(0, length - fin);
    fin = Math.min(fin, length - fout);
  }
  return {
    ...clip,
    ...(clip.fade_in === undefined ? {} : { fade_in: { ...clip.fade_in, len: round6(fin) } }),
    ...(clip.fade_out === undefined ? {} : { fade_out: { ...clip.fade_out, len: round6(fout) } }),
  };
}

/** The head of clip `id` trimmed by `d` seconds (positive: shorter): `in` and the clip's start move together. */
export function trimIn(doc: MixDocument, id: string, d: number): MixDocument {
  const placement = placeClips(doc);
  const p = placement.placed.find((q) => q.clip.id === id);
  if (p === undefined) return doc;
  return replaceClip(doc, id, (c) => {
    const step = round6(clamp(d, Math.max(-c.in, -p.startSeconds), c.out - c.in - MIN_CLIP_SECONDS));
    if (step === 0) return c;
    return fitFades({ ...c, in: round6(c.in + step), anchor: shiftAnchor(c.anchor, step) }, "in");
  });
}

/** The tail of clip `id` moved by `d` seconds (positive: longer), never past the end of its source. */
export function trimOut(doc: MixDocument, id: string, d: number, sourceSeconds = Number.POSITIVE_INFINITY): MixDocument {
  return replaceClip(doc, id, (c) => {
    const out = round6(clamp(c.out + d, c.in + MIN_CLIP_SECONDS, Math.max(c.out, sourceSeconds)));
    return out === c.out ? c : fitFades({ ...c, out }, "out");
  });
}

/** An id no clip of the document has, from `id`'s root: `bed-a` -> `bed-a.2`, `bed-a.3`, ... */
export function freshId(doc: MixDocument, id: string): string {
  const used = new Set(TRACK_ORDER.flatMap((t) => Object.values(doc.tracks[t]?.lanes ?? {}).flatMap((l) => l.clips.map((c) => c.id))));
  const root = id.replace(/\.\d+$/, "");
  for (let n = 2; ; n++) if (!used.has(`${root}.${n}`)) return `${root}.${n}`;
}

/**
 * Clip `id` cut at timeline second `t` into two clips over the same source. The left half keeps the fade-in, the
 * right half keeps the fade-out and is anchored where the clip was, `t - start` later. Unchanged when `t` is not
 * inside the clip (at least `MIN_CLIP_SECONDS` from either edge).
 */
export function splitClip(doc: MixDocument, id: string, t: number): MixDocument {
  const p = placeClips(doc).placed.find((q) => q.clip.id === id);
  if (p === undefined) return doc;
  const cut = samples(t) - p.start; // samples into the clip
  if (cut < samples(MIN_CLIP_SECONDS) || p.length - cut < samples(MIN_CLIP_SECONDS)) return doc;
  const d = cut / SR;
  const right = freshId(doc, id);
  return replaceClip(doc, id, (c) => {
    const at = (samples(c.in) + cut) / SR; // the cut, on the sample grid of the source
    const { fade_out: _out, ...head } = c;
    const { fade_in: _in, ...tail } = c;
    const left: MixClip = fitFades({ ...head, out: at }, "in");
    const after: MixClip = fitFades({ ...tail, id: right, in: at, anchor: "at" in c.anchor ? { at: c.anchor.at + d } : { ...c.anchor, offset: (c.anchor.offset ?? 0) + d } }, "out");
    return [left, after];
  });
}

/** Clip `id`'s fade-in or fade-out: a new length (clamped to what the other fade leaves) and/or curve. */
export function setFade(doc: MixDocument, id: string, which: "in" | "out", change: { readonly len?: number; readonly curve?: FadeCurve }): MixDocument {
  return replaceClip(doc, id, (c) => {
    const key = which === "in" ? "fade_in" : "fade_out";
    const other = (which === "in" ? c.fade_out : c.fade_in)?.len ?? 0;
    const was: MixFade = c[key] ?? { len: 0, curve: "linear" };
    const len = change.len === undefined ? was.len : round6(clamp(change.len, 0, Math.max(0, c.out - c.in - other)));
    const curve = change.curve ?? was.curve ?? "linear";
    if (c[key] === undefined && len === 0 && change.curve === undefined) return c;
    return { ...c, [key]: { len, curve } };
  });
}

/** Clip `id`'s gain in dB (to a tenth, within `GAIN_MIN_DB`..`GAIN_MAX_DB`). */
export function setGain(doc: MixDocument, id: string, db: number): MixDocument {
  if (!Number.isFinite(db)) return doc;
  return replaceClip(doc, id, (c) => ({ ...c, gain: Math.round(clamp(db, GAIN_MIN_DB, GAIN_MAX_DB) * 10) / 10 }));
}

/** A track's volume (dB), mute or solo, as the saved document carries them. */
export function setTrack(doc: MixDocument, track: TrackName, change: { readonly volume?: number; readonly mute?: boolean; readonly solo?: boolean }): MixDocument {
  const was: MixTrack = doc.tracks[track] ?? { lanes: {} };
  const next: MixTrack = {
    ...was,
    ...(change.volume === undefined || !Number.isFinite(change.volume) ? {} : { volume: clamp(change.volume, VOLUME_MIN_DB, VOLUME_MAX_DB) }),
    ...(change.mute === undefined ? {} : { mute: change.mute }),
    ...(change.solo === undefined ? {} : { solo: change.solo }),
  };
  if ((next.volume ?? 0) === (was.volume ?? 0) && (next.mute ?? false) === (was.mute ?? false) && (next.solo ?? false) === (was.solo ?? false)) return doc;
  return { ...doc, tracks: { ...doc.tracks, [track]: next } };
}

// ---------------------------------------------------------------------------
// Gestures: a drag from a starting document
// ---------------------------------------------------------------------------

export type GestureKind = "move" | "trim-in" | "trim-out" | "fade-in" | "fade-out";

export interface DragOptions {
  /** Alt held: a free move. */
  readonly free?: boolean;
  /** Seconds within which a move snaps onto a line edge. */
  readonly snap?: number;
  /** The length of the clip's source, for trimming the tail. */
  readonly sourceSeconds?: number;
}

/**
 * The document after dragging clip `id`'s body or handle `dx` seconds, from `from` (the document when the drag
 * began: a drag is recomputed from its start on every move, so it never accumulates rounding).
 */
export function dragEdit(from: MixDocument, kind: GestureKind, id: string, dx: number, options: DragOptions = {}): MixDocument {
  const at = findClip(from, id);
  if (at === undefined) return from;
  switch (kind) {
    case "move": {
      const p = placeClips(from).placed.find((q) => q.clip.id === id);
      return p === undefined ? from : moveClip(from, id, p.startSeconds + dx, options);
    }
    case "trim-in":
      return trimIn(from, id, dx);
    case "trim-out":
      return trimOut(from, id, dx, options.sourceSeconds);
    case "fade-in":
      return setFade(from, id, "in", { len: (at.clip.fade_in?.len ?? 0) + dx });
    case "fade-out":
      return setFade(from, id, "out", { len: (at.clip.fade_out?.len ?? 0) - dx });
  }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface Step {
  readonly doc: MixDocument;
  readonly label: string;
}

export interface EditState {
  /** The document as edited. */
  readonly doc: MixDocument;
  /** The document as loaded or last saved: unsaved changes are the difference. */
  readonly saved: MixDocument;
  /** Undo stack: the document before each edit, newest last. */
  readonly past: readonly Step[];
  readonly future: readonly Step[];
  /** The gesture the newest edit belongs to: a further edit of the same gesture replaces it instead of stacking. */
  readonly gesture: string | null;
}

export type EditAction =
  | { readonly type: "load"; readonly doc: MixDocument }
  | { readonly type: "apply"; readonly doc: MixDocument; readonly label: string; readonly gesture?: string }
  | { readonly type: "end-gesture" }
  | { readonly type: "undo" }
  | { readonly type: "redo" }
  | { readonly type: "saved"; readonly doc: MixDocument };

export const HISTORY_LIMIT = 200;

export const initialEdit = (doc: MixDocument): EditState => ({ doc, saved: doc, past: [], future: [], gesture: null });

export function editReducer(state: EditState, action: EditAction): EditState {
  switch (action.type) {
    case "load":
      return initialEdit(action.doc);
    case "apply": {
      if (action.doc === state.doc) return state;
      const gesture = action.gesture ?? null;
      if (gesture !== null && gesture === state.gesture) return { ...state, doc: action.doc, future: [] };
      const past = [...state.past, { doc: state.doc, label: action.label }].slice(-HISTORY_LIMIT);
      return { ...state, doc: action.doc, past, future: [], gesture };
    }
    case "end-gesture":
      return state.gesture === null ? state : { ...state, gesture: null };
    case "undo": {
      const top = state.past[state.past.length - 1];
      if (top === undefined) return state;
      return { ...state, doc: top.doc, past: state.past.slice(0, -1), future: [...state.future, { doc: state.doc, label: top.label }], gesture: null };
    }
    case "redo": {
      const top = state.future[state.future.length - 1];
      if (top === undefined) return state;
      return { ...state, doc: top.doc, future: state.future.slice(0, -1), past: [...state.past, { doc: state.doc, label: top.label }], gesture: null };
    }
    case "saved":
      // History survives a save (undo still works); the saved document carries the new version's fields.
      return { ...state, doc: action.doc, saved: action.doc, gesture: null };
  }
}

/** JSON with sorted keys: two documents that mean the same mix compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}

/** What a save sends: the document's mix, without the fields `saveMix` sets itself. */
export function proposal(doc: MixDocument): MixProposal {
  return { manifest_version: doc.manifest_version, tracks: doc.tracks, master: doc.master };
}

/** True when the edited document differs from the loaded or saved one. */
export const dirty = (state: EditState): boolean => canonical(proposal(state.doc)) !== canonical(proposal(state.saved));

/** `saveMix` refused because the mix moved on since it was loaded (`mixer.py`'s stale refusals). */
export const isStaleRefusal = (message: string): boolean => /is not the newest|was written meanwhile/.test(message);

/** "end of line 4 (CORA) +0.35 s", or "at 1:02.30": where a clip hangs. */
export function anchorText(anchor: MixAnchor, lines: readonly ManifestLine[]): string {
  if ("at" in anchor) return `at ${anchor.at.toFixed(2)} s`;
  const speaker = lines.find((l) => l.i === anchor.line)?.speaker;
  const off = anchor.offset ?? 0;
  return `${anchor.edge} of line ${anchor.line}${speaker === undefined ? "" : ` (${speaker})`}${off === 0 ? "" : ` ${off > 0 ? "+" : "−"}${Math.abs(off).toFixed(2)} s`}`;
}
