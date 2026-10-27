// The editing pane's autosave (AGT-2173, D-18): after an idle pause in typing, the pane saves to the work's `edit/` branch
// through the same path as Ctrl+S (`saveText` -> the session's `save`, a commit on the branch). `main` never moves here;
// only `v s` merges the branch into it. Kept apart from the pane's keys and drawing (edit-pane-view.tsx only calls the
// hook) so the debounce is tested with an injected clock and no Ink.

import { useEffect } from "react";

/** How long the text must sit unchanged before it autosaves. */
export const AUTOSAVE_MS = 2000;

/** The clock the debounce runs on: the real timers by default, a fake one in tests. */
export interface AutosaveClock {
  set(fire: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realClock: AutosaveClock = {
  set: (fire, ms) => setTimeout(fire, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface AutosaveOptions {
  readonly ms?: number;
  readonly clock?: AutosaveClock;
}

/**
 * One idle wait: when the pane is open and its text dirty, `save` runs after `ms` unless the returned cancel runs first.
 * Nothing to wait for (closed, or clean) returns no cancel. The hook below starts one per text and cancels the last, so
 * each change restarts the wait: a debounce with no state of its own.
 */
export function scheduleAutosave(open: boolean, dirty: boolean, save: () => void, { ms = AUTOSAVE_MS, clock = realClock }: AutosaveOptions = {}): (() => void) | undefined {
  if (!open || !dirty) return undefined;
  const handle = clock.set(save, ms);
  return () => clock.clear(handle);
}

/**
 * The pane's autosave: while the pane is open and its text is dirty, `save` runs once the text has been left alone for
 * `ms`. A text that changes (a key, or a save marking it clean) restarts or drops the wait; closing the pane drops it.
 * `save` is the pane's `pane.save` with `auto`, which the model skips when there is nothing to save or the body is blank.
 * The Ink layer keeps no state (test/boundary.test.ts): the pending wait lives only in the effect's cleanup.
 */
export function useAutosave(text: unknown, dirty: boolean, open: boolean, save: () => void, options: AutosaveOptions = {}): void {
  useEffect(() => scheduleAutosave(open, dirty, save, options), [text, dirty, open]);
}
