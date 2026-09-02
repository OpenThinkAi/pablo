/**
 * The file on disk, and the watch that keeps the view honest about it.
 *
 * pablo is a view over the writing vault, never a second store: the file is the
 * truth, the view is a projection of it, and an `$EDITOR` write is as valid a
 * source of change as anything pablo does itself (AC4). Nothing in this module
 * writes.
 *
 * The watch is on the **directory**, not the file, because that is the only way
 * to survive an atomic write: `vim`, `helix`, and anything using
 * write-to-temp-then-rename replace the inode, and a watch bound to the old one
 * goes deaf after the first save.
 */

import { readFileSync, watch } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parse, type Document, type MarkupDocument } from "@openthink/pablo-core";

export interface Manuscript {
  readonly doc: Document;
  readonly model: MarkupDocument;
}

/** Read and parse the file. Offsets in the result index this exact text. */
export function loadManuscript(path: string): Manuscript {
  const full = resolve(path);
  const text = readFileSync(full, "utf8");
  return { doc: { path: full, text }, model: parse(text) };
}

export interface WatchOptions {
  /**
   * How long to wait for writes to settle. An editor save is several syscalls
   * and a rename; re-reading after each one shows the author a half-written
   * file.
   */
  readonly debounceMs?: number;
  readonly onError?: (error: unknown) => void;
  /**
   * The text the caller already has. A re-read that matches it is a no-op, so
   * the touch that pablo's own watch sees after an unrelated write in the same
   * directory never costs a re-render.
   */
  readonly initialText?: string;
}

/**
 * Call `onChange` with a fresh parse whenever the file changes on disk.
 * Returns the stop function; the caller owns it and must call it.
 */
export function watchManuscript(
  path: string,
  onChange: (manuscript: Manuscript) => void,
  options: WatchOptions = {},
): () => void {
  const full = resolve(path);
  const name = basename(full);
  const debounceMs = options.debounceMs ?? 25;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: string | null = options.initialText ?? null;
  let stopped = false;

  const reread = (retry: boolean): void => {
    if (stopped) return;
    let manuscript: Manuscript;
    try {
      manuscript = loadManuscript(full);
    } catch (error) {
      // A rename-based save leaves the path missing for a moment; one more
      // debounce is enough to catch it, and only then is it a real error.
      if (retry) {
        schedule(false);
        return;
      }
      options.onError?.(error);
      return;
    }
    if (manuscript.doc.text === last) return;
    last = manuscript.doc.text;
    onChange(manuscript);
  };

  function schedule(retry: boolean): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      reread(retry);
    }, debounceMs);
    timer.unref?.();
  }

  const watcher = watch(dirname(full), (_event, filename) => {
    if (filename !== null && basename(filename.toString()) !== name) return;
    schedule(true);
  });
  watcher.on("error", (error) => options.onError?.(error));
  watcher.unref?.();

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    watcher.close();
  };
}
