import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editorArgv, NO_EDITOR, openInEditor, parseEditor } from "../src/editor";

/**
 * The `$EDITOR` hand-off (AC4).
 *
 * Neither Helix nor Neovim is installed on this machine, so the argv each one
 * needs is pinned as a unit test and the *spawn* is verified for real against a
 * shell script named `nvim` and `hx` in a temporary `bin/`: the script records
 * its own argv and writes the file, which proves pablo passes the line in the
 * right form, waits for the child, and re-reads what it wrote. `vim` — which is
 * installed, and takes the same `+N file` argv as Neovim — was driven by hand
 * under `script -q /dev/null` to confirm the form opens at the line rather than
 * creating a file called `+N`.
 */

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop() ?? "", { recursive: true, force: true });
});

/** A stand-in editor: records its argv, then writes `replacement` over the file. */
function fakeEditor(name: string, replacement: string, exitCode = 0): { path: string; argvLog: string } {
  const directory = mkdtempSync(join(tmpdir(), "pablo-editor-"));
  directories.push(directory);
  const bin = join(directory, "bin");
  mkdirSync(bin);

  const argvLog = join(directory, "argv.txt");
  const path = join(bin, name);
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${JSON.stringify(argvLog)}`,
      'for arg in "$@"; do last="$arg"; done',
      `printf '%s' ${JSON.stringify(replacement)} > "$last"`,
      `exit ${exitCode}`,
    ].join("\n"),
    "utf8",
  );
  chmodSync(path, 0o755);
  return { path, argvLog };
}

function manuscript(text: string): string {
  const directory = mkdtempSync(join(tmpdir(), "pablo-manuscript-"));
  directories.push(directory);
  const path = join(directory, "chapter-26.md");
  writeFileSync(path, text, "utf8");
  return path;
}

test("$EDITOR is split like a shell word list, quotes included", () => {
  expect(parseEditor("hx")).toEqual({ command: "hx", args: [] });
  expect(parseEditor("zed --wait")).toEqual({ command: "zed", args: ["--wait"] });
  expect(parseEditor('"/Applications/My Editor/bin/ed" --wait')).toEqual({
    command: "/Applications/My Editor/bin/ed",
    args: ["--wait"],
  });
  expect(parseEditor("  ")).toBeUndefined();
  expect(parseEditor(undefined)).toBeUndefined();
});

test("each editor gets the argv it actually understands (AC4)", () => {
  expect(editorArgv({ command: "hx", args: [] }, "/w/c.md", 12)).toEqual(["hx", "/w/c.md:12"]);
  expect(editorArgv({ command: "/usr/local/bin/helix", args: [] }, "/w/c.md", 12)).toEqual([
    "/usr/local/bin/helix",
    "/w/c.md:12",
  ]);
  expect(editorArgv({ command: "nvim", args: [] }, "/w/c.md", 12)).toEqual(["nvim", "+12", "/w/c.md"]);
  expect(editorArgv({ command: "vim", args: ["-p"] }, "/w/c.md", 12)).toEqual(["vim", "-p", "+12", "/w/c.md"]);

  // An editor pablo does not know the line syntax of opens the file and no
  // more: a guessed flag becomes a file name, which is worse than no line.
  expect(editorArgv({ command: "zed", args: ["--wait"] }, "/w/c.md", 12)).toEqual(["zed", "--wait", "/w/c.md"]);

  // Never a zero or negative line, whatever the caller computed.
  expect(editorArgv({ command: "nvim", args: [] }, "/w/c.md", 0)).toEqual(["nvim", "+1", "/w/c.md"]);
});

test("the editor is spawned at the line and pablo waits for it (AC4)", async () => {
  const path = manuscript("# Twenty-Six\n\nThe cellar was cold.\n");
  const editor = fakeEditor("nvim", "# Twenty-Six\n\nThe cellar held its cold.\n");

  const run = await openInEditor(path, 3, { env: { EDITOR: editor.path } });

  expect(run.exitCode).toBe(0);
  expect(run.argv).toEqual([editor.path, "+3", path]);
  expect(readFileSync(editor.argvLog, "utf8")).toBe(`+3\n${path}\n`);
  expect(readFileSync(path, "utf8")).toContain("held its cold");
});

test("helix gets the file:line form, spawned for real", async () => {
  const path = manuscript("one\ntwo\nthree\n");
  const editor = fakeEditor("hx", "edited\n");

  const run = await openInEditor(path, 2, { env: { EDITOR: editor.path } });

  expect(run.argv).toEqual([editor.path, `${path}:2`]);
  // Helix takes the path and the line as one argument, so the script's "last
  // argument" is not a path and it wrote a file next to the manuscript. That is
  // the point of the assertion: the form is what Helix expects, not what a
  // shell script finds convenient.
  expect(readFileSync(editor.argvLog, "utf8")).toBe(`${path}:2\n`);
});

test("a non-zero exit is reported rather than swallowed", async () => {
  const path = manuscript("one\n");
  const editor = fakeEditor("nvim", "two\n", 3);

  const run = await openInEditor(path, 1, { env: { EDITOR: editor.path } });
  expect(run.exitCode).toBe(3);
});

test("VISUAL stands in for EDITOR, and neither set is a named error", async () => {
  const path = manuscript("one\n");
  const editor = fakeEditor("nvim", "two\n");

  const run = await openInEditor(path, 1, { env: { VISUAL: editor.path } });
  expect(run.argv[0]).toBe(editor.path);

  await expect(openInEditor(path, 1, { env: {} })).rejects.toThrow(NO_EDITOR);
});
