import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ViewProps } from "@openthink/ui-leaf/view";
import type { ClipAudioPayload, MixPayload, MixSource, PeaksPayload, TrackName } from "./mixer-protocol";
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
  mixerReducer,
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

/**
 * The mixer view (AGT-1768, `pm project show pablo-mixer`, "The mixer view"): an episode's mix document drawn
 * as the fixed tracks (Dialogue one lane per role, SFX, Beds, Music) of clip blocks on a time ruler, each with
 * its source's waveform, a playhead, zoom and scroll, and Web Audio playback of every clip with its gain, fades,
 * same-lane crossfades, track automation and per-track volume/mute/solo (`mixer-audio.ts`).
 *
 * Read-only: editing is the next ticket (M5). Volume, mute and solo are live (heard at once) but not saved.
 * The view never reads a file. It calls three host mutations, `loadMix`, `peaks` and `clipAudio`
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

function Lane({ row, pps, peaks, label }: { row: LaneRow; pps: number; peaks: ReadonlyMap<string, PeaksPayload>; label: (p: PlacedClip) => string }) {
  return (
    <div className={`lane lane-${row.track}`} style={{ height: LANE_H }}>
      {row.clips.map((p, k) => {
        const left = p.startSeconds * pps;
        const width = Math.max(2, (p.endSeconds - p.startSeconds) * pps);
        const pk = peaks.get(sourceId(p.clip.source));
        const slice = pk === undefined ? [] : clipPeaks(pk.peaks, pk.perSecond, p.inSeconds, p.inSeconds + (p.endSeconds - p.startSeconds));
        const gain = p.clip.gain ?? 0;
        return (
          <div
            key={p.field}
            className="clip"
            style={{ left, width }}
            title={`${label(p)}\n${timecode(p.startSeconds, true)}–${timecode(p.endSeconds, true)}${gain !== 0 ? `  ${gain > 0 ? "+" : ""}${gain.toFixed(1)} dB` : ""}`}
          >
            <Waveform peaks={slice} width={width} height={LANE_H - 4} />
            <EnvelopeLine members={row.clips} k={k} width={width} height={LANE_H - 4} />
            {width > 28 && <span className="clip-label">{label(p)}</span>}
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
  const [mixer, dispatch] = useReducer(mixerReducer, undefined, () => initialMixer(preloaded?.document ?? EMPTY));
  const [pps, setPps] = useState(40);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const engine = useRef<MixEngine | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);

  const payload = load.phase === "ready" ? load.payload : null;
  const placement = useMemo(() => (payload === null ? null : placeClips(payload.document)), [payload]);
  const rows = useMemo(() => (payload === null || placement === null ? [] : layoutLanes(payload.document, placement.placed)), [payload, placement]);
  const span = useMemo(() => (payload === null || placement === null ? 1 : timelineSeconds(placement.placed, payload.manifest.duration)), [payload, placement]);

  // Load (or reload, on a version switch) the mix document.
  useEffect(() => {
    let live = true;
    setLoad({ phase: "loading" });
    mutate<MixPayload>("loadMix", { episode: data.episode, ...(version === undefined ? {} : { version }) })
      .then((p) => {
        if (!live) return;
        setLoad({ phase: "ready", payload: p });
        dispatch({ type: "reset", mixer: initialMixer(p.document) }); // the document's volume/mute/solo
      })
      .catch((e) => live && setLoad({ phase: "error", message: message(e) }));
    return () => {
      live = false;
    };
  }, [data.episode, version, mutate]);

  const mixerRef = useRef(mixer);
  mixerRef.current = mixer;

  // Peaks, then audio, for every distinct source; the engine plays once every buffer is decoded.
  useEffect(() => {
    if (payload === null || placement === null) return;
    let live = true;
    const sources = distinctSources(placement.placed);
    const automation = Object.fromEntries(TRACK_ORDER.map((t) => [t, trackAutomation(payload.document, t, placement.when)])) as Record<TrackName, ReturnType<typeof trackAutomation>>;
    const eng = new MixEngine({ doc: payload.document, placed: placement.placed, automation, span }, mixerRef.current);
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
          await eng.add(source, a.b64);
        } catch (e) {
          failed.push(`${source.kind} ${source.key.slice(0, 12)}…: ${message(e)}`);
        }
        done += 1;
        if (live) setAudio({ done, total: sources.length, failed: [...failed] });
      });
      if (!live) return;
      try {
        await eng.measure(initialMixer(payload.document));
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
  }, [payload, placement, span, mutate]);

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
      if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
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
      <style>{CSS}</style>
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
        <div className="version">
          <label>
            Mix{" "}
            <select value={payload.version} onChange={(e) => setVersion(Number(e.currentTarget.value))}>
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
        {ready && <span>{placement.placed.length} clips · read-only (volume, mute and solo are live, not saved)</span>}
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
      <div className="body">
        <div className="heads" style={{ width: HEAD_W, paddingTop: RULER_H }}>
          {rows.map((r) => (
            <TrackHead
              key={r.track}
              rows={r}
              state={mixer[r.track]}
              dim={mixer[r.track].mute || (soloed && !mixer[r.track].solo)}
              onVolume={(db) => dispatch({ type: "volume", track: r.track, db })}
              onMute={() => dispatch({ type: "mute", track: r.track })}
              onSolo={() => dispatch({ type: "solo", track: r.track })}
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
            </div>
            {rows.map((r) => (
              <div key={r.track} className={`track track-${r.track}${mixer[r.track].mute || (soloed && !mixer[r.track].solo) ? " dim" : ""}`} onClick={seekAt}>
                <div className="track-gap" style={{ height: TRACK_H + 30 }} />
                {r.lanes.map((l) => (
                  <Lane key={l.lane} row={l} pps={pps} peaks={peaks} label={label} />
                ))}
              </div>
            ))}
            <div className="playhead" style={{ left: time * pps }} />
          </div>
        </div>
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
.playhead { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--accent); z-index: 4; pointer-events: none; }
`;
