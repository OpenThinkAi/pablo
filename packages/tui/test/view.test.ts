import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { CARET_GLYPH } from "../src/theme";
import { openView, type ViewHandle } from "../src/view";

/**
 * The view through opentui's own headless renderer: real renderables, real key
 * parsing, real frames. Everything is torn down in `afterEach` — a leaked
 * renderer holds the process open.
 */

const directories: string[] = [];
const open: ViewHandle[] = [];
const renderers: TestRendererSetup[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()?.stop();
  while (renderers.length > 0) renderers.pop()?.renderer.destroy();
  while (directories.length > 0) rmSync(directories.pop() ?? "", { recursive: true, force: true });
});

const CHAPTER = `# Twenty-Six

The cellar was cold in a way the house never was, and {~~stayed~>kept~~} that way
until April.

{++She counted the barrels twice.++} There were nineteen.

{>>check the date against the ledger<<}
`;

function workspace(text = CHAPTER): string {
  const directory = mkdtempSync(join(tmpdir(), "pablo-view-"));
  directories.push(directory);
  const path = join(directory, "chapter-26.md");
  writeFileSync(path, text, "utf8");
  return path;
}

/** Wait for a filesystem event to land. `fs.watch` latency is not frame-paced. */
interface UntilOptions {
  /**
   * Re-run every second until the predicate holds. On macOS `fs.watch` arms its
   * FSEvents stream asynchronously, so a write that lands between `watch()`
   * returning and the stream listening is not seen late — it is **lost**, and
   * no timeout recovers it. Writing again is what does, and a repeat of the
   * same bytes costs one read and no re-render.
   */
  readonly nudge?: () => void;
  readonly timeoutMs?: number;
}

async function until(predicate: () => boolean, options: UntilOptions = {}): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  let nextNudge = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the view to catch up");
    if (options.nudge !== undefined && Date.now() >= nextNudge) {
      options.nudge();
      nextNudge = Date.now() + 1_000;
    }
    await Bun.sleep(5);
  }
}

async function view(path: string, size = { width: 64, height: 14 }): Promise<[ViewHandle, TestRendererSetup]> {
  const setup = await createTestRenderer(size);
  renderers.push(setup);
  const handle = await openView(path, { renderer: setup.renderer, debounceMs: 5 });
  open.push(handle);
  await setup.renderOnce();
  return [handle, setup];
}

test("`pablo <file.md>` draws the manuscript through opentui (AC1, AC2)", async () => {
  const [handle, setup] = await view(workspace());
  const drawn = setup.captureCharFrame();

  expect(drawn).toContain("Twenty-Six");
  expect(drawn).toContain("The cellar was cold");
  for (const delimiter of ["{~~", "~>", "~~}", "{++", "++}", "{>>", "<<}"]) {
    expect(drawn).not.toContain(delimiter);
  }
  // The status line is the last row, and it names the selection.
  expect(drawn).toContain("paragraph");
  expect(handle.state().selection.granularity).toBe("paragraph");
});

test("only the visible window is drawn: the frame is the screen, not the file", async () => {
  const path = workspace(`# Long\n\n${Array.from({ length: 400 }, (_, index) => `Paragraph ${index}.`).join("\n\n")}\n`);
  const [handle] = await view(path);

  expect(handle.lines().length).toBe(13);
  expect(handle.frame()).toContain("Paragraph 0.");
  expect(handle.frame()).not.toContain("Paragraph 60.");
});

test("keys move the selection and the ladder works through the renderer (AC3, AC5)", async () => {
  const [handle, setup] = await view(workspace());
  const first = handle.state().selection.span;

  await setup.mockInput.pressKey("n");
  expect(handle.state().selection.span.start).toBeGreaterThan(first.start);

  await setup.mockInput.pressKey("+");
  expect(handle.state().selection.granularity).toBe("scene");

  await setup.mockInput.pressKey("-");
  expect(handle.state().selection.granularity).toBe("paragraph");
});

test("a zero-width selection is reachable by key and visible on screen (AC3)", async () => {
  const [handle, setup] = await view(workspace());

  await setup.mockInput.pressKey("i");
  await setup.renderOnce();

  const selection = handle.state().selection.span;
  expect(selection.start).toBe(selection.end);
  expect(setup.captureCharFrame()).toContain(CARET_GLYPH);
});

test("`?` shows the key map, and scrolls it so the whole map is reachable", async () => {
  const [handle, setup] = await view(workspace());

  await setup.mockInput.pressKey("?");
  await setup.renderOnce();

  expect(handle.state().help).toBe(true);
  expect(setup.captureCharFrame()).toContain("pablo — keys");

  // The map is taller than a short terminal, so the scroll keys scroll it
  // rather than the manuscript underneath.
  await setup.mockInput.pressKey(" ");
  await setup.mockInput.pressKey(" ");
  await setup.renderOnce();
  expect(handle.frame()).toContain("quit");
  expect(handle.state().anchor).toEqual({ blockIndex: 0, line: 0 });

  await setup.mockInput.pressKey("?");
  expect(handle.state().help).toBe(false);
});

test("an external write re-renders without losing the cursor position (AC4)", async () => {
  const path = workspace();
  const [handle, setup] = await view(path);

  await setup.mockInput.pressKey("n");
  const before = handle.state().selection.span;
  expect(handle.frame()).toContain("stayed");

  const write = () => writeFileSync(path, CHAPTER.replace("nineteen", "twenty-one"), "utf8");
  write();
  await until(() => handle.state().doc.text.includes("twenty-one"), { nudge: write });
  await setup.renderOnce();

  expect(handle.state().selection.span).toEqual(before);
  expect(setup.captureCharFrame()).toContain("twenty-one");
  expect(handle.state().message).toBe("reloaded from disk");
});

test("`r` re-reads on demand", async () => {
  const path = workspace();
  const [handle] = await view(path);

  writeFileSync(path, CHAPTER.replace("nineteen", "seventy"), "utf8");
  handle.reload();

  expect(handle.frame()).toContain("seventy");
});

test("`q` stops the view and resolves it", async () => {
  const [handle, setup] = await view(workspace());

  await setup.mockInput.pressKey("q");
  await handle.closed;

  expect(handle.state().running).toBe(false);
  // Stopping twice is safe: the CLI's exit path and a key can both get there.
  handle.stop();
});

test("a resize re-wraps the manuscript", async () => {
  const [handle, setup] = await view(workspace());
  const wide = handle.frame();

  setup.resize(34, 14);
  await setup.renderOnce();

  expect(handle.state().width).toBe(34);
  expect(handle.frame()).not.toBe(wide);
  for (const line of handle.lines()) {
    expect(line.segments.reduce((total, segment) => total + segment.text.length, 0)).toBeLessThanOrEqual(34);
  }
});
