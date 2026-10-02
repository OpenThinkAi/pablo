// Mounts the app in the terminal's alternate screen and restores the terminal on the way out, however it ends.

import { render } from "ink";
import { App } from "./app";
import { bookRail, type BookStage } from "./book";
import { loadEditor, loadKeymap } from "./key-config";
import { KeysError } from "./keys";

const ENTER_ALT = "\x1b[?1049h\x1b[H";
const LEAVE_ALT = "\x1b[?1049l";

export interface ScreenOptions {
  readonly title: string;
  readonly format: string;
  /** The novel stage machine's stages: the book mode rail (AGT-1526). */
  readonly stages?: readonly BookStage[];
  readonly stdout?: NodeJS.WriteStream;
  readonly stdin?: NodeJS.ReadStream;
}

/** Runs the screen until the author quits; resolves with the process exit code. */
export async function runScreen(options: ScreenOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  // A bad or conflicting binding in the config is refused before the screen opens, with the reason on stderr.
  let keymap;
  try {
    keymap = loadKeymap();
  } catch (error) {
    if (!(error instanceof KeysError)) throw error;
    process.stderr.write(`pablo: ${error.message}\n`);
    return 1;
  }
  const book = bookRail(options.stages ?? []);
  const drafted = (options.stages ?? []).filter((s) => s.status === "drafted").length;
  const total = (options.stages ?? []).filter((s) => s.depth > 0).length;
  stdout.write(ENTER_ALT);
  try {
    const app = render(<App title={options.title} format={options.format} drafted={drafted} total={total} book={book} keymap={keymap} editor={loadEditor()} />, {
      exitOnCtrlC: true,
      stdout,
      ...(options.stdin ? { stdin: options.stdin } : {}),
    });
    await app.waitUntilExit();
    app.clear();
  } finally {
    stdout.write(LEAVE_ALT);
  }
  return 0;
}
