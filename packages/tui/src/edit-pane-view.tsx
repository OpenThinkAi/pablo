// `v e` in place (AGT-2167): the editing pane, drawn where the main pane is. It opens the unit on the work's `edit/`
// branch through the `PaneSession` the CLI passes in, reads keys while it is open (Ctrl+S commits; the rest go through
// modal.ts's Helix-style modes, AGT-2169, where Esc in normal mode closes), and draws edit-pane.ts's rows: the text with
// the cursor in inverse video and each check hit's box under its paragraph. What it knows lives in the model
// (`state.editPane`); this only runs the session and dispatches. Edits also autosave to the branch after an idle pause
// (AGT-2173, autosave.ts); `v s` is still what merges them into main.

import { useEffect, useMemo, type Dispatch } from "react";
import { Box, Text, useInput } from "ink";
import { useAutosave, type AutosaveOptions } from "./autosave";
import { tokenOf } from "./chord";
import { modeOfKey, toggled, NO_MODES, type Modes } from "./edit-modes";
import { openText, paneHits, paneView, saveText, savedEdit, type EditText, type PaneSession } from "./edit-pane";
import { DEFAULT_KEYMAP, type Keymap } from "./keys";
import { modalKey, modeOf, MODE_TAG } from "./modal";
import { promptKey, promptLine, searchStatus } from "./search";
import type { CheckHit } from "./hits";
import { clean } from "./sanitize";
import { paneEsc, type Action, type EditPane, type Pending } from "./state";

export interface EditPaneViewProps {
  readonly pane: EditPane;
  readonly session: PaneSession;
  readonly checks?: (file: string, text: string) => readonly CheckHit[];
  readonly dispatch: Dispatch<Action>;
  /** The bindings in force (the modal keys are `editor.*` rows) and the model's pending prefix (`g` of `g g`). */
  readonly keymap?: Keymap;
  readonly pending?: Pending | null;
  /** The pane's box (the main pane's place) and the text's width and rows inside it. */
  readonly width: number;
  readonly height: number;
  readonly inner: number;
  readonly rows: number;
  /** The autosave's idle wait and clock (AGT-2173); tests pass a fake clock. */
  readonly autosave?: AutosaveOptions;
  /** Focus and typewriter (edit-modes.ts) and what the app does when one is toggled (writes the config). */
  readonly modes?: Modes;
  readonly onModes?: (modes: Modes) => void;
  /** Another layer holds the keys (the word-target prompt, AGT-2175): the pane reads none. */
  readonly held?: boolean;
}

const fail = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function EditPaneView({ pane, session, checks, dispatch, keymap = DEFAULT_KEYMAP, pending = null, width, height, inner, rows, autosave, modes = NO_MODES, onModes, held = false }: EditPaneViewProps) {
  const { file, storage, line, phase, branch, saveSeq, top } = pane;
  const text = pane.text as EditText | null;
  // Opening: the branch, its worktree and the file there. Once per pane (a new `v e` mounts a new one). `live` goes false
  // when the pane closes (unmounts): an open that lands after Esc lets its branch go again.
  useEffect(() => {
    let live = true;
    if (phase === "opening") {
      session.open(file).then(
        (r) => {
          if (!live) {
            if (r.ok) void session.close(r.branch).catch(() => undefined);
            return;
          }
          dispatch(r.ok ? { type: "pane.opened", branch: r.branch, text: openText(r.text, storage, line), ...(r.unmerged ? { unmerged: r.unmerged } : {}) } : { type: "pane.failed", message: r.message });
        },
        (e: unknown) => { if (live) dispatch({ type: "pane.failed", message: fail(e) }); },
      );
    }
    return () => { live = false; };
  }, []);

  useAutosave(text, text?.dirty === true, phase !== "opening", () => dispatch({ type: "pane.save", auto: true }), autosave);

  // One commit per Ctrl+S: `saveSeq` changes only then. Typing may go on while it runs; the save marks clean only
  // what it wrote.
  useEffect(() => {
    if (phase !== "saving" || text === null || branch === null) return;
    const edited = text.buffer.text();
    const raw = saveText(text.raw, edited, text.storage);
    session.save(file, branch, raw).then(
      (r) => dispatch(r.ok ? { type: "pane.saved", branch: r.branch, lines: r.lines, edit: savedEdit(edited, raw) } : { type: "pane.save_failed", message: r.message }),
      (e: unknown) => dispatch({ type: "pane.save_failed", message: fail(e) }),
    );
  }, [saveSeq]);

  useInput((input, key) => {
    if (held) return; // the word-target prompt has the keys (word-count.ts)
    const token = tokenOf(input, key);
    if (token === "ctrl-s") return void dispatch({ type: "pane.save" });
    if (token === "esc" && (phase === "opening" || text === null)) {
      // Esc while opening cancels: the open's branch is let go when it lands.
      return void dispatch({ type: "pane.close" });
    }
    if (phase === "opening") return;
    const typing = promptKey(text, input, key);
    if (typing) { for (const action of typing) dispatch(action); return; }
    // Focus and typewriter work in every mode (a ctrl key is never text).
    const toggle = modeOfKey(token, keymap);
    if (toggle) { const next = toggled(modes, toggle); dispatch({ type: "modes.set", modes: next }); return onModes?.(next); }
    const step = modalKey(modeOf(text), pending, input, key, keymap, { width: inner, height: rows });
    if (step === "close") {
      // Esc in normal mode (insert and select go back to normal first, AGT-2169): the model's one Esc rule
      // (`paneEsc`); when it leaves, a branch the pane made and never committed goes.
      if (branch !== null && paneEsc(pane) === "leaves") void session.close(branch).catch(() => undefined);
      return void dispatch({ type: "pane.close" });
    }
    for (const action of step) dispatch(action);
  });

  const hits = useMemo(() => (text ? paneHits(text, file, checks) : new Map<number, CheckHit[]>()), [text, file, checks]);
  // The scroll is the model's `pane.top`: drawing reads it, and the effect below records where the draw put it.
  const prompt = text?.prompt ?? null;
  const view = text ? paneView(text, inner, prompt ? Math.max(1, rows - 1) : rows, hits, { top, focus: modes.focus, typewriter: modes.typewriter }) : { rows: [], top };
  useEffect(() => { if (view.top !== top) dispatch({ type: "pane.scroll", top: view.top }); });
  const shown = view.rows;
  const status = text ? searchStatus(text) : "";
  const title = ` ${text ? `${MODE_TAG[modeOf(text)]} ` : ""}${clean(file)}${text?.dirty ? " [+]" : ""}${status ? ` · ${clean(status)}` : ""}${branch ? ` · ${clean(branch)}` : ""}${phase === "saving" ? (pane.auto ? " · autosaving…" : " · saving…") : phase === "opening" ? " · opening…" : ""}${modes.focus ? " · focus" : ""}${modes.typewriter ? " · typewriter" : ""}`;
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text wrap="truncate" bold={text?.dirty === true} dimColor={text?.dirty !== true}>{title}</Text>
      {shown.map((row, i) => {
        if (row.kind === "box") {
          return (
            <Text key={i} wrap="truncate" color={row.color} dimColor={row.dim === true}>
              {" "}{row.head !== undefined ? <>{row.head}{row.tag ? <Text dimColor>{row.tag}</Text> : null}{row.text.slice(row.head.length + (row.tag?.length ?? 0))}</> : row.text}
            </Text>
          );
        }
        if (row.parts) {
          return (
            <Text key={i} wrap="truncate" dimColor={row.dim === true}>
              {" "}{row.parts.map((p, j) => (p.cursor ? <Text key={j} inverse>{p.text}</Text> : p.match ? <Text key={j} color="yellow" underline backgroundColor={p.sel ? "gray" : undefined}>{p.text}</Text> : p.sel ? <Text key={j} backgroundColor="gray">{p.text}</Text> : p.text))}
            </Text>
          );
        }
        if (row.cursor) {
          return (
            <Text key={i} wrap="truncate" dimColor={row.dim === true}>
              {" "}{row.cursor.before}<Text inverse>{row.cursor.at}</Text>{row.cursor.after}
            </Text>
          );
        }
        return <Text key={i} wrap="truncate" dimColor={row.dim === true}>{` ${row.text}`}</Text>;
      })}
      {prompt ? <Text wrap="truncate">{" "}{clean(promptLine(prompt))}<Text inverse>{" "}</Text></Text> : null}
    </Box>
  );
}
