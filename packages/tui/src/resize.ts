// Terminal size as state. The app used to read stdout.columns at render, but nothing rendered on SIGWINCH, and
// Ink's incremental repaint never erases what a wider or taller frame left behind. So: listen for `resize`,
// wait a beat (a drag fires dozens), wipe the screen and scrollback of the stale frame, then set state so
// everything derived from the size is recomputed.

import { useEffect, useState } from "react";
import { useStdout } from "ink";

export type Size = { cols: number; rows: number };

/**
 * Below this the layout cannot hold the status area, a few lines of the main pane, the content area beside the key
 * panel and the footer; a one-line notice is shown instead.
 */
export const MIN_COLS = 60;
export const MIN_ROWS = 20;
export const tooSmall = (s: Size) => s.cols < MIN_COLS || s.rows < MIN_ROWS;

/** Clear screen, clear scrollback, cursor home. */
export const WIPE = "\x1b[2J\x1b[3J\x1b[H";
const DEBOUNCE_MS = 50;

/** `override` (tests) is returned as is; there is no terminal to measure. */
export function useTerminalSize(override?: Size): Size {
  const { stdout } = useStdout();
  const read = (): Size => override ?? { cols: stdout.columns || 100, rows: stdout.rows || 40 };
  const [size, setSize] = useState<Size>(read);
  useEffect(() => {
    if (override) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        stdout.write(WIPE);
        // A fresh object every time: the wiped screen needs repainting even if the size ended up the same.
        setSize({ cols: stdout.columns || 100, rows: stdout.rows || 40 });
      }, DEBOUNCE_MS);
    };
    stdout.on("resize", onResize);
    return () => { clearTimeout(t); stdout.off("resize", onResize); };
  }, [stdout, !!override]);
  return override ?? size;
}
