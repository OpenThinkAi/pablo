import { useCallback, useEffect, useRef, useState } from "react";
import type { ViewProps } from "@openthink/ui-leaf/view";
import type {
  AuditionPayload,
  BindPayload,
  CandidateAudioPayload,
  CastCandidatePayload,
  CastRole,
  CastRolesPayload,
  DescribePayload,
  LibraryVoice,
  PreviewPayload,
  ReperformPayload,
  VoicesPayload,
} from "./mixer-cast-protocol";
import { bindMessage, bindableVoices, defaultSlug, initialVoice, lineLabel, reperformOffer, traitsPhrase } from "./mixer-cast-logic";

/**
 * The mixer's Cast panel (AGT-2157, D-19): `pablo cast`, `audition`, `bind`, `voices` and `describe_voice` in the
 * mixer. Each role of the episode shows its `CAST:` description and its bound voice; any library voice can be
 * auditioned on one of the role's own lines and bound; a new voice can be designed from a description (audition
 * candidates, listen, cast one and bind it). Rebinding a role whose lines were performed in the old voice offers to
 * re-perform exactly those lines (`fix` on them, which re-records them and remixes the episode). The panel never reads a file: it calls the
 * host's Cast mutations (`mixer-cast-protocol.ts`, answered by `src/mixer-cast-host.ts`).
 */

type Mutate = ViewProps<unknown>["mutate"];

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface CastPanelProps {
  readonly mutate: Mutate;
  readonly episode: number;
  readonly onClose: () => void;
  /** After a re-perform wrote a new manifest version: the mixer reloads its mix (it is now behind that version). */
  readonly onReperformed?: () => void;
  /** Tests (static markup) hand the first answers in; the window asks the host. */
  readonly preloaded?: { readonly roles: CastRolesPayload; readonly voices: readonly LibraryVoice[] };
}

interface Status {
  readonly text: string;
  readonly kind: "ok" | "busy" | "warn";
}

export function CastPanel({ mutate, episode, onClose, onReperformed, preloaded }: CastPanelProps) {
  const [roles, setRoles] = useState<CastRolesPayload | null>(preloaded?.roles ?? null);
  const [voices, setVoices] = useState<readonly LibraryVoice[]>(preloaded?.voices ?? []);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [r, v] = await Promise.all([mutate<CastRolesPayload>("castRoles", { episode }), mutate<VoicesPayload>("listVoices", {})]);
      setRoles(r);
      setVoices(v.voices);
    } catch (e) {
      setStatus({ text: errorText(e), kind: "warn" });
    }
  }, [mutate, episode]);

  useEffect(() => {
    if (preloaded === undefined) void refresh();
    return () => player.current?.pause();
  }, [refresh, preloaded]);

  const play = useCallback((mime: string, b64: string) => {
    player.current?.pause();
    const audio = new Audio(`data:${mime};base64,${b64}`);
    player.current = audio;
    void audio.play();
  }, []);

  /** Runs one host call with the panel marked busy and its outcome on the status line. */
  const run = useCallback(async <T,>(label: string, work: () => Promise<T>, done: (value: T) => string | null): Promise<T | undefined> => {
    setBusy(label);
    setStatus({ text: `${label}…`, kind: "busy" });
    try {
      const value = await work();
      const text = done(value);
      setStatus(text === null ? null : { text, kind: "ok" });
      return value;
    } catch (e) {
      setStatus({ text: errorText(e), kind: "warn" });
      return undefined;
    } finally {
      setBusy(null);
    }
  }, []);

  const api: RoleApi = {
    busy,
    voices: bindableVoices(voices),
    preview: (role, line, voice) =>
      void run(`Reading line ${line + 1} of ${role} in ${voice}`, () => mutate<PreviewPayload>("previewVoice", { episode, line, voice }), (p) => {
        play(p.mime, p.b64);
        return `${p.voice} reading ${p.role}: “${p.text}”`;
      }),
    bind: (role, voice) =>
      void run(`Binding ${role} to ${voice}`, () => mutate<BindPayload>("bindVoice", { episode, role, voice }), (b) => {
        setRoles(b.roles);
        return bindMessage(b);
      }),
    reperform: (role) =>
      void run(`Re-performing ${role}'s lines (this loads the engine and takes a while)`, () => mutate<ReperformPayload>("reperformRole", { episode, role }), (r) => {
        void refresh();
        onReperformed?.();
        return r.message;
      }),
    describe: (role, describe) => run(`Reading the description`, () => mutate<DescribePayload>("describeVoice", { describe, role }), () => null),
    audition: (role, describe, slug, n) =>
      run(`Auditioning ${n} candidates for ${role} (this loads the designer and takes a while)`, () => mutate<AuditionPayload>("auditionVoices", { role, describe, slug, n }), (a) => a.message),
    listen: (slug, candidate) =>
      void run(`Loading candidate ${candidate}`, () => mutate<CandidateAudioPayload>("candidateAudio", { slug, candidate }), (c) => {
        play(c.mime, c.b64);
        return null;
      }),
    castAndBind: async (role, slug, candidate, recast) => {
      const made = await run(`Casting candidate ${candidate} as ${slug}`, () => mutate<CastCandidatePayload>("castCandidate", { role, slug, candidate, recast }), (c) => c.message);
      if (made === undefined) return;
      await refresh();
      api.bind(role, made.slug);
    },
  };

  return (
    <aside className="cast-panel" aria-label="Cast">
      <div className="cast-head">
        <span className="cast-title">Cast · episode {episode}</span>
        <button type="button" onClick={() => void refresh()} disabled={busy !== null} title="Read the roles and the library again">
          Refresh
        </button>
        <button type="button" onClick={onClose} title="Close the Cast panel">
          Close
        </button>
      </div>
      {status !== null && <div className={`cast-status ${status.kind}`}>{status.text}</div>}
      {roles === null ? (
        <div className="cast-empty">Reading the episode's cast…</div>
      ) : roles.roles.length === 0 ? (
        <div className="cast-empty">This episode's script names no roles.</div>
      ) : (
        roles.roles.map((r) => <RoleCard key={r.role} role={r} api={api} />)
      )}
    </aside>
  );
}

interface RoleApi {
  readonly busy: string | null;
  readonly voices: readonly LibraryVoice[];
  preview(role: string, line: number, voice: string): void;
  bind(role: string, voice: string): void;
  reperform(role: string): void;
  describe(role: string, describe: string): Promise<DescribePayload | undefined>;
  audition(role: string, describe: string, slug: string, n: number): Promise<AuditionPayload | undefined>;
  listen(slug: string, candidate: number): void;
  castAndBind(role: string, slug: string, candidate: number, recast: boolean): Promise<void>;
}

function RoleCard({ role, api }: { role: CastRole; api: RoleApi }) {
  const [line, setLine] = useState<number | undefined>(role.lines[0]?.i);
  const [voice, setVoice] = useState<string | undefined>(initialVoice(role, api.voices));
  const [designing, setDesigning] = useState(false);
  useEffect(() => {
    if (voice === undefined || !api.voices.some((v) => v.slug === voice)) setVoice(initialVoice(role, api.voices));
  }, [api.voices, role, voice]);
  const offer = reperformOffer(role);
  const idle = api.busy === null;
  const bound = role.voice;
  return (
    <section className="cast-role" data-role={role.role}>
      <div className="cast-role-head">
        <span className="cast-role-name">{role.role}</span>
        {role.gender !== null && <span className="cast-gender">{role.gender}</span>}
        <span className={`cast-bound${bound === null ? " none" : bound.state === "ok" ? "" : " warn"}`}>
          {bound === null ? "no voice" : `${bound.slug}${bound.state === "ok" ? "" : ` (card ${bound.state})`}${bound.by !== null ? ` · ${bound.by}` : ""}`}
        </span>
      </div>
      {role.description !== null && <div className="cast-desc">{role.description}</div>}
      {offer !== null && (
        <div className="cast-offer">
          <span>{offer}</span>
          <button type="button" className="accent" disabled={!idle} onClick={() => api.reperform(role.role)} title="Flag these lines and run pablo fix on them: they are re-recorded in the bound voice and the episode is remixed">
            Re-perform {role.stale.length}
          </button>
        </div>
      )}
      <div className="cast-row">
        <select aria-label={`Line of ${role.role}`} value={line} onChange={(e) => setLine(Number(e.currentTarget.value))} disabled={role.lines.length === 0}>
          {role.lines.map((l) => (
            <option key={l.i} value={l.i}>
              {lineLabel(l.i, l.text)}
            </option>
          ))}
        </select>
      </div>
      <div className="cast-row">
        <select aria-label={`Voice for ${role.role}`} value={voice} onChange={(e) => setVoice(e.currentTarget.value)} disabled={api.voices.length === 0}>
          {api.voices.map((v) => (
            <option key={v.slug} value={v.slug}>
              {v.slug}
              {v.description ? ` — ${v.description}` : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!idle || voice === undefined || line === undefined}
          onClick={() => voice !== undefined && line !== undefined && api.preview(role.role, line, voice)}
          title="Hear this library voice read the chosen line (nothing is written)"
        >
          Hear
        </button>
        <button type="button" className="accent" disabled={!idle || voice === undefined || voice === bound?.slug} onClick={() => voice !== undefined && api.bind(role.role, voice)} title="Bind the role to this voice in every episode of the work (pablo bind)">
          Bind
        </button>
      </div>
      <button type="button" className="cast-design-toggle" onClick={() => setDesigning((d) => !d)}>
        {designing ? "Hide new voice" : "Design a new voice…"}
      </button>
      {designing && <DesignForm role={role} api={api} />}
    </section>
  );
}

function DesignForm({ role, api }: { role: CastRole; api: RoleApi }) {
  const [describe, setDescribe] = useState(role.description ?? "");
  const [slug, setSlug] = useState(defaultSlug(role.role));
  const [n, setN] = useState(6);
  const [recast, setRecast] = useState(false);
  const [described, setDescribed] = useState<DescribePayload | null>(null);
  const [auditioned, setAuditioned] = useState<AuditionPayload | null>(null);
  const idle = api.busy === null;
  const ready = describe.trim() !== "" && slug.trim() !== "";
  return (
    <div className="cast-design">
      <textarea aria-label={`Description of a new voice for ${role.role}`} rows={3} value={describe} placeholder="15-40 words: gender, age, pitch, pace, manner" onChange={(e) => setDescribe(e.currentTarget.value)} />
      <div className="cast-row">
        <label>
          Slug <input value={slug} onChange={(e) => setSlug(e.currentTarget.value)} size={12} />
        </label>
        <label>
          Candidates <input type="number" min={1} max={24} value={n} onChange={(e) => setN(Math.max(1, Math.min(24, Number(e.currentTarget.value) || 1)))} style={{ width: 48 }} />
        </label>
        <label title="Replace the card if this slug is already cast (the old one is archived)">
          <input type="checkbox" checked={recast} onChange={(e) => setRecast(e.currentTarget.checked)} /> Recast
        </label>
      </div>
      <div className="cast-row">
        <button type="button" disabled={!idle || describe.trim() === ""} onClick={() => void api.describe(role.role, describe).then((d) => d !== undefined && setDescribed(d))} title="How pablo reads the description (describe_voice)">
          Check words
        </button>
        <button type="button" className="accent" disabled={!idle || !ready} onClick={() => void api.audition(role.role, describe, slug.trim(), n).then((a) => a !== undefined && setAuditioned(a))} title="Render candidates from the description (pablo audition)">
          Audition {n}
        </button>
      </div>
      {described !== null && (
        <div className="cast-traits">
          {traitsPhrase(described.traits) || "no traits recognised"}
          {described.freeText.length > 0 && <span className="warn"> · not in the vocabulary: {described.freeText.join("; ")}</span>}
        </div>
      )}
      {auditioned !== null && (
        <ul className="cast-candidates">
          {auditioned.candidates.map((c) => (
            <li key={c.candidate}>
              <span className="cast-candidate">#{c.candidate}</span>
              <span className="cast-score">
                {c.seconds.toFixed(1)} s{c.utmos !== null ? ` · MOS ${c.utmos.toFixed(2)}` : ""}
                {c.nearDuplicates.length > 0 ? ` · like #${c.nearDuplicates.join(", #")}` : ""}
                {c.referenceOk ? "" : " · reference unusable"}
              </span>
              <button type="button" disabled={!idle} onClick={() => api.listen(auditioned.slug, c.candidate)}>
                Play
              </button>
              <button type="button" className="accent" disabled={!idle || !c.referenceOk} onClick={() => void api.castAndBind(role.role, auditioned.slug, c.candidate, recast)} title="Freeze this candidate as the voice's card (pablo cast) and bind the role to it">
                Cast &amp; bind
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const CAST_CSS = `
.cast-panel { position: fixed; top: 0; right: 0; bottom: 0; width: 380px; z-index: 20; overflow-y: auto; background: var(--panel); border-left: 1px solid var(--line);
  box-shadow: -8px 0 24px rgba(0,0,0,.35); padding: 10px 12px 24px; }
.cast-head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.cast-title { flex: 1; font-weight: 600; }
.cast-status { font-size: 12px; margin: 0 0 8px; color: var(--muted); }
.cast-status.ok { color: #9fb98a; }
.cast-status.warn { color: var(--warn); }
.cast-empty { color: var(--muted); padding: 12px 0; }
.cast-role { border-top: 1px solid var(--line); padding: 10px 0; }
.cast-role-head { display: flex; align-items: baseline; gap: 8px; }
.cast-role-name { font-weight: 600; letter-spacing: .04em; }
.cast-gender { color: var(--muted); font-size: 11px; }
.cast-bound { margin-left: auto; font-size: 12px; color: var(--dialogue); }
.cast-bound.none { color: var(--muted); font-style: italic; }
.cast-bound.warn { color: var(--warn); }
.cast-desc { color: var(--muted); font-size: 12px; margin: 2px 0 6px; }
.cast-row { display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
.cast-row select { flex: 1; min-width: 0; }
.cast-offer { margin-top: 6px; padding: 6px 8px; background: #2a201c; color: var(--warn); font-size: 12px; border-radius: 4px; display: flex; gap: 8px; align-items: center; }
.cast-offer span { flex: 1; }
.cast-panel button.accent:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.cast-design-toggle { margin-top: 8px; font-size: 12px; }
.cast-design { margin-top: 6px; padding: 8px; background: var(--panel-2); border-radius: 4px; }
.cast-design textarea { width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 4px; font: inherit; padding: 4px 6px; }
.cast-design input { background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 4px; font: inherit; padding: 2px 4px; }
.cast-design label { font-size: 12px; color: var(--muted); }
.cast-traits { font-size: 12px; margin-top: 6px; }
.cast-candidates { list-style: none; margin: 8px 0 0; padding: 0; }
.cast-candidates li { display: flex; align-items: center; gap: 6px; padding: 3px 0; font-size: 12px; }
.cast-candidate { font-weight: 600; width: 28px; }
.cast-score { flex: 1; color: var(--muted); }
button.cast-toggle.on { border-color: var(--accent); color: var(--accent); }
`;
