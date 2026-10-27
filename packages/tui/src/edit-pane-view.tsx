// `v e` in place (AGT-2167): the editing pane, drawn where the main pane is. It opens the unit on the work's `edit/`
// branch through the `PaneSession` the CLI passes in, reads keys while it is open (Ctrl+S commits, Esc closes, the rest
// edit), and draws edit-pane.ts's rows: the text with the cursor in inverse video and each check hit's box under its
// paragraph. What it knows lives in the model (`state.editPane`); this only runs the session and dispatches.

import { useEffect, useMemo, type Dispatch } from "react";
import { Box, Text, useInput } from "ink";
import { tokenOf } from "./chord";
import { openText, paneHits, paneKey, paneRows, saveText, savedEdit, type EditText, type PaneSession } from "./edit-pane";
import type { CheckHit } from "./hits";
import { clean } from "./sanitize";
import type { Action, EditPane } from "./state";

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
}

const fail = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function EditPaneView({ pane, session, checks, dispatch, width, height, inner, rows }: EditPaneViewProps) {
  const { file, storage, line, phase, branch, saveSeq } = pane;
  const text = pane.text as EditText | null;

  // Opening: the branch, its worktree and the file there. Once per pane (a new `v e` mounts a new one).
  useEffect(() => {
    if (phase !== "opening") return;
    session.open(file).then(
      (r) => dispatch(r.ok ? { type: "pane.opened", branch: r.branch, text: openText(r.text, storage, line) } : { type: "pane.failed", message: r.message }),
      (e: unknown) => dispatch({ type: "pane.failed", message: fail(e) }),
    );
  }, []);

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
      // The close that leaves: nothing unsaved, or Esc a second time. A branch the pane made and never committed goes.
      if (branch !== null && (!text?.dirty || pane.closing)) void session.close(branch).catch(() => undefined);
      return void dispatch({ type: "pane.close" });
    }
    const edit = paneKey(input, key, inner, rows);
    if (edit) dispatch({ type: "pane.edit", edit });
  }, { isActive: phase !== "opening" });

  const hits = useMemo(() => (text ? paneHits(text, file, checks) : new Map<number, CheckHit[]>()), [text, file, checks]);
  const shown = text ? paneRows(text, inner, rows, hits) : [];
  const title = ` ${clean(file)}${text?.dirty ? " [+]" : ""}${branch ? ` · ${clean(branch)}` : ""}${phase === "saving" ? " · saving…" : phase === "opening" ? " · opening…" : ""}`;
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
