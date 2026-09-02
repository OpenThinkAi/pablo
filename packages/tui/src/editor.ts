/**
 * The `$EDITOR` hand-off (AC4).
 *
 * "Not a text editor" is only livable because the real one is one key away.
 * pablo suspends its renderer, gives the terminal to Helix or Neovim at the
 * line the selection is on, waits, and re-reads the file when it comes back —
 * the same re-read an external write already triggers, so nothing about the
 * return path is special.
 *
 * The argv is per-editor because the two editors pablo targets disagree about
 * how to say "open at line N", and getting it wrong opens a *file* called
 * `+12`:
 *
 *     hx            file.md:12      (Helix; also `hx file.md:12:3` for a column)
 *     nvim / vim    +12 file.md
 *     anything else file.md         (the line is dropped, never guessed)
 *
 * `$EDITOR` is a shell word list in practice (`code --wait`, `zed --wait`), so
 * it is split on whitespace with quoting honoured, and the editor is spawned
 * directly rather than through a shell: the manuscript path is data, and data
 * never becomes shell syntax.
 */

import { basename } from "node:path";

export interface EditorCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface EditorRun {
  /** What was actually spawned, for the status line and for a test to assert on. */
  readonly argv: readonly string[];
  readonly exitCode: number;
}

export interface OpenInEditorOptions {
  readonly env?: Record<string, string | undefined>;
  /** Injected by the tests; defaults to `Bun.spawn` with the terminal inherited. */
  readonly spawn?: (argv: readonly string[]) => Promise<number>;
}

/**
 * Splits `$EDITOR` into a command and its arguments, honouring single and
 * double quotes so a path with a space survives. Returns `undefined` for an
 * unset or blank value.
 */
export function parseEditor(value: string | undefined): EditorCommand | undefined {
  if (value === undefined) return undefined;
  const words = value.match(/"([^"]*)"|'([^']*)'|\S+/g) ?? [];
  const unquoted = words.map((word) => word.replace(/^(["'])(.*)\1$/, "$2")).filter((word) => word !== "");
  const [command, ...args] = unquoted;
  return command === undefined ? undefined : { command, args };
}

/** The full argv that opens `path` at `line`, in the form the editor understands. */
export function editorArgv(editor: EditorCommand, path: string, line: number): string[] {
  const at = Math.max(1, Math.floor(line));
  const name = basename(editor.command);

  if (name === "hx" || name === "helix") return [editor.command, ...editor.args, `${path}:${at}`];
  if (name === "nvim" || name === "vim" || name === "vi" || name === "view") {
    return [editor.command, ...editor.args, `+${at}`, path];
  }
  return [editor.command, ...editor.args, path];
}

/** What to tell the author when `$EDITOR` is not set. */
export const NO_EDITOR =
  "$EDITOR is not set — export it (hx, nvim, or anything else) and press o again";

/**
 * Runs `$EDITOR` on `path` at `line` and resolves when it exits.
 *
 * The caller owns suspending and resuming the renderer around this: this
 * function knows nothing about a terminal beyond inheriting one, which is what
 * keeps it testable with a shell script standing in for an editor.
 */
export async function openInEditor(
  path: string,
  line: number,
  options: OpenInEditorOptions = {},
): Promise<EditorRun> {
  const env = options.env ?? process.env;
  const editor = parseEditor(env["EDITOR"] ?? env["VISUAL"]);
  if (editor === undefined) throw new Error(NO_EDITOR);

  const argv = editorArgv(editor, path, line);
  const run = options.spawn ?? inheritedSpawn;
  return { argv, exitCode: await run(argv) };
}

/**
 * The real hand-off: the child gets pablo's own stdin, stdout and stderr, which
 * is the whole point — a full-screen editor needs the terminal, not a pipe.
 */
async function inheritedSpawn(argv: readonly string[]): Promise<number> {
  const child = Bun.spawn([...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await child.exited;
}
