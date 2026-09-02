import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManuscript, watchManuscript, type Manuscript } from "../src/source";

const directories: string[] = [];
const stops: Array<() => void> = [];

afterEach(() => {
  while (stops.length > 0) stops.pop()?.();
  while (directories.length > 0) rmSync(directories.pop() ?? "", { recursive: true, force: true });
});

function workspace(text: string): string {
  const directory = mkdtempSync(join(tmpdir(), "pablo-source-"));
  directories.push(directory);
  const path = join(directory, "chapter-01.md");
  writeFileSync(path, text, "utf8");
  return path;
}

/**
 * Arm the watch, run `write`, and wait for the change it causes.
 *
 * `write` is repeated every second until the watch fires. On macOS `fs.watch`
 * arms its FSEvents stream asynchronously, so a write that lands between
 * `watch()` returning and the stream actually listening is not seen late — it
 * is **lost**, which is why raising the timeout never fixed this test and
 * writing again does. A repeat is free: `watchManuscript` compares the text it
 * last handed out, so a write of identical bytes costs one read and no
 * callback.
 */
async function changeVia(path: string, write: () => void, ceilingMs = 10_000): Promise<Manuscript> {
  let seen: Manuscript | undefined;
  stops.push(
    watchManuscript(path, (manuscript) => (seen ??= manuscript), {
      debounceMs: 5,
      initialText: loadManuscript(path).doc.text,
    }),
  );

  const deadline = Date.now() + ceilingMs;
  let nextWrite = Date.now();
  while (seen === undefined) {
    if (Date.now() > deadline) throw new Error("the watch never fired");
    if (Date.now() >= nextWrite) {
      write();
      nextWrite = Date.now() + 1_000;
    }
    await Bun.sleep(10);
  }
  return seen;
}

test("loadManuscript reads and parses the file, and offsets index that exact text", () => {
  const path = workspace("# One\n\nThe {++cold++} cellar.\n");
  const manuscript = loadManuscript(path);

  expect(manuscript.doc.path).toBe(path);
  expect(manuscript.model.text).toBe(manuscript.doc.text);
  const mark = manuscript.model.marks[0];
  expect(manuscript.doc.text.slice(mark?.body.start ?? 0, mark?.body.end ?? 0)).toBe("cold");
});

test("an external write is picked up and re-parsed (AC4)", async () => {
  const path = workspace("# One\n\nThe cellar.\n");

  const manuscript = await changeVia(path, () =>
    writeFileSync(path, "# One\n\nThe {++very ++}cold cellar.\n", "utf8"),
  );

  expect(manuscript.doc.text).toContain("cold cellar");
  expect(manuscript.model.marks.length).toBe(1);
});

test("an atomic save (write a temp file, rename it over the target) is seen too", async () => {
  const path = workspace("# One\n\nThe cellar.\n");

  // This is what vim, helix, and most editors actually do on :w — the inode
  // changes, which is why the watch is on the directory.
  const manuscript = await changeVia(path, () => {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, "# One\n\nThe cellar, rewritten.\n", "utf8");
    renameSync(temporary, path);
  });

  expect(manuscript.doc.text).toContain("rewritten");
});

test("stopping the watch stops the callbacks", async () => {
  const path = workspace("# One\n\nThe cellar.\n");
  let calls = 0;
  const stop = watchManuscript(path, () => (calls += 1), { debounceMs: 5 });
  stop();

  writeFileSync(path, "# One\n\nChanged.\n", "utf8");
  await Bun.sleep(120);
  expect(calls).toBe(0);
});

test("a write that does not change the text does not re-render", async () => {
  const text = "# One\n\nThe cellar.\n";
  const path = workspace(text);
  let calls = 0;
  stops.push(watchManuscript(path, () => (calls += 1), { debounceMs: 5, initialText: text }));

  writeFileSync(path, text, "utf8");
  await Bun.sleep(120);
  expect(calls).toBe(0);
});
