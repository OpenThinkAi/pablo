import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ClipboardEvent as ReactClipboardEvent,
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
} from "react";
import type { ViewProps } from "@openthink/ui-leaf/view";
import {
  applyCandidate,
  countWords,
  groupHitsByParagraph,
  joinParagraphs,
  nextSavedText,
  selectionToBodyOffsets,
  splitParagraphs,
} from "./editor-logic";

/**
 * The paper-sheet editor (AGT-1270), replacing the AGT-1258 read-only stub.
 * Per `~/saltline-digital-vault/projects/ai-terminal/review-tray.md`, "The
 * editor": one white sheet, serif, generous margins, edit in place, a
 * `Revise…` control raised by a selection, `Approve`/`Reject`/`Save` at the
 * foot. The view never touches files or the model — every mutation it calls
 * (`save`, `revise`, `approve`, `reject`) is answered by the host
 * (`edit-host.ts`); this file only displays and asks. The host also answers
 * a `refresh` mutation (re-reads the file), but no AC asks for a UI control
 * to trigger it, so none is wired here — `edit-mount.test.ts` still exercises
 * it directly over `/mutate`.
 *
 * **contentEditable, not a textarea** (AC2's either/or): paragraphs are
 * rendered as separate blocks in natural document flow so the `check` hits
 * can sit "in the margin beside the paragraph they fall in" using the
 * paragraph's own bounding box, with no line-wrap measurement hack a single
 * scrolling textarea would need. The trade-off, taken on purpose: a
 * paragraph is edited as one block with no hard line breaks inside it —
 * Enter and paste are intercepted to insert a plain `\n`/plain text into the
 * block's one text node (never a browser-inserted `<br>` or a block split),
 * which is what keeps the Selection Range math in `handleSelectionChange`
 * below exactly equal to `el.textContent`/`el.innerText` at every offset —
 * the thing `selectionToBodyOffsets` needs to be correct.
 */

interface EditorHit {
  readonly path: string;
  readonly line: number;
  readonly rule: string;
  readonly excerpt: string;
  readonly detail?: string;
}

interface EditorPiece {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly words: number;
  readonly at: string;
}

interface EditorData {
  readonly piece?: EditorPiece;
  readonly path: string;
  readonly title: string;
  readonly text: string;
  readonly check: readonly EditorHit[];
  readonly words: number;
}

interface SaveResult {
  readonly ok: true;
  readonly unchanged?: true;
  // The host's real SaveResult also carries `words`, but the view computes
  // the live word count from the DOM itself (`countWords(body)`) and never
  // reads the host's copy — omitted here rather than declared and unused.
  readonly check: readonly EditorHit[];
  readonly git: { ok: boolean; detail?: string };
}

interface ReviseResult {
  readonly candidate: string;
  readonly receipt: unknown;
}

type DecisionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly detail: string };

interface SelectionState {
  // The paragraph blocks the selection starts/ends in — equal for a
  // selection that never leaves one paragraph, different for one that spans
  // more than one. Controls anchor on `endParagraphIndex` (see the render
  // loop below), since that's the block the selection's caret naturally
  // rests in.
  readonly startParagraphIndex: number;
  readonly endParagraphIndex: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface CandidateState {
  readonly startParagraphIndex: number;
  readonly endParagraphIndex: number;
  readonly start: number;
  readonly end: number;
  readonly original: string;
  readonly text: string;
}

type SaveStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "saved"; readonly detail?: string }
  | { readonly kind: "error"; readonly message: string };

type DecisionStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "done"; readonly label: "approved" | "rejected" }
  | { readonly kind: "error"; readonly message: string };

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Inline styles don't reach `:disabled` — this dims a button explicitly so "disabled" is visible, not just inert. */
function withDisabledLook(base: CSSProperties, isDisabled: boolean): CSSProperties {
  return isDisabled ? { ...base, opacity: 0.45, cursor: "not-allowed" } : base;
}

// ---------------------------------------------------------------------------
// DOM-facing helpers. These touch Range/Selection/Node and so stay here
// rather than in editor-logic.ts, which is pure precisely so it can be
// unit-tested without a DOM.
// ---------------------------------------------------------------------------

/** The character offset of `(node, nodeOffset)` within `root`'s own text — root and node are assumed to contain plain text only (see the note above about Enter/paste). */
function textOffsetWithin(root: Node, node: Node, nodeOffset: number): number {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, nodeOffset);
  return range.toString().length;
}

/** Walks up from `node` to the nearest element carrying `data-paragraph-index`, or `undefined` outside the sheet. */
function closestParagraphEl(node: Node | null): HTMLElement | undefined {
  let el: Node | null = node;
  while (el !== null) {
    if (el instanceof HTMLElement && el.dataset["paragraphIndex"] !== undefined) return el;
    el = el.parentNode;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// One paragraph, as an uncontrolled contentEditable block.
//
// The DOM is the source of truth for the paragraph's live text between
// resets: `initialText` is only ever written into the element once (the
// effect below depends on it, and its identity only changes when the parent
// resets — mount, `refresh`, a `Take`), never on every keystroke. Every
// keystroke instead flows out through `onChange`, read by the parent for
// word count / dirty-flag / revise offsets, and never written back into the
// DOM — which is what keeps the caret from jumping mid-word.
// ---------------------------------------------------------------------------

interface ParagraphBlockProps {
  readonly index: number;
  readonly initialText: string;
  readonly onChange: (index: number, text: string) => void;
}

function ParagraphBlock({ index, initialText, onChange }: ParagraphBlockProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (ref.current !== null) ref.current.textContent = initialText;
    // Deliberately only re-runs when `initialText`'s identity changes (a
    // reset), never on the live text the same paragraph is edited into.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialText]);

  function handleInput() {
    if (ref.current !== null) onChange(index, ref.current.textContent ?? "");
  }

  // `execCommand("insertText", ...)` is deprecated by spec, but is kept
  // deliberately: it inserts through the browser's own edit pipeline, so the
  // native undo stack (cmd/ctrl-Z) keeps working. Swapping this for a manual
  // `textContent`/Range splice would insert the text fine but silently break
  // undo — do not "modernize" this without checking that first.
  function handleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      document.execCommand("insertText", false, "\n");
    }
  }

  function handlePaste(e: ReactClipboardEvent<HTMLDivElement>) {
    e.preventDefault();
    document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
  }

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      data-paragraph-index={index}
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      style={paragraphStyle}
    />
  );
}

// ---------------------------------------------------------------------------
// The sheet.
// ---------------------------------------------------------------------------

export default function Editor({ data, mutate }: ViewProps<EditorData>) {
  const piece = data.piece;
  const title = data.title;
  const [check, setCheck] = useState<readonly EditorHit[]>(data.check);
  const [savedText, setSavedText] = useState(data.text);

  const [paragraphs, setParagraphs] = useState<string[]>(() => splitParagraphs(data.text));
  const [loadedParagraphs, setLoadedParagraphs] = useState<string[]>(paragraphs);
  const [revision, setRevision] = useState(0);

  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [reviseOpen, setReviseOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [revising, setRevising] = useState(false);
  const [candidate, setCandidate] = useState<CandidateState | null>(null);
  const [reviseError, setReviseError] = useState<string | null>(null);

  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const [decisionStatus, setDecisionStatus] = useState<DecisionStatus>({ kind: "idle" });

  const body = useMemo(() => joinParagraphs(paragraphs), [paragraphs]);
  const wordCount = useMemo(() => countWords(body), [body]);
  const dirty = body !== savedText;
  const hitsByParagraph = useMemo(() => groupHitsByParagraph(paragraphs, check), [paragraphs, check]);

  // -------------------------------------------------------------------------
  // Selection tracking. A document-level listener (rather than each
  // paragraph's own onSelect) is what reliably catches a selection collapsing
  // to nothing, or the caret moving outside the sheet entirely.
  // -------------------------------------------------------------------------
  useEffect(() => {
    function handleSelectionChange() {
      // Frozen while the Revise… form or the candidate compare panel is
      // open: focusing the instruction field (or clicking Take/Drop) moves
      // the document's own Selection off the paragraph, and without this
      // guard that would clear `selection` out from under the open control
      // the instant the author tries to type into it.
      if (reviseOpen || candidate !== null) return;

      const sel = window.getSelection();
      if (sel === null || sel.rangeCount === 0 || sel.isCollapsed) {
        setSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const startEl = closestParagraphEl(range.startContainer);
      const endEl = closestParagraphEl(range.endContainer);
      // A selection that leaves the sheet entirely (either end lands outside
      // every paragraph block) is outside this view's supported range — the
      // control simply doesn't raise. A selection that spans more than one
      // paragraph block is supported: `selectionToBodyOffsets` resolves each
      // end independently by paragraph index, so `startEl` and `endEl` are
      // allowed to differ.
      if (startEl === undefined || endEl === undefined) {
        setSelection(null);
        return;
      }
      const startIndex = Number(startEl.dataset["paragraphIndex"]);
      const endIndex = Number(endEl.dataset["paragraphIndex"]);
      const a = textOffsetWithin(startEl, range.startContainer, range.startOffset);
      const b = textOffsetWithin(endEl, range.endContainer, range.endOffset);
      const offsets = selectionToBodyOffsets(paragraphs, startIndex, a, endIndex, b);
      if (offsets === undefined) {
        setSelection(null);
        return;
      }
      setSelection({
        startParagraphIndex: Math.min(startIndex, endIndex),
        endParagraphIndex: Math.max(startIndex, endIndex),
        start: offsets.start,
        end: offsets.end,
        // Sliced from the joined body, not DOM `textContent` — this is what
        // guarantees the selected text includes the `"\n\n"` separator(s)
        // between paragraphs for a selection that spans more than one.
        text: body.slice(offsets.start, offsets.end),
      });
    }

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
    // `body` is derived from `paragraphs` (see the `useMemo` above) and is
    // always current for the same render this effect closes over — listed
    // here anyway since the handler reads it directly.
  }, [paragraphs, body, reviseOpen, candidate]);

  function handleParagraphChange(index: number, text: string) {
    setParagraphs((prev) => {
      const next = prev.slice();
      next[index] = text;
      return next;
    });
    setSaveStatus({ kind: "idle" });
  }

  /**
   * Replaces the live body/paragraphs wholesale (a `Take`, an eventual
   * `refresh`) and remounts every paragraph block fresh (bumps `revision`).
   * Deliberately does NOT touch `savedText` — only a *successful* `save`
   * response is allowed to mark the view clean (`handleSave`'s own
   * `setSavedText`). `takeCandidate` resets to the post-candidate text and
   * then awaits `handleSave`; if that save fails, `dirty` must still read
   * true (against the old `savedText`) so `Save` stays enabled for a retry
   * instead of getting stuck disabled with unsaved text on screen.
   */
  function resetTo(text: string, nextCheck?: readonly EditorHit[]) {
    const next = splitParagraphs(text);
    setParagraphs(next);
    setLoadedParagraphs(next);
    setRevision((r) => r + 1);
    if (nextCheck !== undefined) setCheck(nextCheck);
    setSelection(null);
    setReviseOpen(false);
    setCandidate(null);
    setInstruction("");
  }

  // -------------------------------------------------------------------------
  // Save
  // -------------------------------------------------------------------------
  async function handleSave(textOverride?: string) {
    const text = textOverride ?? body;
    setSaving(true);
    setSaveStatus({ kind: "idle" });
    try {
      const result = await mutate<SaveResult>("save", { text });
      setSavedText((prev) => nextSavedText(prev, text, true));
      setCheck(result.check);
      if (result.unchanged === true) {
        setSaveStatus({ kind: "saved" });
      } else {
        setSaveStatus({ kind: "saved", detail: result.git.ok ? undefined : result.git.detail });
      }
    } catch (e) {
      // `nextSavedText(prev, text, false)` is a no-op (returns `prev`
      // unchanged) — spelled out anyway so every `savedText` write goes
      // through the same function and a failed save can never be mistaken
      // for a confirmed one. `dirty` stays true, so `Save` stays enabled.
      setSavedText((prev) => nextSavedText(prev, text, false));
      setSaveStatus({ kind: "error", message: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  }

  // -------------------------------------------------------------------------
  // Revise / Take / Drop
  // -------------------------------------------------------------------------
  function openRevise() {
    setReviseOpen(true);
    setReviseError(null);
    setInstruction("");
  }

  function closeRevise() {
    setReviseOpen(false);
    setInstruction("");
    setReviseError(null);
  }

  async function submitRevise() {
    if (selection === null) return;
    setRevising(true);
    setReviseError(null);
    try {
      const result = await mutate<ReviseResult>("revise", {
        start: selection.start,
        end: selection.end,
        instruction,
      });
      setCandidate({
        startParagraphIndex: selection.startParagraphIndex,
        endParagraphIndex: selection.endParagraphIndex,
        start: selection.start,
        end: selection.end,
        original: selection.text,
        text: result.candidate,
      });
      setReviseOpen(false);
    } catch (e) {
      setReviseError(errorMessage(e));
    } finally {
      setRevising(false);
    }
  }

  function dropCandidate() {
    setCandidate(null);
    setSelection(null);
  }

  async function takeCandidate() {
    if (candidate === null) return;
    const next = applyCandidate(body, candidate.start, candidate.end, candidate.text);
    resetTo(next);
    await handleSave(next);
  }

  // -------------------------------------------------------------------------
  // Approve / Reject
  // -------------------------------------------------------------------------
  async function handleApprove() {
    setDecisionStatus({ kind: "pending" });
    try {
      const result = await mutate<DecisionResult>("approve");
      if (result.ok) {
        setDecisionStatus({ kind: "done", label: "approved" });
        window.setTimeout(() => window.close(), 1000);
      } else {
        setDecisionStatus({ kind: "error", message: result.detail });
      }
    } catch (e) {
      setDecisionStatus({ kind: "error", message: errorMessage(e) });
    }
  }

  function openReject() {
    setRejecting(true);
    setRejectReason("");
  }

  function cancelReject() {
    setRejecting(false);
    setRejectReason("");
  }

  async function confirmReject() {
    setDecisionStatus({ kind: "pending" });
    try {
      const reason = rejectReason.trim() === "" ? undefined : rejectReason.trim();
      const result = await mutate<DecisionResult>("reject", { reason });
      if (result.ok) {
        setRejecting(false);
        setDecisionStatus({ kind: "done", label: "rejected" });
        window.setTimeout(() => window.close(), 1000);
      } else {
        setDecisionStatus({ kind: "error", message: result.detail });
      }
    } catch (e) {
      setDecisionStatus({ kind: "error", message: errorMessage(e) });
    }
  }

  const canApproveReject = piece !== undefined;
  const decisionDone = decisionStatus.kind === "done";

  return (
    <div style={groundStyle}>
      <div style={sheetStyle}>
        <header style={headStyle}>
          <div style={headTopRowStyle}>
            <h1 style={titleStyle}>{title}</h1>
            {dirty && !decisionDone && <span style={unsavedDotStyle}>● unsaved changes</span>}
          </div>
          <div style={metaRowStyle}>
            <span>{wordCount} words</span>
            {piece !== undefined && (
              <>
                <span style={metaSepStyle}>·</span>
                <span>{piece.kind}</span>
              </>
            )}
          </div>
        </header>

        <main>
          {paragraphs.map((_, i) => {
            const hits = hitsByParagraph.get(i) ?? [];
            return (
              <div key={`${revision}-${i}`} style={paragraphRowStyle}>
                <div style={paragraphLineStyle}>
                  <ParagraphBlock index={i} initialText={loadedParagraphs[i] ?? ""} onChange={handleParagraphChange} />
                  <div style={marginStyle}>
                    {/* index-as-key is fine here: `hits` is derived fresh from `check` + `paragraphs` each render, never reordered or spliced in place. */}
                    {hits.map((hit, hitIndex) => (
                      <span
                        key={hitIndex}
                        title={`${hit.rule}${hit.detail !== undefined ? `: ${hit.detail}` : ""} — "${hit.excerpt}"`}
                        style={hitMarkStyle}
                      >
                        ●
                      </span>
                    ))}
                  </div>
                </div>

                {selection !== null && selection.endParagraphIndex === i && !decisionDone && (
                  <div style={selectionBarStyle}>
                    {!reviseOpen && candidate === null && (
                      <button type="button" onClick={openRevise} style={reviseButtonStyle}>
                        Revise…
                      </button>
                    )}
                    {reviseOpen && (
                      <div style={reviseFormStyle}>
                        <input
                          type="text"
                          value={instruction}
                          onChange={(e) => setInstruction(e.target.value)}
                          placeholder="How should this passage change?"
                          style={instructionInputStyle}
                          autoFocus
                        />
                        <button
                          type="button"
                          onClick={submitRevise}
                          disabled={revising || instruction.trim() === ""}
                          style={withDisabledLook(primaryButtonStyle, revising || instruction.trim() === "")}
                        >
                          {revising ? "Revising…" : "Send"}
                        </button>
                        <button type="button" onClick={closeRevise} disabled={revising} style={linkButtonStyle}>
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {reviseError !== null && selection !== null && selection.endParagraphIndex === i && (
                  <ErrorBanner message={reviseError} onDismiss={() => setReviseError(null)} />
                )}

                {candidate !== null && candidate.endParagraphIndex === i && (
                  <div style={compareWrapStyle}>
                    <div style={compareGridStyle}>
                      <div style={compareBoxStyle}>
                        <div style={compareLabelStyle}>Original</div>
                        <p style={compareTextStyle}>{candidate.original}</p>
                      </div>
                      <div style={compareBoxStyle}>
                        <div style={compareLabelStyle}>Candidate</div>
                        <p style={compareTextStyle}>{candidate.text}</p>
                      </div>
                    </div>
                    <div style={compareActionsStyle}>
                      <button type="button" onClick={takeCandidate} style={primaryButtonStyle}>
                        Take
                      </button>
                      <button type="button" onClick={dropCandidate} style={linkButtonStyle}>
                        Drop
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </main>

        <footer style={footStyle}>
          {decisionStatus.kind === "done" ? (
            <p style={decisionDoneStyle}>{decisionStatus.label} — closing…</p>
          ) : (
            <>
              {decisionStatus.kind === "error" && (
                <ErrorBanner message={decisionStatus.message} onDismiss={() => setDecisionStatus({ kind: "idle" })} />
              )}
              {saveStatus.kind === "error" && (
                <ErrorBanner message={saveStatus.message} onDismiss={() => setSaveStatus({ kind: "idle" })} />
              )}

              {rejecting && (
                <div style={rejectFormStyle}>
                  <input
                    type="text"
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="Reason (optional)"
                    style={instructionInputStyle}
                    autoFocus
                  />
                  <button type="button" onClick={confirmReject} style={dangerButtonStyle}>
                    Confirm reject
                  </button>
                  <button type="button" onClick={cancelReject} style={linkButtonStyle}>
                    Cancel
                  </button>
                </div>
              )}

              <div style={footRowStyle}>
                <div style={footStatusStyle}>
                  {saveStatus.kind === "saved" &&
                    (saveStatus.detail !== undefined ? saveStatus.detail : "saved")}
                </div>
                <div style={footButtonsStyle}>
                  <button
                    type="button"
                    onClick={() => handleSave()}
                    disabled={!dirty || saving}
                    style={withDisabledLook(saveButtonStyle, !dirty || saving)}
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                  {canApproveReject && (
                    <>
                      <button
                        type="button"
                        onClick={openReject}
                        disabled={decisionStatus.kind === "pending" || rejecting}
                        style={withDisabledLook(dangerButtonStyle, decisionStatus.kind === "pending" || rejecting)}
                      >
                        Reject
                      </button>
                      <button
                        type="button"
                        onClick={handleApprove}
                        disabled={decisionStatus.kind === "pending" || rejecting}
                        style={withDisabledLook(approveButtonStyle, decisionStatus.kind === "pending" || rejecting)}
                      >
                        {decisionStatus.kind === "pending" ? "Approving…" : "Approve"}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }): ReactNode {
  return (
    <div role="alert" style={errorBannerStyle}>
      <span>{message}</span>
      <button type="button" onClick={onDismiss} style={dismissButtonStyle} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styling — the look from review-tray.md's "The editor": one white sheet on
// a neutral ground, serif body, generous margins. System font stacks only
// (no web-font fetch) so the sheet renders identically offline and never
// flashes unstyled text.
// ---------------------------------------------------------------------------

const SERIF = "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', serif";
const UI_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const INK = "#2b2722";
const INK_SOFT = "#7b7367";
const HAIR = "#e3ddcd";
const PAPER = "#fffdf7";
const GROUND = "#e9e5da";
const ACCENT = "#8a4650";
const OK = "#4f6b4a";

const groundStyle: CSSProperties = {
  minHeight: "100vh",
  background: GROUND,
  padding: "2.5rem 1rem 4rem",
  fontFamily: SERIF,
  color: INK,
};

const sheetStyle: CSSProperties = {
  maxWidth: "42rem",
  margin: "0 auto",
  background: PAPER,
  border: `1px solid ${HAIR}`,
  boxShadow: "0 1px 2px rgba(60, 50, 30, 0.06), 0 12px 30px rgba(60, 50, 30, 0.08)",
  padding: "3rem 3rem 2.5rem",
};

const headStyle: CSSProperties = {
  borderBottom: `2px solid ${INK}`,
  paddingBottom: "0.9rem",
  marginBottom: "2rem",
};

const headTopRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: "1rem",
  flexWrap: "wrap",
};

const titleStyle: CSSProperties = {
  fontSize: "1.6rem",
  fontWeight: 600,
  letterSpacing: "-0.01em",
  margin: 0,
};

const unsavedDotStyle: CSSProperties = {
  fontFamily: UI_FONT,
  fontSize: "0.72rem",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: ACCENT,
  whiteSpace: "nowrap",
};

const metaRowStyle: CSSProperties = {
  fontFamily: UI_FONT,
  fontSize: "0.78rem",
  letterSpacing: "0.04em",
  color: INK_SOFT,
  marginTop: "0.4rem",
};

const metaSepStyle: CSSProperties = { margin: "0 0.4rem" };

const paragraphRowStyle: CSSProperties = {
  marginBottom: "1.35rem",
  position: "relative",
};

const paragraphLineStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.6rem",
};

const paragraphStyle: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  // `normal`, not `pre-wrap`: a source paragraph is often hard-wrapped at a
  // column width from a plain-text editor (see the fixture chapters). Those
  // are markdown SOFT wraps — a single "\n" inside a paragraph means a
  // space, not a forced line break; only a blank line (a paragraph boundary,
  // already a separate block here) is meaningful. `white-space: normal`
  // collapses that whitespace for DISPLAY only — it changes how the browser
  // lays the text out, not the text node's own content, so the exact "\n"
  // bytes are still there in `textContent`/`onChange` and still round-trip
  // through `splitParagraphs`/`joinParagraphs` and into `save` untouched;
  // this paragraph reflows to the sheet's own measure instead of the
  // source file's line breaks.
  whiteSpace: "normal",
  wordWrap: "break-word",
  fontSize: "1.05rem",
  lineHeight: 1.7,
  outline: "none",
  caretColor: INK,
};

const marginStyle: CSSProperties = {
  flex: "0 0 auto",
  width: "1.1rem",
  paddingTop: "0.3rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.2rem",
  alignItems: "center",
};

const hitMarkStyle: CSSProperties = {
  fontSize: "0.5rem",
  color: "#b08a4a",
  cursor: "default",
};

const selectionBarStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  marginTop: "0.5rem",
};

const reviseButtonStyle: CSSProperties = {
  fontFamily: UI_FONT,
  fontSize: "0.72rem",
  letterSpacing: "0.04em",
  color: PAPER,
  background: INK,
  border: 0,
  borderRadius: "999px",
  padding: "0.3rem 0.8rem",
  cursor: "pointer",
};

const reviseFormStyle: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  alignItems: "center",
  background: PAPER,
  border: `1px solid ${HAIR}`,
  borderRadius: "8px",
  padding: "0.4rem",
  boxShadow: "0 4px 14px rgba(60, 50, 30, 0.12)",
  width: "100%",
};

const instructionInputStyle: CSSProperties = {
  flex: "1 1 auto",
  fontFamily: UI_FONT,
  fontSize: "0.85rem",
  padding: "0.35rem 0.5rem",
  border: `1px solid ${HAIR}`,
  borderRadius: "5px",
  minWidth: 0,
};

const compareWrapStyle: CSSProperties = {
  width: "100%",
  marginTop: "0.75rem",
  background: "#f6f2e6",
  border: `1px solid ${HAIR}`,
  borderRadius: "8px",
  padding: "0.9rem",
};

const compareGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
  gap: "0.9rem",
};

const compareBoxStyle: CSSProperties = {
  background: PAPER,
  border: `1px solid ${HAIR}`,
  borderRadius: "6px",
  padding: "0.6rem 0.75rem",
};

const compareLabelStyle: CSSProperties = {
  fontFamily: UI_FONT,
  fontSize: "0.65rem",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: INK_SOFT,
  marginBottom: "0.35rem",
};

const compareTextStyle: CSSProperties = {
  fontSize: "0.95rem",
  lineHeight: 1.55,
  margin: 0,
  // Same reasoning as `paragraphStyle`: `original`/`candidate` text can carry
  // the source's own soft-wrap newlines (a selection made inside a
  // hard-wrapped paragraph) — collapse them for display, same as the sheet.
  whiteSpace: "normal",
};

const compareActionsStyle: CSSProperties = {
  display: "flex",
  gap: "0.75rem",
  marginTop: "0.75rem",
};

const footStyle: CSSProperties = {
  borderTop: `1px solid ${HAIR}`,
  paddingTop: "1.25rem",
  marginTop: "1.5rem",
};

const footRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  flexWrap: "wrap",
};

const footStatusStyle: CSSProperties = {
  fontFamily: UI_FONT,
  fontSize: "0.78rem",
  color: INK_SOFT,
};

const footButtonsStyle: CSSProperties = {
  display: "flex",
  gap: "0.6rem",
  marginLeft: "auto",
};

const buttonBase: CSSProperties = {
  fontFamily: UI_FONT,
  fontSize: "0.82rem",
  letterSpacing: "0.02em",
  padding: "0.5rem 1rem",
  borderRadius: "6px",
  border: "1px solid transparent",
  cursor: "pointer",
};

const saveButtonStyle: CSSProperties = {
  ...buttonBase,
  background: PAPER,
  border: `1px solid ${INK}`,
  color: INK,
};

const approveButtonStyle: CSSProperties = {
  ...buttonBase,
  background: OK,
  color: PAPER,
};

const dangerButtonStyle: CSSProperties = {
  ...buttonBase,
  background: PAPER,
  border: `1px solid ${ACCENT}`,
  color: ACCENT,
};

const primaryButtonStyle: CSSProperties = {
  ...buttonBase,
  background: INK,
  color: PAPER,
};

const linkButtonStyle: CSSProperties = {
  fontFamily: UI_FONT,
  fontSize: "0.78rem",
  color: INK_SOFT,
  background: "none",
  border: 0,
  textDecoration: "underline",
  textUnderlineOffset: "2px",
  cursor: "pointer",
  padding: 0,
};

const dismissButtonStyle: CSSProperties = {
  background: "none",
  border: 0,
  color: "inherit",
  fontSize: "1rem",
  lineHeight: 1,
  cursor: "pointer",
  padding: "0 0.25rem",
};

const errorBannerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  fontFamily: UI_FONT,
  fontSize: "0.8rem",
  color: "#8f4f3f",
  background: "#f7e7e2",
  border: "1px solid #e3c7bf",
  borderRadius: "6px",
  padding: "0.5rem 0.75rem",
  marginBottom: "0.75rem",
  width: "100%",
};

const rejectFormStyle: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  alignItems: "center",
  marginBottom: "0.9rem",
};

const decisionDoneStyle: CSSProperties = {
  fontFamily: UI_FONT,
  fontSize: "0.9rem",
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: INK_SOFT,
  textAlign: "center",
  margin: 0,
};
