import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ViewProps } from "@openthink/ui-leaf/view";
import { CHAPTER_POLL_MS, REASONS } from "./review-protocol";
import type { ChapterRow, ReviewData, ReviewFlag, TrackPayload } from "./review-protocol";
import { arrivals, clock, flagTargetIndex, flagsOnLine, gateRows, lineIndexAt, seekAfterSwitch } from "./review-logic";

/**
 * The review player (AGT-1693, `pm project show pablo-casting`, "The review surface"): the prototype's
 * cathedral radio (`radio/views/radio.tsx` in the Valley's Shadow sandbox), with a reason on each flag, the
 * current line's gate scores, the performer's auto-flags in a second colour with the failing gate named, a
 * version switcher, and a chapter list that fills in as chapters are published.
 *
 * The view is dumb on purpose and never reads a file. It calls five host mutations, `listChapters`,
 * `loadTrack`, `setVersion`, `flag` and `unflag`, and draws what comes back (`review-protocol.ts`). It is
 * bundled by the ui-leaf binary, which supplies React; `bun run typecheck` checks this file.
 */

type Track = Omit<TrackPayload, "b64">;

const REASON_LABEL: Readonly<Record<string, string>> = {
  clipped: "Clipped",
  "wrong voice": "Wrong voice",
  flat: "Flat",
  rushed: "Rushed",
  other: "Other",
};

function b64ToUrl(b64: string, mime: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

function load(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : Number(v);
  } catch {
    return fallback;
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function Knob({ label, angle, onTurn, title }: { label: string; angle: number; title: string; onTurn: (dir: number) => void }) {
  const drag = useRef<number | null>(null);
  return (
    <div className="knob-wrap" title={title}>
      <div
        className="knob"
        style={{ transform: `rotate(${angle}deg)` }}
        onWheel={(e) => onTurn(e.deltaY < 0 ? 1 : -1)}
        onPointerDown={(e) => {
          drag.current = e.clientY;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current === null) return;
          const d = drag.current - e.clientY;
          if (Math.abs(d) >= 14) {
            onTurn(Math.sign(d));
            drag.current = e.clientY;
          }
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      >
        <div className="knob-mark" />
      </div>
      <div className="knob-label">{label}</div>
    </div>
  );
}

export default function Review({ data, mutate }: ViewProps<ReviewData>) {
  const [chapters, setChapters] = useState<readonly ChapterRow[]>(data.chapters);
  const [episode, setEpisode] = useState<number | null>(data.start);
  const [track, setTrack] = useState<Track | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);
  const wantPlay = useRef(false);
  const pendingSeek = useRef<number | null>(null);
  const [loading, setLoading] = useState(data.start !== null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [volume, setVolume] = useState(() => load("review.volume", 0.8));
  const [reason, setReason] = useState<string>(REASONS[0]);
  const [toast, setToast] = useState<string | null>(null);

  const idx = Math.max(0, chapters.findIndex((c) => c.episode === episode));
  const chapter = chapters.find((c) => c.episode === episode);
  const lines = track?.lines ?? [];
  const flags: readonly ReviewFlag[] = track?.flags ?? [];

  // The chapter list: asked for again while the window is open, so a chapter published now appears at once.
  useEffect(() => {
    let alive = true;
    const poll = () =>
      mutate<ChapterRow[]>("listChapters")
        .then((next) => {
          if (!alive) return;
          setChapters((prev) => {
            const fresh = arrivals(prev, next);
            if (fresh.length > 0 && prev.length > 0) setToast(`New: ${fresh.map((e) => `episode ${e}`).join(", ")}`);
            return next;
          });
          setEpisode((cur) => cur ?? next[0]?.episode ?? null);
        })
        .catch(() => undefined); // a missed poll is retried; the list on screen stays
    const h = setInterval(poll, CHAPTER_POLL_MS);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [mutate]);

  const applyTrack = useCallback(
    (p: TrackPayload, seek: number) => {
      const { b64, ...rest } = p;
      const a = audio.current;
      if (a === null) return;
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = b64ToUrl(b64, p.mime);
      pendingSeek.current = seek;
      a.src = url.current;
      a.volume = volume;
      setTrack(rest);
      setT(seek);
      setLoading(false);
    },
    [volume],
  );

  // tune: fetch the episode (its newest mixed version) from the host and hand it to <audio>
  useEffect(() => {
    if (episode === null) return;
    let cancelled = false;
    setLoading(true);
    setT(0);
    mutate<TrackPayload>("loadTrack", { episode })
      .then((p) => {
        if (!cancelled) applyTrack(p, 0);
      })
      .catch((e) => {
        if (!cancelled) {
          setLoading(false);
          setToast(`Couldn't tune in: ${message(e)}`);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episode]);

  useEffect(() => {
    if (audio.current) audio.current.volume = volume;
    try {
      localStorage.setItem("review.volume", String(volume));
    } catch {
      /* private window */
    }
  }, [volume]);

  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(h);
  }, [toast]);

  const toggle = useCallback(() => {
    const a = audio.current;
    if (!a || loading) return;
    if (a.paused) {
      wantPlay.current = true;
      a.play().catch(() => setPlaying(false));
    } else {
      wantPlay.current = false;
      a.pause();
    }
  }, [loading]);

  const seek = useCallback(
    (by: number) => {
      const a = audio.current;
      if (a) a.currentTime = Math.max(0, Math.min(a.duration || track?.duration || 0, a.currentTime + by));
    },
    [track],
  );

  const tune = useCallback(
    (dir: number) => {
      const next = chapters[Math.max(0, Math.min(chapters.length - 1, idx + dir))];
      if (next !== undefined) setEpisode(next.episode);
    },
    [chapters, idx],
  );

  const switchVersion = useCallback(
    async (version: number) => {
      if (track === null || version === track.version) return;
      const a = audio.current;
      try {
        const p = await mutate<TrackPayload>("setVersion", { episode: track.episode, version });
        applyTrack(p, seekAfterSwitch(track.lines, a?.currentTime ?? 0, p.lines));
        setToast(`Now playing version ${p.version}`);
      } catch (e) {
        setToast(`Couldn't switch version: ${message(e)}`);
      }
    },
    [track, mutate, applyTrack],
  );

  const current = lineIndexAt(lines, t);
  const line = lines[current];
  const prev = lines[current - 1];
  const next = lines[current + 1];
  const epFlags = flags;
  const lineFlags = line === undefined ? [] : flagsOnLine(flags, line.i);
  const scores = useMemo(() => gateRows(line), [line]);

  const flag = useCallback(async () => {
    if (track === null) return;
    const target = track.lines[flagTargetIndex(track.lines, audio.current?.currentTime ?? t)];
    if (!target) return;
    try {
      const nextFlags = await mutate<ReviewFlag[]>("flag", { episode: track.episode, line: target.i, reason, time: target.start, version: track.version });
      setTrack((cur) => (cur === null ? cur : { ...cur, flags: nextFlags }));
      setToast(`Flagged (${reason}): ${target.speaker}, "${target.text.slice(0, 48)}${target.text.length > 48 ? "…" : ""}"`);
    } catch (e) {
      setToast(`Couldn't save that flag: ${message(e)}`);
    }
  }, [track, t, reason, mutate]);

  const unflag = useCallback(
    async (f: ReviewFlag) => {
      try {
        const nextFlags = await mutate<ReviewFlag[]>("unflag", { episode: f.episode, line: f.line, id: f.id });
        setTrack((cur) => (cur === null ? cur : { ...cur, flags: nextFlags }));
      } catch (e) {
        setToast(`Couldn't remove that flag: ${message(e)}`);
      }
    },
    [mutate],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowLeft") seek(-10);
      else if (e.key === "ArrowRight") seek(10);
      else if (e.key === "f" || e.key === "F") void flag();
      else if (e.key === "[") tune(-1);
      else if (e.key === "]") tune(1);
      else if (/^[1-5]$/.test(e.key)) setReason(REASONS[Number(e.key) - 1] as string);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, seek, flag, tune]);

  const duration = audio.current?.duration && isFinite(audio.current.duration) ? audio.current.duration : (track?.duration ?? 0);
  // needle sweeps the dial from the first chapter at the far left to the last at the far right
  const needle = -62 + (124 * idx) / Math.max(1, chapters.length - 1);
  const glowing = playing && !loading;
  const waiting = episode === null;

  return (
    <div className="room">
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,600;1,400&family=Special+Elite&display=swap" />
      <style>{CSS}</style>
      <audio
        ref={audio}
        onLoadedMetadata={(e) => {
          const a = e.currentTarget;
          if (pendingSeek.current !== null) {
            a.currentTime = pendingSeek.current;
            pendingSeek.current = null;
          }
          if (wantPlay.current) a.play().catch(() => setPlaying(false));
        }}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          if (idx < chapters.length - 1) {
            wantPlay.current = true;
            tune(1);
          }
        }}
      />

      <div className="cabinet">
        <div className="crown">
          <div className="grille">
            <svg className="fret" viewBox="0 0 300 220" preserveAspectRatio="none" aria-hidden>
              {[0, 1, 2, 3, 4].map((k) => {
                const x = 30 + k * 60;
                return <path key={k} d={`M${x - 9} 220 L${x - 9} 70 Q${x} 30 ${x + 9} 70 L${x + 9} 220 Z`} />;
              })}
            </svg>
          </div>
        </div>

        <div className={`dial ${glowing ? "lit" : ""} ${loading ? "warming" : ""}`}>
          <div className="dial-face">
            <div className="dial-title">{data.title}</div>
            <svg className="scale" viewBox="0 0 300 120" aria-hidden>
              <path d="M70 76 A90 90 0 0 1 230 76" className="arc" />
              {chapters.map((c, k) => {
                const a = ((-62 + (124 * k) / Math.max(1, chapters.length - 1)) * Math.PI) / 180;
                const cx = 150 + 90 * Math.sin(a);
                const cy = 118 - 90 * Math.cos(a);
                const tx = 150 + 107 * Math.sin(a);
                const ty = 120 - 107 * Math.cos(a);
                return (
                  <g key={c.episode} className={k === idx ? "here" : ""} onClick={() => setEpisode(c.episode)} style={{ cursor: "pointer" }}>
                    <circle cx={cx} cy={cy} r={2.4} />
                    <text x={tx} y={ty}>{c.episode}</text>
                  </g>
                );
              })}
            </svg>
            {!waiting && <div className="needle" style={{ transform: `rotate(${needle}deg)` }} />}
            <div className="hub" />
          </div>
        </div>

        <div
          className="tape"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            if (audio.current) audio.current.currentTime = ((e.clientX - r.left) / r.width) * duration;
          }}
        >
          <div className="tape-fill" style={{ width: `${(100 * t) / (duration || 1)}%` }} />
          {epFlags.map((f) => (
            <div key={f.id} className={`tape-flag ${f.source}`} style={{ left: `${(100 * f.time) / (duration || 1)}%` }} />
          ))}
        </div>
        <div className="time">{waiting ? "waiting for the first chapter…" : loading ? "warming up the tubes…" : `${clock(t)} / ${clock(duration)}`}</div>

        <div className="controls">
          <Knob label="Volume" title="Volume: scroll or drag" angle={-135 + 270 * volume} onTurn={(d) => setVolume((v) => Math.max(0, Math.min(1, +(v + d * 0.05).toFixed(2))))} />
          <div className="keys">
            <div className="key-row">
              <button className="key" onClick={() => seek(-10)} title="Back 10 seconds (←)">« 10</button>
              <button className="key play" onClick={toggle} disabled={loading || waiting} title="Play / pause (space)">{playing ? "❚❚" : "▶"}</button>
              <button className="key" onClick={() => seek(10)} title="Ahead 10 seconds (→)">10 »</button>
            </div>
            <button className="key clipped" onClick={() => void flag()} disabled={loading || waiting || t < 0.5} title={`Flag the line that just played as ${reason} (F)`}>
              {REASON_LABEL[reason] ?? reason}
            </button>
          </div>
          <Knob label="Tuning" title="Change chapter: scroll, drag, or [ and ]" angle={needle * 2} onTurn={(d) => tune(d)} />
        </div>
        <div className="reasons" role="group" aria-label="Reason for the next flag">
          {REASONS.map((r, k) => (
            <button key={r} className={`reason ${r === reason ? "on" : ""}`} onClick={() => setReason(r)} title={`Reason ${k + 1}`}>
              {REASON_LABEL[r]}
            </button>
          ))}
        </div>
        <div className="badge">pablo review</div>
      </div>

      <div className="card">
        <div className="card-head">
          <span>{chapter ? `Episode ${chapter.episode}` : "No chapters yet"}</span>
          <span className="card-title">{track?.title ?? chapter?.title ?? ""}</span>
        </div>

        {track !== null && track.versions.length > 1 && (
          <div className="versions" role="group" aria-label="Version">
            <span className="versions-label">Version</span>
            {track.versions.map((v) => (
              <button
                key={v.version}
                className={`ver ${v.version === track.version ? "on" : ""}`}
                onClick={() => void switchVersion(v.version)}
                title={v.changedLines > 0 ? `${v.changedLines} line${v.changedLines === 1 ? "" : "s"} re-recorded` : "No lines re-recorded"}
              >
                v{v.version}
              </button>
            ))}
          </div>
        )}

        <div className="script">
          <p className="dim">{prev ? <><b>{prev.speaker}</b> {prev.text}</> : " "}</p>
          <p className={`now ${lineFlags.some((f) => f.source === "auto") ? "auto" : ""}`}>
            {line ? <><b>{line.speaker}</b> {line.text}</> : <i>{waiting ? "Chapters appear here as they are published." : loading ? "Tuning in…" : "Press play to listen."}</i>}
          </p>
          <p className="dim">{next ? <><b>{next.speaker}</b> {next.text}</> : " "}</p>
        </div>

        {line !== undefined && (
          <div className="scores" aria-label="Gate scores for this line">
            {line.failing.length > 0 && <span className="fail">failed: {line.failing.join(", ")}</span>}
            {scores.map((s) => (
              <span key={s.name} className="score"><i>{s.name}</i> {s.value}</span>
            ))}
          </div>
        )}

        {epFlags.length > 0 && (
          <div className="flags">
            <div className="flags-head">Flagged in this episode ({epFlags.length})</div>
            {epFlags.map((f) => (
              <div key={f.id} className={`flag-row ${f.source}`}>
                <button className="jump" onClick={() => { if (audio.current) audio.current.currentTime = f.time; }}>{clock(f.time)}</button>
                <span className="flag-text">
                  <b>{f.source === "auto" ? "auto" : f.reason}</b>{" "}
                  {f.source === "auto" ? (f.failing.length > 0 ? `failed ${f.failing.join(", ")}` : f.reason) : ""}{" "}
                  <span className="flag-line">{lines.find((l) => l.i === f.line)?.text ?? `line ${f.line}`}</span>
                </span>
                <button className="x" onClick={() => void unflag(f)} title="Remove this flag">×</button>
              </div>
            ))}
          </div>
        )}

        <div className="chapters">
          <div className="chapters-head">Chapters ({chapters.length})</div>
          {chapters.length === 0 && <div className="chapter-empty">None published yet. This list fills in by itself.</div>}
          {chapters.map((c) => (
            <button key={c.episode} className={`chapter ${c.episode === episode ? "on" : ""}`} onClick={() => setEpisode(c.episode)}>
              <span className="chapter-n">{c.episode}</span>
              <span className="chapter-title">{c.title}</span>
              <span className="chapter-meta">
                v{c.latest}
                {c.flags.auto > 0 && <em className="auto"> {c.flags.auto} auto</em>}
                {c.flags.human > 0 && <em className="human"> {c.flags.human} flagged</em>}
              </span>
            </button>
          ))}
        </div>
        <div className="hint">Space play/pause · ← → 10s · F flag · 1-5 reason · [ ] change chapter</div>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

const CSS = `
:root {
  --wall: #1d1916; --wall-2: #14110f;
  --wood: #6a3d20; --wood-dark: #3f2312; --wood-light: #8a5530;
  --cloth: #b59a6c; --cloth-dark: #8c744d;
  --dial: #efe3c6; --dial-ink: #4a3522; --amber: #ffb54a;
  --bakelite: #3a2416; --brass: #b8925a;
  --paper: #f3ead6; --ink: #2b2118; --muted: #7a6a58; --flag: #a63d2b; --auto: #2f6f8a;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: radial-gradient(ellipse at 50% 30%, var(--wall) 0%, var(--wall-2) 75%); }
.room { min-height: 100vh; display: flex; flex-direction: column; align-items: center;
  padding: 24px 16px 32px; gap: 20px; font-family: "Playfair Display", Georgia, serif; color: var(--ink); }

.cabinet { position: relative; width: min(440px, 100%); padding: 0 26px 22px;
  border-radius: 220px 220px 22px 22px / 190px 190px 22px 22px;
  background:
    repeating-linear-gradient(92deg, rgba(0,0,0,.06) 0 2px, transparent 2px 9px),
    repeating-linear-gradient(88deg, rgba(255,255,255,.035) 0 1px, transparent 1px 13px),
    radial-gradient(ellipse at 50% 0%, var(--wood-light) 0%, var(--wood) 45%, var(--wood-dark) 100%);
  box-shadow: inset 0 0 0 6px rgba(0,0,0,.18), inset 0 0 0 9px rgba(255,220,170,.06),
    0 30px 60px rgba(0,0,0,.55), 0 4px 0 #2a170b; }
.crown { padding-top: 34px; display: flex; justify-content: center; }
.grille { width: 300px; max-width: 100%; height: 210px; position: relative; overflow: hidden;
  border-radius: 150px 150px 6px 6px / 140px 140px 6px 6px;
  background:
    repeating-linear-gradient(45deg, rgba(0,0,0,.12) 0 1px, transparent 1px 4px),
    repeating-linear-gradient(-45deg, rgba(0,0,0,.10) 0 1px, transparent 1px 4px),
    radial-gradient(ellipse at 50% 40%, var(--cloth) 0%, var(--cloth-dark) 100%);
  box-shadow: inset 0 0 0 5px var(--wood-dark), inset 0 8px 20px rgba(0,0,0,.45); }
.fret { position: absolute; inset: 0; width: 100%; height: 100%; }
.fret path { fill: var(--wood); stroke: var(--wood-dark); stroke-width: 2; }

.dial { margin: 18px auto 0; width: 300px; max-width: 100%; height: 140px; border-radius: 150px 150px 10px 10px;
  padding: 8px; background: linear-gradient(#5a3418, #3a200f); box-shadow: inset 0 2px 6px rgba(0,0,0,.6); }
.dial-face { position: relative; height: 100%; border-radius: 142px 142px 6px 6px; overflow: hidden;
  background: radial-gradient(ellipse at 50% 100%, #fff6dd 0%, var(--dial) 60%, #d8c59c 100%);
  box-shadow: inset 0 0 18px rgba(0,0,0,.25); transition: box-shadow .8s, filter .8s; filter: brightness(.82); }
.dial.lit .dial-face { filter: brightness(1.04);
  box-shadow: inset 0 0 18px rgba(0,0,0,.2), inset 0 -30px 60px rgba(255,181,74,.55); }
.dial.warming .dial-face { animation: warm 1.6s ease-in-out infinite alternate; }
@keyframes warm { from { filter: brightness(.8); } to { filter: brightness(.95); } }
.dial-title { position: absolute; top: 58%; width: 100%; text-align: center; font-style: italic;
  font-size: 13px; color: var(--dial-ink); letter-spacing: .04em; padding: 0 28px; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; }
.scale { position: absolute; inset: 0; width: 100%; height: 100%; }
.scale .arc { fill: none; stroke: var(--dial-ink); stroke-width: 1; opacity: .5; }
.scale circle { fill: var(--dial-ink); }
.scale text { font-family: "Special Elite", "Courier New", monospace; font-size: 12px; fill: var(--dial-ink);
  text-anchor: middle; dominant-baseline: middle; }
.scale .here text { fill: #9a4a12; font-weight: bold; font-size: 14px; }
.needle { position: absolute; left: calc(50% - 1px); bottom: 2px; width: 2px; height: 108px;
  background: linear-gradient(#9a2b12, #5a1a0a); transform-origin: 50% 100%; transition: transform .7s cubic-bezier(.4,1.6,.5,1); }
.hub { position: absolute; left: calc(50% - 7px); bottom: -5px; width: 14px; height: 14px; border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #d9b47c, var(--brass) 60%, #6b4f2a); }

.tape { position: relative; margin: 16px auto 0; width: 300px; max-width: 100%; height: 8px; border-radius: 4px;
  background: #2c180b; box-shadow: inset 0 1px 3px rgba(0,0,0,.7); cursor: pointer; }
.tape-fill { position: absolute; inset: 0 auto 0 0; border-radius: 4px;
  background: linear-gradient(90deg, #a07a44, var(--amber)); }
.tape-flag { position: absolute; top: -3px; width: 3px; height: 14px; margin-left: -1px;
  background: var(--flag); border-radius: 1px; }
.tape-flag.auto { background: #5aa3c2; top: -1px; height: 10px; }
.time { text-align: center; margin-top: 8px; font-family: "Special Elite", "Courier New", monospace;
  color: #e8d3a8; font-size: 15px; letter-spacing: .06em; }

.controls { display: flex; justify-content: space-between; align-items: center; margin-top: 16px; gap: 10px; }
.knob-wrap { display: flex; flex-direction: column; align-items: center; gap: 6px; user-select: none; }
.knob { width: 66px; height: 66px; border-radius: 50%; cursor: grab; position: relative; touch-action: none;
  background:
    repeating-conic-gradient(rgba(255,255,255,.06) 0 6deg, rgba(0,0,0,.18) 6deg 12deg),
    radial-gradient(circle at 38% 32%, #6a4128, var(--bakelite) 62%, #1e120a);
  box-shadow: 0 5px 10px rgba(0,0,0,.5), inset 0 0 0 3px rgba(0,0,0,.25); transition: transform .15s; }
.knob-mark { position: absolute; left: calc(50% - 2px); top: 6px; width: 4px; height: 16px; border-radius: 2px;
  background: #e6cfa0; }
.knob-label { font-size: 11px; color: #e3cc9e; letter-spacing: .12em; text-transform: uppercase; }
.keys { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.key-row { display: flex; gap: 6px; }
.key { font: inherit; font-family: "Special Elite", "Courier New", monospace; font-size: 13px; cursor: pointer;
  color: #f1e2c2; background: linear-gradient(#4c2e1b, #2f1b0f); border: 1px solid #1d1008; border-radius: 6px;
  padding: 8px 10px; min-width: 48px; box-shadow: 0 3px 0 #160c05, inset 0 1px 0 rgba(255,255,255,.08); }
.key:active { transform: translateY(2px); box-shadow: 0 1px 0 #160c05; }
.key:disabled { opacity: .45; cursor: default; }
.key.play { min-width: 56px; font-size: 15px; }
.key.clipped { color: #f6ddd5; background: linear-gradient(#8a3524, #5e2016); letter-spacing: .1em;
  text-transform: uppercase; font-size: 12px; padding: 7px 16px; }
.reasons { display: flex; justify-content: center; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
.reason { font: inherit; font-family: "Special Elite", "Courier New", monospace; font-size: 11px; cursor: pointer;
  color: #d9c49a; background: rgba(0,0,0,.28); border: 1px solid rgba(0,0,0,.4); border-radius: 12px; padding: 3px 10px; }
.reason.on { color: #f6ddd5; background: #7a2e1f; border-color: #3b150d; }
.badge { text-align: center; margin-top: 16px; font-size: 10px; letter-spacing: .3em; text-transform: uppercase;
  color: rgba(232, 211, 168, .55); }

.card { width: min(440px, 100%); background: var(--paper); border-radius: 4px; padding: 16px 18px 12px;
  box-shadow: 0 10px 30px rgba(0,0,0,.45);
  background-image: repeating-linear-gradient(transparent 0 27px, rgba(80,60,40,.08) 27px 28px); }
.card-head { display: flex; gap: 10px; align-items: baseline; font-family: "Special Elite", "Courier New", monospace;
  font-size: 13px; color: var(--muted); border-bottom: 1px solid rgba(80,60,40,.25); padding-bottom: 8px; }
.card-title { color: var(--ink); font-family: "Playfair Display", Georgia, serif; font-weight: 600; font-size: 17px; }
.versions { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
.versions-label { font-family: "Special Elite", monospace; font-size: 11px; color: var(--muted); letter-spacing: .08em;
  text-transform: uppercase; margin-right: 4px; }
.ver { font: inherit; font-family: "Special Elite", monospace; font-size: 12px; cursor: pointer; color: var(--ink);
  background: none; border: 1px solid rgba(80,60,40,.4); border-radius: 4px; padding: 2px 9px; }
.ver.on { background: #4a3522; color: #f1e2c2; border-color: #4a3522; }
.script p { margin: 10px 0; line-height: 1.45; }
.script b { font-family: "Special Elite", "Courier New", monospace; font-weight: normal; font-size: 12px;
  letter-spacing: .06em; margin-right: 6px; color: var(--muted); }
.script .now { font-size: 18px; min-height: 52px; }
.script .now b { color: #8a4a1c; }
.script .now.auto { border-left: 3px solid var(--auto); padding-left: 8px; }
.script .dim { font-size: 13px; color: var(--muted); opacity: .75; }
.scores { display: flex; flex-wrap: wrap; gap: 4px 10px; margin: 2px 0 6px; font-family: "Special Elite", monospace;
  font-size: 11px; color: var(--muted); }
.scores .score i { font-style: normal; opacity: .75; }
.scores .fail { color: var(--auto); font-weight: bold; }
.flags { margin-top: 8px; border-top: 1px dashed rgba(80,60,40,.3); padding-top: 8px; }
.flags-head, .chapters-head { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--flag); margin-bottom: 4px; }
.flag-row { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 3px 0; }
.flag-row.auto .jump, .flag-row.auto .flag-text b { color: var(--auto); }
.flag-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.flag-text b { font-family: "Special Elite", monospace; font-weight: normal; font-size: 11px; color: var(--flag); }
.flag-line { color: var(--muted); }
.jump, .x { font: inherit; border: none; background: none; cursor: pointer; color: var(--flag); padding: 2px 4px; }
.jump { font-family: "Special Elite", monospace; font-size: 12px; }
.x { font-size: 16px; color: var(--muted); }
.chapters { margin-top: 10px; border-top: 1px dashed rgba(80,60,40,.3); padding-top: 8px; }
.chapters-head { color: var(--muted); }
.chapter-empty { font-size: 13px; color: var(--muted); font-style: italic; padding: 4px 0; }
.chapter { display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left; font: inherit; font-size: 14px;
  cursor: pointer; background: none; border: none; border-radius: 3px; padding: 4px 4px; color: var(--ink); }
.chapter.on { background: rgba(80,60,40,.12); }
.chapter-n { font-family: "Special Elite", monospace; font-size: 12px; color: var(--muted); min-width: 18px; }
.chapter-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chapter-meta { font-family: "Special Elite", monospace; font-size: 11px; color: var(--muted); }
.chapter-meta em { font-style: normal; }
.chapter-meta .auto { color: var(--auto); }
.chapter-meta .human { color: var(--flag); }
.hint { margin-top: 10px; font-size: 11px; color: var(--muted); text-align: center; letter-spacing: .03em; }
.toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); max-width: calc(100% - 32px);
  background: #2b1a10; color: #f1e2c2; border: 1px solid #5e2016; border-radius: 6px; padding: 10px 14px;
  font-size: 13px; box-shadow: 0 8px 24px rgba(0,0,0,.5); }
`;
