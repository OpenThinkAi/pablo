import type { PlacedClip } from "./mixer-logic";
import { timecode } from "./mixer-logic";
import { CURVES, GAIN_MAX_DB, GAIN_MIN_DB, anchorText } from "./mixer-edit";
import type { FadeCurve, ManifestLine } from "./mixer-protocol";

/**
 * The selected clip's panel (AGT-1769): where it hangs, its slice of the source, gain (slider or number), both
 * fades (length and curve), and split at the playhead. Every control calls back with an edit; `mixer.tsx` turns it
 * into a document edit through `mixer-edit.ts`, so this file only draws.
 */

export interface InspectorProps {
  readonly placed: PlacedClip;
  readonly label: string;
  readonly lines: readonly ManifestLine[];
  readonly sourceSeconds: number | undefined;
  readonly playhead: number;
  readonly onGain: (db: number, gesture: string) => void;
  readonly onFade: (which: "in" | "out", change: { len?: number; curve?: FadeCurve }, gesture: string) => void;
  readonly onSplit: () => void;
  readonly onClose: () => void;
}

const num = (raw: string): number => (raw.trim() === "" ? Number.NaN : Number(raw));

function Fade({ which, placed, onFade }: { which: "in" | "out"; placed: PlacedClip; onFade: InspectorProps["onFade"] }) {
  const fade = which === "in" ? placed.clip.fade_in : placed.clip.fade_out;
  const id = placed.clip.id;
  return (
    <label className="insp-field">
      Fade {which}
      <input
        type="number"
        min={0}
        step={0.05}
        value={Number((fade?.len ?? 0).toFixed(3))}
        aria-label={`Fade ${which} length (seconds)`}
        onChange={(e) => {
          const len = num(e.currentTarget.value);
          if (Number.isFinite(len)) onFade(which, { len }, `fade-${which}-len:${id}`);
        }}
      />
      s
      <select value={fade?.curve ?? "linear"} aria-label={`Fade ${which} curve`} onChange={(e) => onFade(which, { curve: e.currentTarget.value as FadeCurve }, `fade-${which}-curve:${id}`)}>
        {CURVES.map((c) => (
          <option key={c} value={c}>
            {c === "scurve" ? "S-curve" : c}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Inspector({ placed, label, lines, sourceSeconds, playhead, onGain, onFade, onSplit, onClose }: InspectorProps) {
  const { clip } = placed;
  const gain = clip.gain ?? 0;
  const inside = playhead > placed.startSeconds && playhead < placed.endSeconds;
  return (
    <div className="inspector">
      <div className="insp-head">
        <span className="insp-name" title={label}>
          {label}
        </span>
        <span className="insp-meta">
          {timecode(placed.startSeconds, true)}–{timecode(placed.endSeconds, true)} · {anchorText(clip.anchor, lines)} · source {clip.in.toFixed(2)}–{clip.out.toFixed(2)} s
          {sourceSeconds === undefined ? "" : ` of ${sourceSeconds.toFixed(2)}`}
        </span>
        <button type="button" className="insp-close" onClick={onClose} title="Deselect (Esc)">
          ×
        </button>
      </div>
      <div className="insp-row">
        <label className="insp-field">
          Gain
          <input
            type="range"
            min={GAIN_MIN_DB}
            max={GAIN_MAX_DB}
            step={0.5}
            value={gain}
            aria-label="Clip gain (dB)"
            onChange={(e) => onGain(Number(e.currentTarget.value), `gain:${clip.id}`)}
            onDoubleClick={() => onGain(0, `gain-reset:${clip.id}`)}
          />
          <input
            type="number"
            className="insp-db"
            min={GAIN_MIN_DB}
            max={GAIN_MAX_DB}
            step={0.1}
            value={gain}
            aria-label="Clip gain in dB"
            onChange={(e) => {
              const db = num(e.currentTarget.value);
              if (Number.isFinite(db)) onGain(db, `gain-num:${clip.id}`);
            }}
          />
          dB
        </label>
        <Fade which="in" placed={placed} onFade={onFade} />
        <Fade which="out" placed={placed} onFade={onFade} />
        <button type="button" onClick={onSplit} disabled={!inside} title="Split this clip at the playhead (B)">
          Split at playhead
        </button>
      </div>
    </div>
  );
}

export const INSPECTOR_CSS = `
.inspector { padding: 6px 16px; border-bottom: 1px solid var(--line); background: var(--panel); font-size: 12px; }
.insp-head { display: flex; align-items: center; gap: 12px; min-width: 0; }
.insp-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40%; }
.insp-meta { color: var(--muted); flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.insp-close { padding: 0 7px; }
.insp-row { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; margin-top: 4px; }
.insp-field { display: flex; align-items: center; gap: 6px; color: var(--muted); }
.insp-field input[type=number] { width: 64px; background: var(--panel-2); color: var(--text); border: 1px solid var(--line); border-radius: 4px; padding: 2px 4px; font: inherit; }
.insp-field input[type=range] { width: 120px; accent-color: var(--accent); }
`;
