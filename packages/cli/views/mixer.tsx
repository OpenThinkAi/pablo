import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ViewProps } from "@openthink/ui-leaf/view";
import type { ClipAudioPayload, MixPayload, MixSource, PeaksPayload, SavedMixPayload, TrackName } from "./mixer-protocol";
import {
  TRACK_ORDER,
  VOLUME_MAX_DB,
  VOLUME_MIN_DB,
  clampZoom,
  clipEnvelope,
  envelopeAt,
  clipLabel,
  clipPeaks,
  distinctSources,
  initialMixer,
  layoutLanes,
  placeClips,
  rulerTicks,
  sourceId,
  timecode,
  timelineSeconds,
  trackAutomation,
  zoomAround,
} from "./mixer-logic";
import type { LaneRow, Mixer, PlacedClip, TrackRows } from "./mixer-logic";
import { MixEngine } from "./mixer-audio";
import { MARKERS_CSS, MarkerPins, MarkersPanel, useMarkers } from "./mixer-markers";
import { dirty, dragEdit, editReducer, initialEdit, isStaleRefusal, moveClip, proposal, setFade, setGain, setTrack, splitClip } from "./mixer-edit";
import type { GestureKind } from "./mixer-edit";
import { INSPECTOR_CSS, Inspector } from "./mixer-inspector";

/**
 * The mixer view (AGT-1768, `pm project show pablo-mixer`, "The mixer view"): an episode's mix document drawn
 * as the fixed tracks (Dialogue one lane per role, SFX, Beds, Music) of clip blocks on a time ruler, each with
 * its source's waveform, a playhead, zoom and scroll, and Web Audio playback of every clip with its gain, fades,
 * same-lane crossfades, track automation and per-track volume/mute/solo (`mixer-audio.ts`).
 *
 * Editing (AGT-1769): drag a clip to move it (it re-anchors to the nearest line edge, snapping onto it; Alt drags
 * a free offset), drag its edges to trim, its top corner handles to fade, split it at the playhead (B), set its
 * gain and fade curves in the inspector, and set track volume/mute/solo; undo/redo in-session; Save writes the
 * next mix version. Every edit is `mixer-edit.ts`'s pure function of the document, and playback picks it up at once.
 * The view never reads a file. It calls four host mutations, `loadMix`, `peaks`, `clipAudio` and `saveMix`
 * (`mixer-protocol.ts`); placement, envelopes and scheduling are `mixer-logic.ts`'s pure functions.
 */

export interface MixerData {
  readonly title: string;
  readonly episode: number;
  /** `--version k`: the mix version to open (the newest when absent). */
  readonly version?: number;
}

const LANE_H = 54;
const TRACK_H = 26;
const RULER_H = 28;
const HEAD_W = 200;
const POOL = 3;
/** A press that moves less than this is a click, not a drag. */
const DRAG_PX = 3;
/** A dragged clip within this many pixels of a line edge snaps onto it. */
const SNAP_PX = 8;
const EMPTY = { tracks: {} } as unknown as MixPayload["document"];

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Runs `work` over `items`, `size` at a time. */
async function pool<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await work(items[next++] as T);
  });
  await Promise.all(runners);
}

function Waveform({ peaks, width, height }: { peaks: readonly number[]; width: number; height: number }) {
  if (peaks.length === 0 || width < 2) return null;
  const columns = Math.max(1, Math.min(peaks.length, Math.floor(width / 2)));
  const per = peaks.length / columns;
  const mid = height / 2;
  let top = "";
  let bottom = "";
  for (let c = 0; c < columns; c++) {
    let m = 0;
    for (let k = Math.floor(c * per); k < Math.max(Math.floor(c * per) + 1, Math.floor((c + 1) * per)); k++) m = Math.max(m, peaks[k] ?? 0);
    const x = ((c + 0.5) / columns) * width;
    const y = Math.max(0.5, m * mid);
    top += `${c === 0 ? "M" : "L"}${x.toFixed(1)},${(mid - y).toFixed(1)}`;
    bottom = `L${x.toFixed(1)},${(mid + y).toFixed(1)}${bottom}`;
  }
  return (
    <svg className="wave" width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={`${top}${bottom}Z`} />
    </svg>
  );
}

/** The clip's gain envelope as a thin line over the block, so fades and crossfades are visible. */
function EnvelopeLine({ members, k, width, height }: { members: readonly PlacedClip[]; k: number; width: number; height: number }) {
  const env = clipEnvelope(members, k);
  if (env.factors.length === 0 || width < 4) return null;
  const n = Math.min(200, Math.max(8, Math.floor(width / 3)));
  let d = "";
  for (let i = 0; i <= n; i++) {
    const j = Math.min(env.length - 1, Math.round((i / n) * env.length));
    const g = env.gain > 0 ? envelopeAt(env, j) / env.gain : 0;
    d += `${i === 0 ? "M" : "L"}${((i / n) * width).toFixed(1)},${(2 + (1 - Math.max(0, Math.min(1, g))) * (height - 4)).toFixed(1)}`;
  }
  return (
    <svg className="env" width={width} height={height} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** Where a press on a clip starts a gesture: its body (move), its edges (trim), or a fade handle. */
type Grab = (e: React.PointerEvent<HTMLElement>, p: PlacedClip, kind: GestureKind) => void;

function Lane({ row, pps, peaks, label, selected, onGrab }: { row: LaneRow; pps: number; peaks: ReadonlyMap<string, PeaksPayload>; label: (p: PlacedClip) => string; selected: string | null; onGrab: Grab }) {
  return (
    <div className={`lane lane-${row.track}`} style={{ height: LANE_H }}>
      {row.clips.map((p, k) => {
        const left = p.startSeconds * pps;
        const width = Math.max(2, (p.endSeconds - p.startSeconds) * pps);
        const pk = peaks.get(sourceId(p.clip.source));
        const slice = pk === undefined ? [] : clipPeaks(pk.peaks, pk.perSecond, p.inSeconds, p.inSeconds + (p.endSeconds - p.startSeconds));
        const gain = p.clip.gain ?? 0;
        const fadeIn = Math.min(width, (p.clip.fade_in?.len ?? 0) * pps);
        const fadeOut = Math.min(width, (p.clip.fade_out?.len ?? 0) * pps);
        return (
          <div
            key={p.field}
            className={`clip${p.clip.id === selected ? " selected" : ""}`}
            style={{ left, width }}
            data-clip={p.clip.id}
            onPointerDown={(e) => onGrab(e, p, "move")}
            title={`${label(p)}\n${timecode(p.startSeconds, true)}–${timecode(p.endSeconds, true)}${gain !== 0 ? `  ${gain > 0 ? "+" : ""}${gain.toFixed(1)} dB` : ""}`}
          >
            <Waveform peaks={slice} width={width} height={LANE_H - 4} />
            <EnvelopeLine members={row.clips} k={k} width={width} height={LANE_H - 4} />
            {width > 28 && <span className="clip-label">{label(p)}</span>}
            <div className="trim trim-in" onPointerDown={(e) => onGrab(e, p, "trim-in")} title="Trim the start" />
            <div className="trim trim-out" onPointerDown={(e) => onGrab(e, p, "trim-out")} title="Trim the end" />
            <div className="fade-handle" style={{ left: Math.max(0, fadeIn - 4) }} onPointerDown={(e) => onGrab(e, p, "fade-in")} title="Fade in" />
            <div className="fade-handle" style={{ left: Math.max(0, width - fadeOut - 4) }} onPointerDown={(e) => onGrab(e, p, "fade-out")} title="Fade out" />
          </div>
        );
      })}
    </div>
  );
}

function TrackHead({ rows, state, onVolume, onMute, onSolo, dim }: { rows: TrackRows; state: Mixer[TrackName]; dim: boolean; onVolume: (db: number) => void; onMute: () => void; onSolo: () => void }) {
  return (
    <div className={`track-head${dim ? " dim" : ""}`}>
      <div className="track-bar" style={{ height: TRACK_H }}>
        <span className="track-name">{rows.label}</span>
        <button type="button" className={`ms mute${state.mute ? " on" : ""}`} onClick={onMute} title="Mute">
          M
        </button>
        <button type="button" className={`ms solo${state.solo ? " on" : ""}`} onClick={onSolo} title="Solo">
          S
        </button>
      </div>
      <div className="vol">
        <input
          type="range"
          min={VOLUME_MIN_DB}
          max={VOLUME_MAX_DB}
          step={0.5}
          value={state.volume}
          aria-label={`${rows.label} volume`}
          onChange={(e) => onVolume(Number(e.currentTarget.value))}
          onDoubleClick={() => onVolume(0)}
        />
        <span className="db">
          {state.volume > 0 ? "+" : ""}
          {state.volume.toFixed(1)} dB
        </span>
      </div>
      {rows.lanes.map((l) => (
        <div key={l.lane} className="lane-name" style={{ height: LANE_H }}>
          {l.lane}
        </div>
      ))}
    </div>
  );
}

type Load = { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; payload: MixPayload };

/** `preloaded` is for rendering a loaded mix without a host (tests: react-dom/server runs no effects); the window never gets it. */
export default function MixerView({ data, mutate, preloaded }: ViewProps<MixerData> & { readonly preloaded?: MixPayload }) {
  const [load, setLoad] = useState<Load>(preloaded === undefined ? { phase: "loading" } : { phase: "ready", payload: preloaded });
  const [version, setVersion] = useState<number | undefined>(data.version);
  const [peaks, setPeaks] = useState<ReadonlyMap<string, PeaksPayload>>(new Map());
  const [audio, setAudio] = useState({ done: 0, total: 0, failed: [] as string[] });
  const [edit, dispatchEdit] = useReducer(editReducer, undefined, () => initialEdit(preloaded?.document ?? EMPTY));
  const [selected, setSelected] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error" | "stale"; text: string } | null>(null);
  const [reloads, setReloads] = useState(0);
  const [loadKey, setLoadKey] = useState(0);
  const [pps, setPps] = useState(40);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const engine = useRef<MixEngine | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const lengths = useRef(new Map<string, number>());

  const payload = load.phase === "ready" ? load.payload : null;
  const doc = edit.doc;
  // Track volume/mute/solo live in the document (they are saved), so the live mixer is read from it.
  const mixer = useMemo(() => initialMixer(doc), [doc]);
  // Placement depends on the clips alone: a volume change re-places (and reschedules) nothing.
  const lanes = TRACK_ORDER.map((t) => doc.tracks[t]?.lanes);
  const automationRefs = TRACK_ORDER.map((t) => doc.tracks[t]?.automation);
  const placement = useMemo(() => (payload === null ? null : placeClips(doc)), [payload === null, ...lanes]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => (placement === null ? [] : layoutLanes(doc, placement.placed)), [placement]); // eslint-disable-line react-hooks/exhaustive-deps
  const span = useMemo(() => (payload === null || placement === null ? 1 : timelineSeconds(placement.placed, payload.manifest.duration)), [payload, placement]);
  const unsaved = dirty(edit);

  // Load (or reload, on a version switch) the mix document.
  useEffect(() => {
    let live = true;
    setLoad({ phase: "loading" });
    mutate<MixPayload>("loadMix", { episode: data.episode, ...(version === undefined ? {} : { version }) })
      .then((p) => {
        if (!live) return;
        setLoad({ phase: "ready", payload: p });
        dispatchEdit({ type: "load", doc: p.document }); // a fresh history over the loaded version
        setSelected(null);
        setLoadKey((k) => k + 1);
      })
      .catch((e) => live && setLoad({ phase: "error", message: message(e) }));
    return () => {
      live = false;
    };
  }, [data.episode, version, reloads, mutate]);

  /** What the engine plays: the edited document's clips, automation and length. */
  const engineInput = useMemo(() => {
    if (placement === null) return null;
    const automation = Object.fromEntries(TRACK_ORDER.map((t) => [t, trackAutomation(doc, t, placement.when)])) as Record<TrackName, ReturnType<typeof trackAutomation>>;
    return { doc, placed: placement.placed, automation, span };
  }, [placement, span, ...automationRefs]); // eslint-disable-line react-hooks/exhaustive-deps
  const inputRef = useRef(engineInput);
  inputRef.current = engineInput;
  const mixerRef = useRef(mixer);
  mixerRef.current = mixer;

  // Peaks, then audio, for every distinct source of a loaded version; the engine plays once every buffer is
  // decoded. Edits never add a source, so this runs once per load, not per edit.
  useEffect(() => {
    const input = inputRef.current;
    if (loadKey === 0 || input === null) return;
    let live = true;
    const sources = distinctSources(input.placed);
    const eng = new MixEngine(input, mixerRef.current);
    engine.current = eng;
    setReady(false);
    setPlaying(false);
    setTime(0);
    setPeaks(new Map());
    setAudio({ done: 0, total: sources.length, failed: [] });
    void (async () => {
      const got = new Map<string, PeaksPayload>();
      await pool(sources, POOL, async (source: MixSource) => {
        try {
          const p = await mutate<PeaksPayload>("peaks", { source });
          if (!live) return;
          got.set(sourceId(source), p);
          lengths.current.set(sourceId(source), p.seconds);
          setPeaks(new Map(got));
        } catch {
          /* a block with no waveform still plays */
        }
      });
      let done = 0;
      const failed: string[] = [];
      await pool(sources, POOL, async (source: MixSource) => {
        try {
          const a = await mutate<ClipAudioPayload>("clipAudio", { source });
          if (!live) return;
          lengths.current.set(sourceId(source), a.seconds);
          await eng.add(source, a.b64);
        } catch (e) {
          failed.push(`${source.kind} ${source.key.slice(0, 12)}…: ${message(e)}`);
        }
        done += 1;
        if (live) setAudio({ done, total: sources.length, failed: [...failed] });
      });
      if (!live) return;
      try {
        await eng.measure(mixerRef.current);
      } catch {
        /* the master stays at its own gain */
      }
      if (live) setReady(true);
    })();
    return () => {
      live = false;
      eng.close();
      if (engine.current === eng) engine.current = null;
    };
  }, [loadKey, mutate]);

  // An edit is heard at once: the engine reschedules from the playhead (not mid-drag: on the drop).
  useEffect(() => {
    if (engineInput === null || dragging) return;
    engine.current?.update(engineInput);
  }, [engineInput, dragging]);

  // The export normalises the edited mix's peak, so the preview re-measures it once edits settle.
  useEffect(() => {
    if (!ready || dragging || engineInput === null) return;
    const timer = setTimeout(() => void engine.current?.measure(mixer).catch(() => undefined), 700);
    return () => clearTimeout(timer);
  }, [engineInput, mixer, ready, dragging]);

  useEffect(() => {
    engine.current?.setMixer(mixer);
  }, [mixer]);

  // The playhead follows the engine while it plays, and the lanes scroll to keep it in view.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const eng = engine.current;
      if (eng === null) return;
      const t = eng.time();
      setTime(t);
      const el = scroller.current;
      if (el !== null) {
        const x = t * pps;
        if (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 80);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, pps]);

  const toggle = useCallback(async () => {
    const eng = engine.current;
    if (eng === null || !ready) return;
    if (eng.playing) {
      eng.pause();
      setPlaying(false);
      setTime(eng.time());
    } else {
      await eng.play(time >= span ? 0 : time, () => {
        setPlaying(false);
        setTime(span);
      });
      setPlaying(true);
    }
  }, [ready, time, span]);

  const seek = useCallback(
    async (t: number) => {
      const clamped = Math.max(0, Math.min(span, t));
      setTime(clamped);
      await engine.current?.seek(clamped);
    },
    [span],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement | null)?.tagName ?? "")) return;
      if (e.code === "Space") {
        e.preventDefault();
        void toggle();
      } else if (e.key === "Home") void seek(0);
      else if (e.key === "=" || e.key === "+") setPps((v) => clampZoom(v * 1.5));
      else if (e.key === "-") setPps((v) => clampZoom(v / 1.5));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, seek]);

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const el = e.currentTarget;
    const anchor = e.clientX - el.getBoundingClientRect().left;
    const next = zoomAround(pps, el.scrollLeft, e.deltaY < 0 ? 1.15 : 1 / 1.15, anchor);
    setPps(next.pxPerSecond);
    requestAnimationFrame(() => {
      el.scrollLeft = next.scrollPx;
    });
  };

  const fit = () => {
    const el = scroller.current;
    if (el !== null) setPps(clampZoom((el.clientWidth - 20) / span));
  };

  const seekAt = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = scroller.current;
    if (el === null) return;
    const x = e.clientX - el.getBoundingClientRect().left + el.scrollLeft;
    void seek(x / pps);
  };

  const label = useCallback((p: PlacedClip) => (payload === null ? p.clip.id : clipLabel(payload, p.clip)), [payload]);

  const timeRef = useRef(0);
  timeRef.current = time;
  const getTime = useCallback(() => (engine.current?.playing === true ? engine.current.time() : timeRef.current), []);
  const spanRef = useRef(span);
  spanRef.current = span;
  // A marker key pauses playback while the note is typed, and Enter / Esc resume it where it stopped.
  const pauseForNote = useCallback(() => {
    const eng = engine.current;
    if (eng === null || !eng.playing) return false;
    eng.pause();
    setPlaying(false);
    setTime(eng.time());
    return true;
  }, []);
  const resumeAfterNote = useCallback(() => {
    const eng = engine.current;
    if (eng === null) return;
    void eng
      .play(timeRef.current >= spanRef.current ? 0 : timeRef.current, () => {
        setPlaying(false);
        setTime(spanRef.current);
      })
      .then(() => setPlaying(true));
  }, []);
  const markers = useMarkers({ mutate, episode: data.episode, payload, placed: placement?.placed ?? [], getTime, pause: pauseForNote, resume: resumeAfterNote });
  // ---------------------------------------------------------------------------
  // Editing (AGT-1769): gestures and keys become `mixer-edit.ts` edits; the history is `editReducer`'s.
  // ---------------------------------------------------------------------------

  const docRef = useRef(doc);
  docRef.current = doc;
  const ppsRef = useRef(pps);
  ppsRef.current = pps;
  const gestures = useRef(0);
  const justDragged = useRef(false);

  /** The playhead now (the engine's, while it plays). */
  const timeNow = useRef(time);
  timeNow.current = time;
  const playhead = useCallback(() => (engine.current?.playing === true ? engine.current.time() : timeNow.current), []);

  const grab = useCallback<Grab>((e, p, kind) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    setSelected(p.clip.id);
    const from = docRef.current;
    const x0 = e.clientX;
    const gesture = `drag:${(gestures.current += 1)}`;
    const sourceSeconds = lengths.current.get(sourceId(p.clip.source));
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < DRAG_PX) return;
      if (!moved) setDragging(true);
      moved = true;
      const step = ppsRef.current;
      const next = dragEdit(from, kind, p.clip.id, dx / step, { free: ev.altKey, snap: SNAP_PX / step, ...(sourceSeconds === undefined ? {} : { sourceSeconds }) });
      dispatchEdit({ type: "apply", doc: next, label: kind, gesture });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      dispatchEdit({ type: "end-gesture" });
      justDragged.current = moved;
      if (moved) setDragging(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  /** A click on a lane seeks there (and, off any clip, deselects); a drop does neither. */
  const laneClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (justDragged.current) {
      justDragged.current = false;
      return;
    }
    if (!(e.target as HTMLElement).closest(".clip")) setSelected(null);
    seekAt(e);
  };

  const apply = useCallback((next: typeof doc, label: string, gesture?: string) => {
    dispatchEdit({ type: "apply", doc: next, label, ...(gesture === undefined ? {} : { gesture }) });
  }, []);

  const split = useCallback(() => {
    if (selected === null) return;
    const next = splitClip(docRef.current, selected, playhead());
    if (next !== docRef.current) apply(next, "split");
  }, [selected, playhead, apply]);

  const save = useCallback(async () => {
    if (payload === null || !unsaved || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      const saved = await mutate<SavedMixPayload>("saveMix", { episode: data.episode, base: payload.version, document: proposal(docRef.current) });
      setLoad({ phase: "ready", payload: { ...payload, version: saved.version, newest: saved.version, versions: saved.versions, document: saved.document } });
      dispatchEdit({ type: "saved", doc: saved.document });
      setNotice({ kind: "ok", text: `Saved as mix v${saved.version}${saved.summary.text === "" ? "" : `: ${saved.summary.text}`}.` });
    } catch (e) {
      const text = message(e);
      setNotice(isStaleRefusal(text) ? { kind: "stale", text: `Not saved: ${text} Reload to get the newest mix (your unsaved edits here will be lost).` } : { kind: "error", text: `Not saved: ${text}` });
    } finally {
      setSaving(false);
    }
  }, [payload, unsaved, saving, mutate, data.episode]);

  const reload = () => {
    setNotice(null);
    setVersion(undefined);
    setReloads((n) => n + 1);
  };

  const pickVersion = (v: number) => {
    if (unsaved && !window.confirm("You have unsaved edits. Open another version and lose them?")) return;
    setNotice(null);
    setVersion(v);
    setReloads((n) => n + 1);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement | null)?.tagName ?? "")) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        dispatchEdit({ type: e.shiftKey ? "redo" : "undo" });
      } else if (mod && key === "y") {
        e.preventDefault();
        dispatchEdit({ type: "redo" });
      } else if (mod && key === "s") {
        e.preventDefault();
        void save();
      } else if (!mod && !e.altKey && key === "b") split();
      else if (e.key === "Escape") setSelected(null);
      else if (!mod && selected !== null && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        const p = placeClips(docRef.current).placed.find((q) => q.clip.id === selected);
        if (p === undefined) return;
        const step = (e.shiftKey ? 0.1 : 0.01) * (e.key === "ArrowLeft" ? -1 : 1);
        apply(moveClip(docRef.current, selected, p.startSeconds + step, { free: true }), "nudge", `nudge:${selected}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, split, selected, apply]);

  const selectedClip = selected === null || placement === null ? undefined : placement.placed.find((p) => p.clip.id === selected);

  if (load.phase === "loading") {
    return (
      <div className="mixer">
        <style>{CSS}</style>
        <div className="center">Loading episode {data.episode}’s mix…</div>
      </div>
    );
  }
  if (load.phase === "error" || payload === null || placement === null) {
    return (
      <div className="mixer">
        <style>{CSS}</style>
        <div className="center error">{load.phase === "error" ? load.message : "The mix could not be read."}</div>
      </div>
    );
  }

  const ticks = rulerTicks(span, pps);
  const width = Math.ceil(span * pps) + 40;
  const soloed = TRACK_ORDER.some((t) => mixer[t].solo);
  const shown = payload.versions.find((v) => v.version === payload.version);

  return (
    <div className="mixer">
      <style>{CSS + MARKERS_CSS + INSPECTOR_CSS}</style>
      <header className="top">
        <div className="titles">
          <span className="work">{data.title}</span>
          <span className="episode">
            Episode {payload.episode}: {payload.title}
          </span>
        </div>
        <div className="transport">
          <button type="button" className="play" onClick={() => void toggle()} disabled={!ready} title="Play / pause (space)">
            {playing ? "Pause" : "Play"}
          </button>
          <span className="clock">
            {timecode(time, true)} / {timecode(span, true)}
          </span>
          <button type="button" onClick={() => setPps((v) => clampZoom(v / 1.5))} title="Zoom out (-)">
            −
          </button>
          <button type="button" onClick={() => setPps((v) => clampZoom(v * 1.5))} title="Zoom in (+)">
            +
          </button>
          <button type="button" onClick={fit} title="Fit the episode">
            Fit
          </button>
        </div>
        <div className="editing">
          <button type="button" onClick={() => dispatchEdit({ type: "undo" })} disabled={edit.past.length === 0} title="Undo (⌘Z)">
            Undo
          </button>
          <button type="button" onClick={() => dispatchEdit({ type: "redo" })} disabled={edit.future.length === 0} title="Redo (⇧⌘Z)">
            Redo
          </button>
          <button type="button" className="save" onClick={() => void save()} disabled={!unsaved || saving} title="Save as the next mix version (⌘S)">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
        <div className="version">
          <label>
            Mix{" "}
            <select value={payload.version} onChange={(e) => pickVersion(Number(e.currentTarget.value))}>
              {payload.versions.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version} ({v.by})
                </option>
              ))}
            </select>
          </label>
          {shown?.summary !== undefined && <span className="summary">{shown.summary}</span>}
        </div>
      </header>
      <div className="status">
        {!ready && audio.total > 0 && (
          <span>
            Loading audio {audio.done}/{audio.total}
            {peaks.size < audio.total ? ` · waveforms ${peaks.size}/${audio.total}` : ""}
          </span>
        )}
        {ready && (
          <span>
            {placement.placed.length} clips · {unsaved ? <span className="unsaved">unsaved edits</span> : "no unsaved edits"} · drag to move (Alt: free), edges trim, corners fade, B splits
          </span>
        )}
        {notice !== null && (
          <span className={notice.kind === "ok" ? "ok" : "warn"}>
            {notice.text}
            {notice.kind === "stale" && (
              <button type="button" className="reload" onClick={reload}>
                Reload
              </button>
            )}
          </span>
        )}
        {payload.latestManifest > payload.manifest.version && (
          <span className="warn">
            This mix was made against manifest v{payload.manifest.version}; the newest is v{payload.latestManifest}.
          </span>
        )}
        {audio.failed.length > 0 && <span className="warn">{audio.failed.length} source(s) failed to load and will be silent.</span>}
      </div>
      {placement.problems.length > 0 && (
        <ul className="problems">
          {placement.problems.map((p) => (
            <li key={p.field}>
              {p.field}: {p.message}
            </li>
          ))}
        </ul>
      )}
      {payload.document.rebase !== undefined && payload.document.rebase.review.length > 0 && (
        <ul className="problems review">
          <li className="head">
            Rebased from mix v{payload.document.rebase.from} after a fix (manifest v{payload.document.rebase.manifest_from} to v{payload.document.manifest_version}): {payload.document.rebase.review.length}{" "}
            item(s) to review, then save
          </li>
          {payload.document.rebase.review.map((r, k) => (
            <li key={k}>
              {r.field}: {r.problem}
            </li>
          ))}
        </ul>
      )}
      {selectedClip !== undefined && (
        <Inspector
          placed={selectedClip}
          label={label(selectedClip)}
          lines={payload.manifest.lines}
          sourceSeconds={lengths.current.get(sourceId(selectedClip.clip.source))}
          playhead={time}
          onGain={(db, gesture) => apply(setGain(doc, selectedClip.clip.id, db), "gain", gesture)}
          onFade={(which, change, gesture) => apply(setFade(doc, selectedClip.clip.id, which, change), `fade ${which}`, gesture)}
          onSplit={split}
          onClose={() => setSelected(null)}
        />
      )}
      <div className="body">
        <div className="heads" style={{ width: HEAD_W, paddingTop: RULER_H }}>
          {rows.map((r) => (
            <TrackHead
              key={r.track}
              rows={r}
              state={mixer[r.track]}
              dim={mixer[r.track].mute || (soloed && !mixer[r.track].solo)}
              onVolume={(db) => apply(setTrack(doc, r.track, { volume: db }), `${r.track} volume`, `volume:${r.track}`)}
              onMute={() => apply(setTrack(doc, r.track, { mute: !mixer[r.track].mute }), `${r.track} mute`)}
              onSolo={() => apply(setTrack(doc, r.track, { solo: !mixer[r.track].solo }), `${r.track} solo`)}
            />
          ))}
        </div>
        <div className="lanes" ref={scroller} onWheel={onWheel}>
          <div className="canvas" style={{ width }}>
            <div className="ruler" style={{ height: RULER_H }} onClick={seekAt}>
              {ticks.map((t) => (
                <div key={t.t} className="tick" style={{ left: t.t * pps }}>
                  {t.label}
                </div>
              ))}
              <MarkerPins notes={markers.notes} pps={pps} onJump={(t) => void seek(t)} inRuler />
            </div>
            {rows.map((r) => (
              <div key={r.track} className={`track track-${r.track}${mixer[r.track].mute || (soloed && !mixer[r.track].solo) ? " dim" : ""}`} onClick={laneClick}>
                <div className="track-gap" style={{ height: TRACK_H + 30 }} />
                {r.lanes.map((l) => (
                  <Lane key={l.lane} row={l} pps={pps} peaks={peaks} label={label} selected={selected} onGrab={grab} />
                ))}
              </div>
            ))}
            <MarkerPins notes={markers.notes} pps={pps} onJump={(t) => void seek(t)} inRuler={false} />
            <div className="playhead" style={{ left: time * pps }} />
          </div>
        </div>
        <MarkersPanel api={markers} onJump={(t) => void seek(t)} />
      </div>
    </div>
  );
}

const CSS = `
:root {
  --bg: #17181b; --panel: #1f2125; --panel-2: #26292e; --line: #33373d; --text: #d9d6cf; --muted: #8b8b86;
  --accent: #c99a5b; --warn: #c9734f;
  --dialogue: #6f8fa6; --sfx: #8a9a6c; --beds: #8a7aa0; --music: #a88a62;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text);
  font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
.mixer { display: flex; flex-direction: column; height: 100vh; }
.center { margin: auto; color: var(--muted); padding: 16px; text-align: center; }
.center.error { color: var(--warn); }
.top { display: flex; align-items: center; gap: 16px; padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.titles { display: flex; flex-direction: column; min-width: 0; flex: 1 1 200px; }
.work { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
.episode { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.transport { display: flex; align-items: center; gap: 6px; }
button, select { background: var(--panel-2); color: var(--text); border: 1px solid var(--line); border-radius: 4px; padding: 4px 9px; font: inherit; cursor: pointer; }
button:disabled { opacity: .45; cursor: default; }
button.play { min-width: 64px; border-color: var(--accent); color: var(--accent); }
.clock { font-variant-numeric: tabular-nums; min-width: 110px; text-align: center; color: var(--muted); }
.version { display: flex; align-items: center; gap: 8px; color: var(--muted); }
.summary { font-size: 12px; max-width: 280px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.status { display: flex; gap: 16px; padding: 4px 16px; min-height: 24px; color: var(--muted); font-size: 12px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.warn { color: var(--warn); }
.problems { margin: 0; padding: 6px 16px 6px 32px; color: var(--warn); font-size: 12px; background: #2a201c; }
.problems .head { list-style: none; margin-left: -16px; font-weight: 600; }
.body { flex: 1; display: flex; align-items: flex-start; min-height: 0; overflow-y: auto; }
.heads { flex: none; background: var(--panel); border-right: 1px solid var(--line); }
.track-head { border-bottom: 1px solid var(--line); }
.track-head.dim .track-name { color: var(--muted); }
.track-bar { display: flex; align-items: center; gap: 4px; padding: 0 8px; }
.track-name { flex: 1; font-weight: 600; }
.ms { padding: 1px 6px; font-size: 11px; line-height: 16px; }
.mute.on { background: #6b4a2e; border-color: #8a6038; color: #f1dcc0; }
.solo.on { background: #4d5f3a; border-color: #6a8250; color: #e2ecd2; }
.vol { display: flex; align-items: center; gap: 6px; padding: 0 8px; height: 30px; }
.vol input { flex: 1; min-width: 0; accent-color: var(--accent); }
.db { font-size: 11px; color: var(--muted); width: 54px; text-align: right; font-variant-numeric: tabular-nums; }
.lane-name { display: flex; align-items: center; padding: 0 10px 0 18px; color: var(--muted); font-size: 12px; border-top: 1px solid #2a2d32;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lanes { flex: 1; overflow-x: auto; overflow-y: visible; position: relative; }
.canvas { position: relative; min-height: 100%; }
.ruler { position: relative; z-index: 3; background: var(--panel); border-bottom: 1px solid var(--line); cursor: pointer; }
.tick { position: absolute; top: 0; bottom: 0; border-left: 1px solid var(--line); padding: 6px 0 0 4px; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.track { border-bottom: 1px solid var(--line); }
.track.dim { opacity: .4; }
.track-gap { background: rgba(255,255,255,.015); }
.lane { position: relative; border-top: 1px solid #2a2d32; }
.clip { position: absolute; top: 2px; bottom: 2px; border-radius: 3px; overflow: hidden; background: rgba(111,143,166,.22);
  border: 1px solid rgba(111,143,166,.55); }
.lane-sfx .clip { background: rgba(138,154,108,.22); border-color: rgba(138,154,108,.55); }
.lane-beds .clip { background: rgba(138,122,160,.22); border-color: rgba(138,122,160,.55); }
.lane-music .clip { background: rgba(168,138,98,.22); border-color: rgba(168,138,98,.55); }
.wave { position: absolute; inset: 0; }
.wave path { fill: rgba(217,214,207,.45); }
.env { position: absolute; inset: 0; pointer-events: none; }
.env path { fill: none; stroke: var(--accent); stroke-width: 1; opacity: .8; }
.clip-label { position: absolute; left: 4px; top: 1px; right: 4px; font-size: 11px; color: var(--text); white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; text-shadow: 0 1px 2px rgba(0,0,0,.8); pointer-events: none; }
.clip { cursor: grab; touch-action: none; user-select: none; }
.clip.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.trim { position: absolute; top: 0; bottom: 0; width: 6px; cursor: ew-resize; z-index: 1; }
.trim-in { left: 0; }
.trim-out { right: 0; }
.trim:hover { background: rgba(201,154,91,.35); }
.fade-handle { position: absolute; top: 0; width: 8px; height: 8px; background: var(--accent); opacity: .55; cursor: ew-resize; z-index: 2; border-radius: 0 0 2px 2px; }
.clip:hover .fade-handle, .clip.selected .fade-handle { opacity: 1; }
.editing { display: flex; align-items: center; gap: 6px; }
button.save:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.unsaved { color: var(--accent); }
.ok { color: #9fb98a; }
.reload { margin-left: 8px; padding: 1px 8px; }
.playhead { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--accent); z-index: 4; pointer-events: none; }
`;
