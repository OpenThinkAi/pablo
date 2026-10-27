// `v e` in place (AGT-2167): the editing pane, drawn where the main pane is. It opens the unit on the work's `edit/`
// branch through the `PaneSession` the CLI passes in, reads keys while it is open (Ctrl+S commits, Esc closes, the rest
// edit), and draws edit-pane.ts's rows: the text with the cursor in inverse video and each check hit's box under its
// paragraph. What it knows lives in the model (`state.editPane`); this only runs the session and dispatches. Edits also
// autosave to the branch after an idle pause (AGT-2173, autosave.ts); `v s` is still what merges them into main.

import { useEffect, useMemo, type Dispatch } from "react";
import { Box, Text, useInput } from "ink";
import { useAutosave, type AutosaveOptions } from "./autosave";
import { tokenOf } from "./chord";
import { openText, paneHits, paneKey, paneRows, saveText, savedEdit, type EditText, type PaneSession } from "./edit-pane";
import type { CheckHit } from "./hits";
import { clean } from "./sanitize";
import { paneEsc, type Action, type EditPane } from "./state";

export interface EditPaneViewProps {
  readonly pane: EditPane;
  readonly session: PaneSession;
  readonly checks?: (file: string, text: string) => readonly CheckHit[];
  readonly dispatch: Dispatch<Action>;
  /** The pane's box (the main pane's place) and the text's width and rows inside it. */
  readonly width: number;
  readonly height: number;
  readonly inner: number;
  readonly rows: number;
  /** The autosave's idle wait and clock (AGT-2173); tests pass a fake clock. */
  readonly autosave?: AutosaveOptions;
}

const fail = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function EditPaneView({ pane, session, checks, dispatch, width, height, inner, rows, autosave }: EditPaneViewProps) {
  const { file, storage, line, phase, branch, saveSeq } = pane;
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
    const token = tokenOf(input, key);
    if (token === "ctrl-s") return void dispatch({ type: "pane.save" });
    if (token === "esc") {
      // The model's one Esc rule (`paneEsc`); when it leaves, a branch the pane made and never committed goes. Esc while
      // opening cancels: the open's branch is let go when it lands.
      if (branch !== null && paneEsc(pane) === "leaves") void session.close(branch).catch(() => undefined);
      return void dispatch({ type: "pane.close" });
    }
    if (phase === "opening") return;
    const edit = paneKey(input, key, inner, rows);
    if (edit) dispatch({ type: "pane.edit", edit });
  });

  const hits = useMemo(() => (text ? paneHits(text, file, checks) : new Map<number, CheckHit[]>()), [text, file, checks]);
  const shown = text ? paneRows(text, inner, rows, hits) : [];
  const title = ` ${clean(file)}${text?.dirty ? " [+]" : ""}${branch ? ` · ${clean(branch)}` : ""}${phase === "saving" ? (pane.auto ? " · autosaving…" : " · saving…") : phase === "opening" ? " · opening…" : ""}`;
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text wrap="truncate" bold={text?.dirty === true} dimColor={text?.dirty !== true}>{title}</Text>
      {shown.map((row, i) => {
        if (row.kind === "box") {
          return (
            <Text key={i} wrap="truncate" color={row.color}>
              {" "}{row.head !== undefined ? <>{row.head}{row.tag ? <Text dimColor>{row.tag}</Text> : null}{row.text.slice(row.head.length + (row.tag?.length ?? 0))}</> : row.text}
            </Text>
          );
        }
        if (row.cursor) {
          return (
            <Text key={i} wrap="truncate">
              {" "}{row.cursor.before}<Text inverse>{row.cursor.at}</Text>{row.cursor.after}
            </Text>
          );
        }
        return <Text key={i} wrap="truncate">{` ${row.text}`}</Text>;
      })}
    </Box>
  );
}
