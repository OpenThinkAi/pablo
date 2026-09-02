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

/** Wait for the watch to fire, without pinning the test to a fixed sleep. */
async function nextChange(path: string): Promise<Manuscript> {
  return await new Promise<Manuscript>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the watch never fired")), 4000);
    const stop = watchManuscript(
      path,
      (manuscript) => {
        clearTimeout(timer);
        resolve(manuscript);
      },
      { debounceMs: 5, initialText: loadManuscript(path).doc.text },
    );
    stops.push(stop);
  });
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
  const changed = nextChange(path);

  writeFileSync(path, "# One\n\nThe {++very ++}cold cellar.\n", "utf8");

  const manuscript = await changed;
  expect(manuscript.doc.text).toContain("cold cellar");
  expect(manuscript.model.marks.length).toBe(1);
});

test("an atomic save (write a temp file, rename it over the target) is seen too", async () => {
  const path = workspace("# One\n\nThe cellar.\n");
  const changed = nextChange(path);

  // This is what vim, helix, and most editors actually do on :w — the inode
  // changes, which is why the watch is on the directory.
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, "# One\n\nThe cellar, rewritten.\n", "utf8");
  renameSync(temporary, path);

  expect((await changed).doc.text).toContain("rewritten");
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
