import { useCallback, useEffect, useRef, useState } from "react";
import type { ViewProps } from "@openthink/ui-leaf/view";
import type { ExportPayload, MixPayload, NotesPayload, ToFlagsPayload } from "./mixer-protocol";
import type { PlacedClip } from "./mixer-logic";
import { CATEGORY_LETTER, KEY_CATEGORY, flagDraft, mmss, newMarker, nextMarkerId, playingSummary, removeMarker, upsertMarker } from "./mixer-notes";
import type { Category, Marker } from "./mixer-notes";

/**
 * Mixer markers (AGT-1792). Three keys while listening: **f** = clipped, **s** = sound effect, **g** = general
 * comment (**m** is an alias for g). A key pauses playback and opens one text field in the marker's own row;
 * Enter saves and resumes, Esc cancels and resumes. A hook (`useMarkers`: state, the keys, the host calls) and a
 * side panel (`MarkersPanel`), kept apart from the editing view. The model is `mixer-notes.ts`; the files are the
 * host's (`renders/epNN/notes.json`, `punch-list.md`, `flags.json`).
 */

type Mutate = ViewProps<unknown>["mutate"];

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A marker being typed: not saved until Enter. */
export interface Draft {
  readonly marker: Marker;
  readonly wasPlaying: boolean;
}

export interface MarkersApi {
  readonly notes: readonly Marker[];
  readonly draft: Draft | null;
  readonly status: string | null;
  readonly failed: boolean;
  readonly exported: ExportPayload | null;
  /** Pause, and open the note field for a new marker of this category at the playhead. */
  begin(category: Category): void;
  /** Enter on the draft: save it with this note, then resume if it was playing. */
  commit(note: string): void;
  /** Esc on the draft: drop it, then resume if it was playing. */
  cancel(): void;
  save(marker: Marker): void;
  remove(id: string): void;
  exportList(): void;
  toFlags(ids?: readonly string[]): void;
}

export function useMarkers(args: {
  mutate: Mutate;
  episode: number;
  payload: MixPayload | null;
  placed: readonly PlacedClip[];
  /** The playhead now, in seconds. */
  getTime: () => number;
  /** Pauses playback; true when it was playing. */
  pause: () => boolean;
  resume: () => void;
}): MarkersApi {
  const { mutate, episode, payload, placed, getTime, pause, resume } = args;
  const [notes, setNotes] = useState<readonly Marker[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [exported, setExported] = useState<ExportPayload | null>(null);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const fail = useCallback((e: unknown) => {
    setFailed(true);
    setStatus(errorText(e));
  }, []);
  const ok = useCallback((text: string | null) => {
    setFailed(false);
    setStatus(text);
  }, []);

  useEffect(() => {
    let live = true;
    mutate<NotesPayload>("listNotes", { episode })
      .then((p) => live && setNotes(p.notes))
      .catch((e) => live && fail(e));
    return () => {
      live = false;
    };
  }, [mutate, episode, fail]);

  const save = useCallback(
    (marker: Marker) => {
      setNotes((cur) => upsertMarker(cur, marker));
      mutate<NotesPayload>("saveNote", { episode, marker }).then(() => ok(null), fail);
    },
    [mutate, episode, ok, fail],
  );

  const begin = useCallback(
    (category: Category) => {
      if (payload === null || draftRef.current !== null) return;
      const wasPlaying = pause();
      const marker = newMarker({ id: nextMarkerId(notesRef.current), t: getTime(), mixVersion: payload.version, manifest: payload.manifest, placed, now: new Date().toISOString(), category });
      setDraft({ marker, wasPlaying });
    },
    [payload, placed, getTime, pause],
  );

  const commit = useCallback(
    (note: string) => {
      const d = draftRef.current;
      if (d === null) return;
      setDraft(null);
      save({ ...d.marker, note: note.trim() });
      if (d.wasPlaying) resume();
    },
    [save, resume],
  );

  const cancel = useCallback(() => {
    const d = draftRef.current;
    if (d === null) return;
    setDraft(null);
    if (d.wasPlaying) resume();
  }, [resume]);

  const remove = useCallback(
    (id: string) => {
      setNotes((cur) => removeMarker(cur, id));
      mutate<NotesPayload>("deleteNote", { episode, id }).then(() => ok(null), fail);
    },
    [mutate, episode, ok, fail],
  );

  const exportList = useCallback(() => {
    mutate<ExportPayload>("exportNotes", { episode }).then((p) => {
      setExported(p);
      ok(`Punch list written: ${p.path}`);
    }, fail);
  }, [mutate, episode, ok, fail]);

  const toFlags = useCallback(
    (ids?: readonly string[]) => {
      mutate<ToFlagsPayload>("notesToFlags", { episode, ...(ids === undefined ? {} : { ids }) }).then((p) => {
        const skipped = p.skipped.length === 0 ? "" : `; ${p.skipped.length} skipped (only clipped dialogue markers become flags)`;
        ok(`${p.written.length} ${p.written.length === 1 ? "flag" : "flags"} written to flags.json${skipped}. Run pablo fix to act on them.`);
      }, fail);
    },
    [mutate, episode, ok, fail],
  );

  // f / s / g (and m = g) pause and open the note field. Not while typing in a field, not with a modifier.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const category = KEY_CATEGORY[e.key.toLowerCase()];
      if (category === undefined || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      begin(category);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [begin]);

  return { notes, draft, status, failed, exported, begin, commit, cancel, save, remove, exportList, toFlags };
}

/** One row: `mm:ss  [F|S|G]  <what was playing>  — <note>`. The note is the text field while it is being typed. */
function MarkerRow({ marker, typing, onJump, onCommit, onCancel, onRemove, onFlag }: { marker: Marker; typing: boolean; onJump: () => void; onCommit: (note: string) => void; onCancel: () => void; onRemove: (() => void) | null; onFlag: (() => void) | null }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(marker.note);
  const field = useRef<HTMLInputElement | null>(null);
  const open = typing || editing;
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);
  const finish = (save: boolean) => {
    setEditing(false);
    if (save) onCommit(text);
    else {
      setText(marker.note);
      onCancel();
    }
  };
  const letter = marker.category === null ? "·" : CATEGORY_LETTER[marker.category];
  return (
    <li className={`mk-row${typing ? " typing" : ""}`}>
      <button type="button" className="mk-time" onClick={onJump} title="Jump the playhead here">
        {mmss(marker.time)}
      </button>
      <span className={`mk-cat mk-${letter}`} title={marker.category ?? ""}>
        [{letter}]
      </span>
      <span className="mk-playing">{playingSummary(marker)}</span>
      <span className="mk-dash">—</span>
      {open ? (
        <input
          ref={field}
          className="mk-input"
          type="text"
          value={text}
          placeholder="what is going on?"
          aria-label="Note"
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              finish(true);
            } else if (e.key === "Escape") {
              e.preventDefault();
              finish(false);
            }
          }}
        />
      ) : (
        <span className="mk-note" onClick={() => setEditing(true)} title="Click to edit">
          {marker.note === "" ? "(no note)" : marker.note}
        </span>
      )}
      {onFlag !== null && !open && (
        <button type="button" className="mk-small" onClick={onFlag} title="Write this as a clipped flag for pablo fix">
          to flag
        </button>
      )}
      {onRemove !== null && !open && (
        <button type="button" className="mk-small" onClick={onRemove} title="Delete this marker" aria-label="Delete marker">
          ×
        </button>
      )}
    </li>
  );
}

/** The side panel: the markers in time order (the one being typed among them), with export and to-flags. */
export function MarkersPanel({ api, onJump }: { api: MarkersApi; onJump: (t: number) => void }) {
  const clipped = api.notes.filter((m) => flagDraft(m, 0) !== null).length;
  return (
    <aside className="markers" aria-label="Markers">
      <div className="mk-top">
        <strong>Markers ({api.notes.length})</strong>
        <span className="mk-keys">
          <button type="button" onClick={() => api.begin("clipped")} title="Clipped (f)">
            F
          </button>
          <button type="button" onClick={() => api.begin("sound effect")} title="Sound effect (s)">
            S
          </button>
          <button type="button" onClick={() => api.begin("general")} title="General comment (g)">
            G
          </button>
        </span>
      </div>
      <div className="mk-actions">
        <button type="button" onClick={api.exportList} disabled={api.notes.length === 0} title="Write the punch list (renders/epNN/punch-list.md)">
          Export
        </button>
        <button type="button" onClick={() => api.toFlags()} disabled={clipped === 0} title="Write every clipped dialogue marker to flags.json for pablo fix">
          Clipped to flags
        </button>
      </div>
      {api.status !== null && <div className={`mk-status${api.failed ? " warn" : ""}`}>{api.status}</div>}
      {api.notes.length === 0 && api.draft === null && <p className="mk-empty">While listening: f = clipped, s = sound effect, g = general. Type the note, Enter saves, Esc cancels.</p>}
      <ul className="mk-list">
        {[...api.notes.map((m) => ({ m, typing: false })), ...(api.draft === null ? [] : [{ m: api.draft.marker, typing: true }])]
          .sort((a, b) => a.m.time - b.m.time)
          .map(({ m, typing }) => (
            <MarkerRow
              key={m.id}
              marker={m}
              typing={typing}
              onJump={() => onJump(m.time)}
              onCommit={(note) => (typing ? api.commit(note) : api.save({ ...m, note: note.trim(), updated: new Date().toISOString() }))}
              onCancel={typing ? api.cancel : () => undefined}
              onRemove={typing ? null : () => api.remove(m.id)}
              onFlag={!typing && flagDraft(m, 0) !== null ? () => api.toFlags([m.id]) : null}
            />
          ))}
      </ul>
      {api.exported !== null && (
        <details className="mk-export">
          <summary>Punch list ({api.exported.count})</summary>
          <pre>{api.exported.markdown}</pre>
        </details>
      )}
    </aside>
  );
}

/** Ruler pins and thin lines through the lanes. `inRuler` draws the pins; otherwise the lines. */
export function MarkerPins({ notes, pps, onJump, inRuler }: { notes: readonly Marker[]; pps: number; onJump: (t: number) => void; inRuler: boolean }) {
  return (
    <>
      {notes.map((m) =>
        inRuler ? (
          <button
            key={m.id}
            type="button"
            className="mk-pin"
            style={{ left: m.time * pps }}
            title={`${mmss(m.time)}${m.category === null ? "" : ` [${CATEGORY_LETTER[m.category]}]`}${m.note === "" ? "" : `\n${m.note}`}`}
            onClick={(e) => {
              e.stopPropagation();
              onJump(m.time);
            }}
            aria-label={`Marker at ${mmss(m.time)}`}
          />
        ) : (
          <div key={m.id} className="mk-line" style={{ left: m.time * pps }} />
        ),
      )}
    </>
  );
}

export const MARKERS_CSS = `
.markers { flex: none; width: 340px; align-self: stretch; border-left: 1px solid var(--line); background: var(--panel); padding: 8px; overflow-y: auto; max-height: calc(100vh - 110px); }
.mk-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.mk-keys { display: flex; gap: 4px; }
.mk-actions { display: flex; gap: 6px; margin: 6px 0; }
.mk-status { font-size: 12px; color: var(--muted); margin-bottom: 6px; word-break: break-word; }
.mk-empty { color: var(--muted); font-size: 12px; }
.mk-list { list-style: none; margin: 0; padding: 0; }
.mk-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 6px; border-top: 1px solid var(--line); padding: 6px 0; font-size: 12px; }
.mk-row.typing { background: rgba(201,154,91,.10); }
.mk-time { font-variant-numeric: tabular-nums; border-color: var(--accent); color: var(--accent); padding: 1px 6px; }
.mk-cat { font-weight: 700; color: var(--accent); }
.mk-playing { color: var(--muted); }
.mk-dash { color: var(--muted); }
.mk-note { cursor: text; }
.mk-input { flex: 1 1 100%; min-width: 0; background: var(--bg); color: var(--text); border: 1px solid var(--accent); border-radius: 4px; padding: 4px 6px; font: inherit; }
.mk-small { padding: 0 6px; font-size: 11px; }
.mk-export pre { white-space: pre-wrap; font-size: 11px; color: var(--muted); }
.mk-pin { position: absolute; top: 14px; width: 11px; height: 14px; margin-left: -5px; padding: 0; border: 0; border-radius: 2px 2px 6px 6px; background: var(--warn); z-index: 5; }
.mk-line { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--warn); opacity: .5; pointer-events: none; z-index: 2; }
`;
