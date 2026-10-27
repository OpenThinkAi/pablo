// The pane's autosave debounce (AGT-2173) on an injected clock: no real timers run.

import { expect, test } from "bun:test";
import { AUTOSAVE_MS, scheduleAutosave, type AutosaveClock } from "../src/autosave";

/** A clock whose timers fire only when the test says so. */
function fakeClock() {
  let next = 0;
  const timers = new Map<number, { fire: () => void; ms: number }>();
  const clock: AutosaveClock = {
    set: (fire, ms) => { const id = ++next; timers.set(id, { fire, ms }); return id; },
    clear: (handle) => { timers.delete(handle as number); },
  };
  /** Fires every timer set so far (the idle wait has passed). */
  const elapse = () => { const due = [...timers.values()]; timers.clear(); for (const t of due) t.fire(); };
  return { clock, elapse, get pending() { return [...timers.values()].map((t) => t.ms); } };
}

test("an open, dirty pane waits the idle time, then saves once", () => {
  const c = fakeClock();
  let fired = 0;
  const cancel = scheduleAutosave(true, true, () => fired++, { clock: c.clock });
  expect(cancel).toBeDefined();
  expect(c.pending).toEqual([AUTOSAVE_MS]);
  expect(fired).toBe(0);
  c.elapse();
  expect(fired).toBe(1);
  c.elapse();
  expect(fired).toBe(1);
});

test("a clean or still-opening pane waits for nothing", () => {
  const c = fakeClock();
  expect(scheduleAutosave(true, false, () => undefined, { clock: c.clock })).toBeUndefined();
  expect(scheduleAutosave(false, true, () => undefined, { clock: c.clock })).toBeUndefined();
  expect(c.pending).toEqual([]);
});

test("cancelling (the next keystroke's restart, or the pane closing) drops the wait", () => {
  const c = fakeClock();
  let fired = 0;
  const cancel = scheduleAutosave(true, true, () => fired++, { clock: c.clock, ms: 50 });
  expect(c.pending).toEqual([50]);
  cancel!();
  expect(c.pending).toEqual([]);
  c.elapse();
  expect(fired).toBe(0);
});
