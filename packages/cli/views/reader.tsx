import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { ViewProps } from "@openthink/ui-leaf/view";
import type { HostAnswer, ReaderData, Tag, ViewChapter } from "./reader-protocol";
import {
  canSubmit,
  chapterLabel,
  chapterNote,
  collidingSuggestion,
  describeDraft,
  draftReducer,
  editMark,
  excerpt,
  marksOf,
  ordered,
  segments,
  selectedText,
} from "./reader-logic";
import type { Position, Selection } from "./reader-logic";

/**
 * The reader's window (AGT-1586, `pm project show ai-terminal --doc readers`): a chapter as plain paragraphs,
 * marks made by selecting text. The view is dumb on purpose. It renders what pablo sent (`ReaderData`),
 * keeps the marks as a draft, and posts the draft back (`saveDraft` as she works, `submit` at the end);
 * every mapping to sentence lines and every GitHub call is pablo's, in tested code. It is bundled by the
 * ui-leaf binary, which supplies React; this file is type-checked by `bun run typecheck` (AGT-1295).
 */

const SAVE_DELAY_MS = 250;
const TAGS: readonly Tag[] = ["fix", "keep"];

interface Pending {
  readonly selection: Selection;
  readonly quote: string;
  readonly x: number;
  readonly y: number;
}

/** The place in a paragraph a DOM point is: characters from the paragraph's start (CSS-drawn ghosts add none). */
function positionOf(root: HTMLElement, node: Node, offset: number): Position | undefined {
  const el = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-p]");
  if (el === null || el === undefined || !root.contains(el)) return undefined;
  const range = document.createRange();
  range.setStart(el, 0);
  range.setEnd(node, offset);
  return { paragraph: Number(el.dataset["p"]), offset: range.toString().length };
}

function currentSelection(root: HTMLElement): Pending | undefined {
  const sel = window.getSelection();
  if (sel === null || sel.rangeCount === 0 || sel.isCollapsed) return undefined;
  const range = sel.getRangeAt(0);
  const a = positionOf(root, range.startContainer, range.startOffset);
  const b = positionOf(root, range.endContainer, range.endOffset);
  if (a === undefined || b === undefined) return undefined;
  const selection = ordered(a, b);
  const box = range.getBoundingClientRect();
  return { selection, quote: "", x: Math.max(8, Math.min(box.left, window.innerWidth - 340)), y: box.bottom + 8 };
}

export default function Reader({ data, mutate }: ViewProps<ReaderData>) {
  const [draft, dispatch] = useReducer(draftReducer, data.draft);
  const [sent, setSent] = useState(data.sent);
  const [current, setCurrent] = useState(0);
  const [pending, setPending] = useState<Pending | undefined>();
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revisions, setRevisions] = useState<Record<string, number>>({});
  const body = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  const chapter: ViewChapter | undefined = data.chapters[current];
  const readOnly = sent !== undefined;

  // Marks are saved as she works; the host answers a refusal in plain words.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (readOnly) return;
    setSaved(false);
    const timer = setTimeout(() => {
      mutate<HostAnswer>("saveDraft", { draft })
        .then((answer) => {
          if (answer.ok) {
            setSaved(true);
            setNotice("");
          } else setNotice(answer.message);
        })
        .catch((error: unknown) => setNotice(`Could not save your marks: ${error instanceof Error ? error.message : String(error)}`));
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, readOnly, mutate]);

  const chapterMarks = useMemo(() => (chapter === undefined ? [] : marksOf(draft, chapter.path)), [draft, chapter]);

  if (chapter === undefined) return <main style={page}>This round has no chapters.</main>;
  const note = chapterNote(draft, chapter.path);
  const revisionOf = (path: string): number => revisions[path] ?? 0;

  function pick(index: number): void {
    setPending(undefined);
    setCurrent(index);
  }

  function onSelect(): void {
    if (readOnly || body.current === null) return;
    const found = currentSelection(body.current);
    setPending(found === undefined || chapter === undefined ? undefined : { ...found, quote: selectedText(chapter.paragraphs, found.selection) });
  }

  // Typing straight into a paragraph is a suggestion, recorded when she leaves it.
  function onLeave(paragraph: number, el: HTMLElement): void {
    if (readOnly || chapter === undefined) return;
    const original = chapter.paragraphs[paragraph]?.text ?? "";
    const mark = editMark(chapter.path, paragraph, original, el.textContent ?? "");
    if (mark !== undefined && mark.kind === "suggestion") {
      if (collidingSuggestion(draft, chapter.path, mark.selection) !== undefined) setNotice("That text already has a suggestion. Remove or change it in the list first.");
      else dispatch({ type: "add", mark });
    }
    // Re-render the paragraph from the draft, so the typed text shows as a tracked change and not as raw DOM.
    setRevisions((r) => ({ ...r, [`${chapter.path}:${paragraph}`]: (r[`${chapter.path}:${paragraph}`] ?? 0) + 1 }));
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setNotice("");
    try {
      const answer = await mutate<HostAnswer>("submit", { draft });
      if (answer.ok && answer.sent !== undefined) setSent(answer.sent);
      else if (!answer.ok) setNotice(answer.message);
    } catch (error) {
      setNotice(`Could not send: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={shell}>
      <style>{css}</style>
      {data.chapters.length > 1 && (
        <nav style={nav} aria-label="Chapters">
          <div style={roundTitle}>{data.round.title}</div>
          {data.chapters.map((c, i) => (
            <button key={c.path} type="button" onClick={() => pick(i)} style={i === current ? { ...navItem, ...navActive } : navItem}>
              {chapterLabel(c)}
              <span style={count}>{marksOf(draft, c.path).length || ""}</span>
            </button>
          ))}
        </nav>
      )}

      <main style={page}>
        <h1 style={title}>{chapterLabel(chapter)}</h1>
        <div ref={body} onMouseUp={onSelect} onKeyUp={onSelect} style={prose}>
          {chapter.paragraphs.map((p, i) => (
            <p
              key={`${chapter.path}:${i}:${revisionOf(`${chapter.path}:${i}`)}`}
              data-p={i}
              contentEditable={readOnly ? false : "plaintext-only"}
              suppressContentEditableWarning
              spellCheck={false}
              onBlur={(e) => onLeave(i, e.currentTarget)}
              style={/^#{1,6} /.test(p.text) ? heading : undefined}
            >
              {segments(p.text, i, chapterMarks).map((s, k) => (
                <span
                  key={k}
                  className={["seg", s.comments.length > 0 ? `cm ${s.tag ?? "plain"}` : "", s.suggestions.length > 0 ? "strike" : "", s.ghosts.length > 0 ? "ghost" : ""].filter((c) => c !== "").join(" ")}
                  data-n={s.starts.map((n) => n + 1).join(",")}
                  data-ins={s.ghosts.map((g) => g.text || "(deleted)").join(" | ")}
                >
                  {s.text}
                </span>
              ))}
            </p>
          ))}
        </div>

        <section style={card} aria-label="Chapter comment">
          <h2 style={h2}>A note on the whole chapter</h2>
          <TagPick value={note?.tag} disabled={readOnly} onChange={(tag) => dispatch({ type: "chapterNote", path: chapter.path, body: note?.body ?? "", ...(tag === undefined ? {} : { tag }) })} />
          <textarea
            style={area}
            rows={3}
            disabled={readOnly}
            value={note?.body ?? ""}
            placeholder="Anything about the chapter as a whole"
            onChange={(e) => dispatch({ type: "chapterNote", path: chapter.path, body: e.target.value, ...(note?.tag === undefined ? {} : { tag: note.tag }) })}
          />
        </section>
      </main>

      <aside style={side}>
        <h2 style={h2}>Your marks in this chapter</h2>
        {chapterMarks.filter((m) => m.mark.kind !== "chapter").length === 0 && <p style={hint}>Select some text to comment on it or suggest a change. You can also type straight into the text.</p>}
        {chapterMarks.map(({ index, mark }) =>
          mark.kind === "chapter" ? null : (
            <div key={index} style={card}>
              <div style={markHead}>
                <strong>{mark.kind === "comment" ? "Comment" : "Suggestion"}</strong>
                {!readOnly && (
                  <button type="button" style={link} onClick={() => dispatch({ type: "remove", index })}>
                    Remove
                  </button>
                )}
              </div>
              <div style={quote}>{excerpt(selectedText(chapter.paragraphs, mark.selection)) || "(at a point in the text)"}</div>
              <TagPick value={mark.tag} disabled={readOnly} onChange={(tag) => dispatch({ type: "update", index, patch: { tag: tag ?? null } })} />
              <textarea
                style={area}
                rows={mark.kind === "comment" ? 2 : 3}
                disabled={readOnly}
                value={mark.kind === "comment" ? mark.body : mark.replacement}
                placeholder={mark.kind === "comment" ? "Your comment" : "What it should say instead (empty removes the text)"}
                onChange={(e) => dispatch({ type: "update", index, patch: mark.kind === "comment" ? { body: e.target.value } : { replacement: e.target.value } })}
              />
            </div>
          ),
        )}

        <section style={card} aria-label="Submit">
          <h2 style={h2}>Your summary</h2>
          <textarea
            style={area}
            rows={4}
            disabled={readOnly}
            value={draft.summary}
            placeholder="A few words for the author about the round"
            onChange={(e) => dispatch({ type: "summary", summary: e.target.value })}
          />
          {sent !== undefined ? (
            <p style={sentBox}>
              Sent to {data.round.sender || "the author"}. This round is finished; nothing more to do here.
            </p>
          ) : (
            <>
              <button type="button" style={submitButton} disabled={busy || !canSubmit(draft)} onClick={() => void submit()}>
                {busy ? "Sending…" : "Submit"}
              </button>
              <div style={hint}>
                {describeDraft(draft)} · {saved ? "saved" : "saving…"}
              </div>
            </>
          )}
          {notice !== "" && (
            <p role="alert" style={alert}>
              {notice}
            </p>
          )}
        </section>
      </aside>

      {pending !== undefined && !readOnly && (
        <Popover
          key={`${pending.selection.start.paragraph}:${pending.selection.start.offset}-${pending.selection.end.paragraph}:${pending.selection.end.offset}`}
          pending={pending}
          onCancel={() => setPending(undefined)}
          onAdd={(mark) => {
            if (mark.kind === "suggestion" && collidingSuggestion(draft, chapter.path, mark.selection) !== undefined) {
              setNotice("That text already has a suggestion. Remove or change it in the list first.");
              return;
            }
            dispatch({ type: "add", mark });
            window.getSelection()?.removeAllRanges();
            setPending(undefined);
          }}
          path={chapter.path}
        />
      )}
    </div>
  );
}

function TagPick(props: { value: Tag | undefined; disabled: boolean; onChange: (tag: Tag | undefined) => void }): ReactNode {
  return (
    <div style={tags} role="group" aria-label="Tag">
      {TAGS.map((t) => (
        <button
          key={t}
          type="button"
          disabled={props.disabled}
          aria-pressed={props.value === t}
          style={props.value === t ? { ...tagButton, ...(t === "fix" ? fixOn : keepOn) } : tagButton}
          onClick={() => props.onChange(props.value === t ? undefined : t)}
        >
          {t === "fix" ? "Fix" : "Keep"}
        </button>
      ))}
    </div>
  );
}

function Popover(props: {
  pending: Pending;
  path: string;
  onAdd: (mark: import("./reader-protocol").ReaderMark) => void;
  onCancel: () => void;
}): ReactNode {
  const { pending, path } = props;
  const [mode, setMode] = useState<"comment" | "suggest">("comment");
  const [text, setText] = useState("");
  const [tag, setTag] = useState<Tag | undefined>();
  const [replacement, setReplacement] = useState(pending.quote);
  return (
    <div style={{ ...popover, left: pending.x, top: pending.y }} role="dialog" aria-label="Mark this text" onMouseUp={(e) => e.stopPropagation()}>
      <div style={tags}>
        <button type="button" style={mode === "comment" ? { ...tagButton, ...fixOn } : tagButton} onClick={() => setMode("comment")}>
          Comment
        </button>
        <button type="button" style={mode === "suggest" ? { ...tagButton, ...fixOn } : tagButton} onClick={() => setMode("suggest")}>
          Suggest
        </button>
      </div>
      <div style={quote}>{excerpt(pending.quote, 120)}</div>
      {mode === "comment" ? (
        <>
          <TagPick value={tag} disabled={false} onChange={setTag} />
          <textarea style={area} rows={3} autoFocus placeholder="Your comment" value={text} onChange={(e) => setText(e.target.value)} />
          <div style={tags}>
            <button
              type="button"
              style={submitButton}
              disabled={text.trim() === ""}
              onClick={() => props.onAdd({ kind: "comment", path, selection: pending.selection, ...(tag === undefined ? {} : { tag }), body: text })}
            >
              Add comment
            </button>
            <button type="button" style={link} onClick={props.onCancel}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <textarea style={area} rows={3} autoFocus placeholder="What it should say instead (empty removes the text)" value={replacement} onChange={(e) => setReplacement(e.target.value)} />
          <div style={tags}>
            <button
              type="button"
              style={submitButton}
              disabled={replacement === pending.quote}
              onClick={() => props.onAdd({ kind: "suggestion", path, selection: pending.selection, replacement })}
            >
              Add suggestion
            </button>
            <button type="button" style={link} onClick={props.onCancel}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// --- styles ---------------------------------------------------------------------------------------------
// Tracked changes and comment markers are drawn by CSS only (::before / ::after), so the paragraph's text
// stays exactly the text pablo sent and a selection measures against it.

const css = `
  body { margin: 0; background: #f4f1ea; color: #1f1d1a; }
  .seg.cm { background: #fdf0b8; }
  .seg.cm.fix { background: #fbd9c4; }
  .seg.cm.keep { background: #d6ecd0; }
  .seg[data-n]:not([data-n=""])::before { content: attr(data-n); font: 600 0.65em system-ui, sans-serif; background: #6b5d3a; color: #fff; border-radius: 0.6em; padding: 0 0.4em; margin-right: 0.25em; vertical-align: super; }
  .seg.strike { text-decoration: line-through; text-decoration-color: #b3261e; color: #7a4a46; }
  .seg.ghost::after { content: attr(data-ins); text-decoration: none; color: #1b6b34; background: #dff3e4; margin-left: 0.3em; padding: 0 0.2em; border-radius: 3px; }
  p[contenteditable]:focus { outline: 1px dashed #b9ad8e; outline-offset: 4px; }
`;
const shell: CSSProperties = { display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) 22rem", gap: "1.5rem", padding: "1.5rem", minHeight: "100vh", boxSizing: "border-box", font: "16px system-ui, sans-serif" };
const nav: CSSProperties = { display: "flex", flexDirection: "column", gap: "0.25rem", width: "13rem", position: "sticky", top: "1.5rem", alignSelf: "start" };
const roundTitle: CSSProperties = { fontWeight: 600, marginBottom: "0.5rem" };
const navItem: CSSProperties = { display: "flex", justifyContent: "space-between", textAlign: "left", padding: "0.5rem 0.75rem", border: "1px solid transparent", background: "transparent", borderRadius: 6, cursor: "pointer", font: "inherit" };
const navActive: CSSProperties = { background: "#fff", borderColor: "#d8d1bf" };
const count: CSSProperties = { color: "#6b5d3a", fontSize: "0.85em" };
const page: CSSProperties = { background: "#fff", padding: "3rem 4rem", borderRadius: 4, boxShadow: "0 1px 4px rgba(0,0,0,.12)", maxWidth: "46rem", width: "100%", boxSizing: "border-box", justifySelf: "center" };
const title: CSSProperties = { font: "600 1.6rem Georgia, serif", margin: "0 0 2rem" };
const prose: CSSProperties = { font: "1.15rem/1.75 Georgia, 'Iowan Old Style', serif" };
const heading: CSSProperties = { fontWeight: 700 };
const side: CSSProperties = { display: "flex", flexDirection: "column", gap: "0.75rem", alignSelf: "start", position: "sticky", top: "1.5rem", maxHeight: "calc(100vh - 3rem)", overflowY: "auto" };
const card: CSSProperties = { background: "#fff", border: "1px solid #d8d1bf", borderRadius: 6, padding: "0.75rem", marginTop: "1.5rem" };
const h2: CSSProperties = { font: "600 0.95rem system-ui, sans-serif", margin: "0 0 0.5rem" };
const area: CSSProperties = { width: "100%", boxSizing: "border-box", font: "inherit", padding: "0.5rem", border: "1px solid #c9c1ac", borderRadius: 4, resize: "vertical" };
const hint: CSSProperties = { color: "#6f6a5e", fontSize: "0.85rem" };
const markHead: CSSProperties = { display: "flex", justifyContent: "space-between" };
const quote: CSSProperties = { color: "#6f6a5e", fontStyle: "italic", fontSize: "0.9rem", margin: "0.25rem 0 0.5rem" };
const tags: CSSProperties = { display: "flex", gap: "0.4rem", margin: "0.4rem 0", alignItems: "center" };
const tagButton: CSSProperties = { padding: "0.2rem 0.7rem", border: "1px solid #c9c1ac", background: "#faf8f2", borderRadius: 999, cursor: "pointer", font: "inherit", fontSize: "0.85rem" };
const fixOn: CSSProperties = { background: "#fbd9c4", borderColor: "#d98a5b" };
const keepOn: CSSProperties = { background: "#d6ecd0", borderColor: "#6fae61" };
const link: CSSProperties = { background: "none", border: "none", color: "#6b5d3a", textDecoration: "underline", cursor: "pointer", font: "inherit", fontSize: "0.85rem" };
const submitButton: CSSProperties = { padding: "0.5rem 1.25rem", border: "none", borderRadius: 6, background: "#2f5d3a", color: "#fff", font: "inherit", cursor: "pointer" };
const alert: CSSProperties = { color: "#8a1c14", background: "#fde8e6", padding: "0.5rem", borderRadius: 4, fontSize: "0.9rem" };
const sentBox: CSSProperties = { background: "#e3f2e6", padding: "0.6rem", borderRadius: 4 };
const popover: CSSProperties = { position: "fixed", width: "20rem", zIndex: 10, background: "#fff", border: "1px solid #b9ad8e", borderRadius: 8, boxShadow: "0 6px 24px rgba(0,0,0,.2)", padding: "0.75rem" };
