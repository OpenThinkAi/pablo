import { useEffect, useState } from "react";
import type { ViewProps } from "@openthink/ui-leaf/view";
import type { CueOption, CueOptionsPayload, RegeneratedCuePayload } from "./mixer-protocol";

/**
 * Regenerate a cue (AGT-2156, D-19): right-click a cue clip, then either edit its description and regenerate, or pick
 * a variation (another recording, or the generator's asset). The new cue replaces the clip's source in place in the
 * next mix version (`regenerateCue`: position, fades and gain stay); the view reloads it. Kept apart from `mixer.tsx`:
 * this file owns the panel and its two host calls.
 */

type Mutate = ViewProps<unknown>["mutate"];

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const isCueClip = (source: { readonly kind: string }): boolean => source.kind === "cue";

export interface CuePanelProps {
  readonly mutate: Mutate;
  readonly episode: number;
  /** The mix version the window shows; regenerating writes the one after it. */
  readonly base: number;
  readonly clip: string;
  /** Edits not yet saved: regenerating works from the saved mix, so they must be saved first. */
  readonly unsaved: boolean;
  readonly onDone: (done: RegeneratedCuePayload) => void;
  readonly onClose: () => void;
}

export function CuePanel({ mutate, episode, base, clip, unsaved, onDone, onClose }: CuePanelProps) {
  const [info, setInfo] = useState<CueOptionsPayload | null>(null);
  const [text, setText] = useState("");
  const [options, setOptions] = useState<readonly CueOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setInfo(null);
    setProblem(null);
    mutate<CueOptionsPayload>("cueOptions", { episode, clip })
      .then((p) => {
        if (!live) return;
        setInfo(p);
        setText(p.desc);
        setOptions(p.options);
      })
      .catch((e) => live && setProblem(errorText(e)));
    return () => {
      live = false;
    };
  }, [mutate, episode, clip, base]);

  const look = async () => {
    setProblem(null);
    try {
      const p = await mutate<CueOptionsPayload>("cueOptions", { episode, clip, describe: text });
      setOptions(p.options);
    } catch (e) {
      setProblem(errorText(e));
    }
  };

  const regenerate = async (pick?: CueOption) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const done = await mutate<RegeneratedCuePayload>("regenerateCue", {
        episode,
        base,
        clip,
        describe: text,
        ...(pick === undefined ? {} : pick.generated ? { generated: true } : { sound: pick.id }),
      });
      onDone(done);
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cue-panel">
      <div className="cue-head">
        <span className="cue-title">Regenerate cue{info === null ? "" : ` (${info.kind})`}</span>
        <button type="button" className="insp-close" onClick={onClose} title="Close">
          ×
        </button>
      </div>
      {unsaved && <div className="warn">Save your edits first: a regenerated cue is written as the next mix version.</div>}
      <div className="cue-row">
        <input type="text" className="cue-desc" aria-label="Cue description" value={text} disabled={info === null || busy} onChange={(e) => setText(e.currentTarget.value)} />
        <button type="button" onClick={() => void look()} disabled={info === null || busy}>
          Show variations
        </button>
        <button type="button" className="cue-go" onClick={() => void regenerate()} disabled={info === null || busy || unsaved}>
          {busy ? "Working…" : "Regenerate"}
        </button>
      </div>
      <ul className="cue-options">
        {options.map((o) => (
          <li key={o.key}>
            <span className="cue-label">
              {o.label}
              {o.current ? " (playing)" : ""}
            </span>
            <span className="cue-meta">{o.generated ? "made by the generator" : `recording${o.words.length > 0 ? `: ${o.words.join(", ")}` : ""}`}{o.made ? "" : " · will be made"}</span>
            <button type="button" onClick={() => void regenerate(o)} disabled={busy || unsaved || o.current}>
              Use this
            </button>
          </li>
        ))}
      </ul>
      {problem !== null && <div className="warn cue-problem">{problem}</div>}
    </div>
  );
}

export const CUE_CSS = `
.cue-panel { padding: 6px 16px; border-bottom: 1px solid var(--line); background: var(--panel); font-size: 12px; }
.cue-head { display: flex; align-items: center; justify-content: space-between; }
.cue-title { font-weight: 600; }
.cue-row { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
.cue-desc { flex: 1; min-width: 0; background: var(--panel-2); color: var(--text); border: 1px solid var(--line); border-radius: 4px; padding: 3px 6px; font: inherit; }
button.cue-go:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.cue-options { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.cue-options li { display: flex; align-items: center; gap: 12px; }
.cue-label { font-weight: 600; min-width: 140px; }
.cue-meta { flex: 1; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`;
