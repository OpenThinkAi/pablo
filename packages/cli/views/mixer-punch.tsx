import { useCallback, useEffect, useRef, useState } from "react";
import type { ViewProps } from "@openthink/ui-leaf/view";
import type { ChosenTakePayload, ClipAudioPayload, FlagsPayload, LineTake, LineTakesPayload, ManifestLine, PunchFlag, RetakePayload } from "./mixer-protocol";
import { REASONS } from "./review-protocol";

/**
 * The punch list in the mixer (AGT-2155, D-19). A hook (`usePunch`: the episode's open flags, the line being worked
 * on, its takes, and the host calls) and a side panel (`PunchPanel`), kept apart from the editing view. Flag a line
 * with a reason (the review player's format), re-take it (`pablo fix --line`: the reason is what the re-take
 * changes), then compare every take the line has had and choose one (`pablo takes choose`). A re-take or a choice
 * writes a new manifest version and remixes it, so the saved mix is rebased onto it; the window then reloads.
 */

type Mutate = ViewProps<unknown>["mutate"];

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One flag as the list shows it: `L7 MAVIS · flat` (an auto flag names its failing gates). */
export function flagLabel(flag: PunchFlag, lines: readonly ManifestLine[]): string {
  const speaker = lines.find((l) => l.i === flag.line)?.speaker;
  const why = flag.source === "auto" ? `auto: ${flag.failing.length > 0 ? flag.failing.join(", ") : flag.reason}` : flag.reason;
  return `L${flag.line}${speaker === undefined ? "" : ` ${speaker}`} · ${why}`;
}

/** One take as the compare list shows it: status, length and where it came from. */
export function takeLabel(take: LineTake): string {
  const versions = take.versions.map((v) => `v${v}`).join(", ");
  const made = take.reasons.length > 0 ? `re-take for ${take.reasons.join(", ")}` : take.chosen ? "chosen back" : "performed";
  const seconds = take.seconds === null ? "" : ` · ${take.seconds.toFixed(2)} s`;
  return `${take.key.slice(0, 8)} · ${take.status ?? "?"}${seconds} · ${made} · ${versions}`;
}

/** The lines a flag can be put on, with the flagged ones first. */
export function lineOptions(lines: readonly ManifestLine[], flags: readonly PunchFlag[]): ManifestLine[] {
  const flagged = new Set(flags.map((f) => f.line));
  return [...lines].sort((a, b) => Number(flagged.has(b.i)) - Number(flagged.has(a.i)) || a.i - b.i);
}

export interface PunchApi {
  readonly flags: readonly PunchFlag[];
  readonly line: number | null;
  readonly reason: string;
  readonly takes: LineTakesPayload | null;
  readonly busy: string | null;
  readonly status: string | null;
  readonly failed: boolean;
  /** The take playing in the compare list, by key. */
  readonly playing: string | null;
  select(line: number | null): void;
  setReason(reason: string): void;
  flag(): void;
  unflag(): void;
  retake(): void;
  compare(): void;
  play(take: LineTake): void;
  choose(take: LineTake): void;
}

export function usePunch(args: {
  mutate: Mutate;
  episode: number;
  /** Called after a re-take or a choice wrote and remixed a version: the window reloads the newest mix. */
  onChanged: () => void;
}): PunchApi {
  const { mutate, episode, onChanged } = args;
  const [flags, setFlags] = useState<readonly PunchFlag[]>([]);
  const [line, setLine] = useState<number | null>(null);
  const [reason, setReason] = useState<string>(REASONS[0]);
  const [takes, setTakes] = useState<LineTakesPayload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);

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
    mutate<FlagsPayload>("listFlags", { episode })
      .then((p) => live && setFlags(p.flags))
      .catch((e) => live && fail(e));
    return () => {
      live = false;
    };
  }, [mutate, episode, fail]);

  const stop = useCallback(() => {
    player.current?.pause();
    player.current = null;
    setPlaying(null);
  }, []);
  useEffect(() => stop, [stop]);

  const select = useCallback(
    (next: number | null) => {
      stop();
      setLine(next);
      setTakes(null);
      ok(null);
    },
    [stop, ok],
  );

  /** One host call at a time, named while it runs. */
  const run = useCallback(
    async <T,>(what: string, call: () => Promise<T>): Promise<T | undefined> => {
      if (busy !== null) return undefined;
      setBusy(what);
      try {
        return await call();
      } catch (e) {
        fail(e);
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [busy, fail],
  );

  const flag = useCallback(() => {
    if (line === null) return;
    void run("Flagging…", () => mutate<FlagsPayload>("flag", { episode, line, reason })).then((p) => {
      if (p === undefined) return;
      setFlags(p.flags);
      ok(`Line ${line} flagged: ${reason}.`);
    });
  }, [line, reason, run, mutate, episode, ok]);

  const unflag = useCallback(() => {
    if (line === null) return;
    void run("Unflagging…", () => mutate<FlagsPayload>("unflag", { episode, line })).then((p) => {
      if (p === undefined) return;
      setFlags(p.flags);
      ok(`Line ${line}'s flags removed.`);
    });
  }, [line, run, mutate, episode, ok]);

  const retake = useCallback(() => {
    if (line === null) return;
    stop();
    void run(`Re-taking line ${line} (${reason})…`, () => mutate<RetakePayload>("retake", { episode, line, reason })).then((p) => {
      if (p === undefined) return;
      setFlags(p.flags);
      setTakes(p.takes);
      ok(`${p.message}. Compare the takes below and choose one.`);
      onChanged();
    });
  }, [line, reason, stop, run, mutate, episode, ok, onChanged]);

  const compare = useCallback(() => {
    if (line === null) return;
    void run("Loading takes…", () => mutate<LineTakesPayload>("lineTakes", { episode, line })).then((p) => {
      if (p === undefined) return;
      setTakes(p);
      ok(p.takes.length < 2 ? `Line ${line} has only ever had one take: re-take it to have another to compare.` : null);
    });
  }, [line, run, mutate, episode, ok]);

  const play = useCallback(
    (take: LineTake) => {
      if (playing === take.key) {
        stop();
        return;
      }
      stop();
      mutate<ClipAudioPayload>("clipAudio", { source: { kind: "take", key: take.key, stretch: take.stretch ?? 1 } }).then((a) => {
        const audio = new Audio(`data:${a.mime};base64,${a.b64}`);
        audio.onended = () => setPlaying((cur) => (cur === take.key ? null : cur));
        player.current = audio;
        setPlaying(take.key);
        void audio.play();
      }, fail);
    },
    [playing, stop, mutate, fail],
  );

  const choose = useCallback(
    (take: LineTake) => {
      if (line === null) return;
      stop();
      void run(`Choosing take ${take.key.slice(0, 8)}…`, () => mutate<ChosenTakePayload>("chooseTake", { episode, line, take: take.key })).then((p) => {
        if (p === undefined) return;
        setTakes(p.takes);
        ok(`${p.message}.`);
        onChanged();
      });
    },
    [line, stop, run, mutate, episode, ok, onChanged],
  );

  return { flags, line, reason, takes, busy, status, failed, playing, select, setReason, flag, unflag, retake, compare, play, choose };
}

/** The side panel. `locked` (unsaved mix edits) holds back a re-take or a choice: each reloads the window. */
export function PunchPanel({ api, lines, locked, onJump }: { api: PunchApi; lines: readonly ManifestLine[]; locked: boolean; onJump: (t: number) => void }) {
  const chosen = api.line === null ? undefined : lines.find((l) => l.i === api.line);
  const flagged = api.line !== null && api.flags.some((f) => f.line === api.line && f.source === "human");
  const idle = api.busy === null;
  return (
    <aside className="punch" aria-label="Punch list">
      <div className="pu-top">
        <strong>Punch list ({api.flags.length})</strong>
      </div>
      {api.flags.length === 0 && <p className="pu-empty">No open flags. Pick a line below to flag it, or flag lines in pablo review.</p>}
      <ul className="pu-list">
        {api.flags.map((f) => (
          <li key={f.id} className={`pu-row${f.source === "auto" ? " auto" : ""}${f.line === api.line ? " on" : ""}`}>
            <button type="button" className="pu-time" onClick={() => onJump(f.time)} title="Play from here">
              ▶
            </button>
            <button type="button" className="pu-flag" onClick={() => api.select(f.line)}>
              {flagLabel(f, lines)}
            </button>
          </li>
        ))}
      </ul>
      <div className="pu-line">
        <select aria-label="Line" value={api.line ?? ""} onChange={(e) => api.select(e.currentTarget.value === "" ? null : Number(e.currentTarget.value))}>
          <option value="">Choose a line…</option>
          {lineOptions(lines, api.flags).map((l) => (
            <option key={l.i} value={l.i}>
              L{l.i} {l.speaker}: {l.text.length > 48 ? `${l.text.slice(0, 47)}…` : l.text}
            </option>
          ))}
        </select>
        {chosen !== undefined && <p className="pu-text">{chosen.text}</p>}
        <div className="pu-actions">
          <select aria-label="Reason" value={api.reason} onChange={(e) => api.setReason(e.currentTarget.value)} disabled={api.line === null}>
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button type="button" onClick={api.flag} disabled={api.line === null || !idle} title="Write the flag to flags.json, as pablo review does">
            Flag
          </button>
          <button type="button" onClick={api.unflag} disabled={!flagged || !idle} title="Remove this line's flags">
            Unflag
          </button>
        </div>
        <div className="pu-actions">
          <button type="button" className="pu-go" onClick={api.retake} disabled={api.line === null || !idle || locked} title="Flag with this reason, re-record the line (pablo fix --line) and remix">
            Re-take
          </button>
          <button type="button" onClick={api.compare} disabled={api.line === null || !idle} title="Every take this line has had (pablo takes line)">
            Compare takes
          </button>
        </div>
        {locked && api.line !== null && <p className="pu-hint">Save your mix edits first: a re-take or a choice reloads the window.</p>}
      </div>
      {api.busy !== null && <div className="pu-status">{api.busy}</div>}
      {api.status !== null && <div className={`pu-status${api.failed ? " warn" : ""}`}>{api.status}</div>}
      {api.takes !== null && (
        <ul className="pu-takes" aria-label="Takes">
          {api.takes.takes.map((t) => (
            <li key={t.key} className={`pu-take${t.current ? " current" : ""}`}>
              <button type="button" onClick={() => api.play(t)} disabled={!t.stored} title={t.stored ? "Play this take (paced)" : "Archived by takes gc"}>
                {api.playing === t.key ? "Stop" : "Play"}
              </button>
              <span className="pu-take-label">
                {takeLabel(t)}
                {t.failing.length > 0 ? ` · failing ${t.failing.join(", ")}` : ""}
              </span>
              {t.current ? (
                <span className="pu-current">in use</span>
              ) : (
                <button type="button" className="pu-go" onClick={() => api.choose(t)} disabled={!t.stored || !idle || locked} title="Put this take back on the line (pablo takes choose) and remix">
                  Choose
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

export const PUNCH_CSS = `
.punch { flex: none; width: 320px; align-self: stretch; border-left: 1px solid var(--line); background: var(--panel); padding: 8px; overflow-y: auto; max-height: calc(100vh - 110px); font-size: 12px; }
.pu-top { margin-bottom: 6px; }
.pu-empty, .pu-hint, .pu-text { color: var(--muted); margin: 4px 0; }
.pu-list, .pu-takes { list-style: none; margin: 0; padding: 0; }
.pu-row { display: flex; align-items: center; gap: 6px; border-top: 1px solid var(--line); padding: 4px 0; }
.pu-row.auto .pu-flag { color: var(--muted); }
.pu-row.on .pu-flag { color: var(--accent); }
.pu-flag { flex: 1; text-align: left; background: none; border: 0; padding: 2px 0; }
.pu-time { padding: 0 6px; font-size: 10px; }
.pu-line { border-top: 1px solid var(--line); margin-top: 6px; padding-top: 6px; }
.pu-line > select { width: 100%; }
.pu-actions { display: flex; gap: 6px; margin: 6px 0; flex-wrap: wrap; }
button.pu-go:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.pu-status { color: var(--muted); margin: 4px 0; word-break: break-word; }
.pu-take { display: flex; align-items: center; gap: 6px; border-top: 1px solid var(--line); padding: 4px 0; }
.pu-take.current .pu-take-label { color: var(--accent); }
.pu-take-label { flex: 1; min-width: 0; word-break: break-word; }
.pu-current { color: var(--accent); font-size: 11px; }
`;
