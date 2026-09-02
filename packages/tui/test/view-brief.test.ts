import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import type { SpawnResult, Spawner } from "../src/brief";
import { openView, type ViewHandle } from "../src/view";

/**
 * The brief through the real view: a real vault tree in a temp directory, real
 * detection, real key handling, and either a fake spawner or a fake `think` on
 * a `PATH` this file controls. Matt's own vault is never read.
 */

const directories: string[] = [];
const open: ViewHandle[] = [];
const renderers: TestRendererSetup[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()?.stop();
  while (renderers.length > 0) renderers.pop()?.renderer.destroy();
  while (directories.length > 0) rmSync(directories.pop() ?? "", { recursive: true, force: true });
});

const CHAPTER = `# One

The cellar was cold in a way the house never was.

She counted the barrels twice. There were nineteen.
`;

const BRIEF = `── personal context ──
The Valley's Shadow: the estate is Casa della Luna.

── repo lessons [ice-house] ──
The model will paraphrase the beat sheet into telling if it is not stopped.`;

/** `<vault>/style/` plus `<vault>/novels/ice-house/chapters/01.md` — a real tree. */
function vault(): { root: string; chapter: string } {
  const root = mkdtempSync(join(tmpdir(), "pablo-vault-"));
  directories.push(root);
  mkdirSync(join(root, "style"), { recursive: true });
  writeFileSync(join(root, "style", "prose.md"), "# Prose\n\nNo em dashes.\n", "utf8");

  const chapters = join(root, "novels", "ice-house", "chapters");
  mkdirSync(chapters, { recursive: true });
  const chapter = join(chapters, "01-the-last-full-cut.md");
  writeFileSync(chapter, CHAPTER, "utf8");
  return { root, chapter };
}

/** A file that is in no vault at all. */
function loose(): string {
  const directory = mkdtempSync(join(tmpdir(), "pablo-loose-"));
  directories.push(directory);
  const path = join(directory, "scratch.md");
  writeFileSync(path, CHAPTER, "utf8");
  return path;
}

function fakeThink(script: string): string {
  const directory = mkdtempSync(join(tmpdir(), "pablo-path-"));
  directories.push(directory);
  const path = join(directory, "think");
  writeFileSync(path, script, "utf8");
  chmodSync(path, 0o755);
  return directory;
}

function spawner(result: Partial<SpawnResult>, calls: string[][], delayMs = 0): Spawner {
  return async (command) => {
    calls.push([...command]);
    if (delayMs > 0) await Bun.sleep(delayMs);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...result };
  };
}

interface Opened {
  readonly handle: ViewHandle;
  readonly setup: TestRendererSetup;
}

async function view(path: string, brief: Parameters<typeof openView>[1]): Promise<Opened> {
  const setup = await createTestRenderer({ width: 64, height: 16 });
  renderers.push(setup);
  const handle = await openView(path, { renderer: setup.renderer, debounceMs: 5, ...brief });
  open.push(handle);
  await setup.renderOnce();
  return { handle, setup };
}

test("opening a file in a vault briefs its work once, off the render loop (AC1)", async () => {
  const { chapter } = vault();
  const calls: string[][] = [];
  const { handle, setup } = await view(chapter, {
    brief: { resolve: () => "/fake/think", spawn: spawner({ stdout: BRIEF }, calls, 40) },
  });

  // The manuscript is already on screen before the brief has settled: the view
  // never waits on it.
  expect(setup.captureCharFrame()).toContain("The cellar was cold");
  expect(handle.state().brief.status).toBe("loading");

  await handle.briefSettled;
  expect(handle.work()?.slug).toBe("ice-house");
  expect(calls).toEqual([["/fake/think", "brief", "--cortex", "writing", "--context", "ice-house"]]);
  expect(handle.state().brief.status).toBe("ready");

  // AC2's seam: the cached text, for the pack the `prompt` verb assembles.
  expect(handle.briefText()).toBe(BRIEF);

  // Once per session: opening and closing the pane re-reads the cache, not think.
  handle.press({ name: "b", sequence: "B" });
  handle.press({ name: "escape", sequence: "" });
  handle.press({ name: "b", sequence: "B" });
  expect(calls.length).toBe(1);
});

test("`B` opens the brief as an overlay and `esc` closes it (AC2)", async () => {
  const { chapter } = vault();
  const { handle, setup } = await view(chapter, {
    brief: { resolve: () => "/fake/think", spawn: spawner({ stdout: BRIEF }, []) },
  });
  await handle.briefSettled;

  await setup.mockInput.pressKey("B");
  await setup.renderOnce();

  const shown = setup.captureCharFrame();
  expect(handle.state().brief.open).toBe(true);
  expect(shown).toContain("pablo — brief: ice-house");
  expect(shown).toContain("Casa della Luna");
  expect(shown).toContain("think brief --cortex writing --context ice-house");
  expect(shown).not.toContain("The cellar was cold");

  handle.press({ name: "escape", sequence: "" });
  await setup.renderOnce();
  expect(handle.state().brief.open).toBe(false);
  expect(setup.captureCharFrame()).toContain("The cellar was cold");
});

test("the help and the brief are one overlay at a time, and both scroll", async () => {
  const { chapter } = vault();
  const long = Array.from({ length: 60 }, (_, index) => `brief line ${index}`).join("\n");
  const { handle } = await view(chapter, {
    brief: { resolve: () => "/fake/think", spawn: spawner({ stdout: long }, []) },
  });
  await handle.briefSettled;

  handle.press({ name: "b", sequence: "B" });
  handle.press({ name: "down", sequence: "" });
  handle.press({ name: "down", sequence: "" });
  expect(handle.state().brief.offset).toBe(2);
  // The manuscript underneath did not move.
  expect(handle.state().anchor).toEqual({ blockIndex: 0, line: 0 });

  handle.press({ name: "?", sequence: "?" });
  expect(handle.state().help).toBe(true);
  expect(handle.state().brief.open).toBe(false);
  expect(handle.frame()).toContain("pablo — keys");
  // The key map documents the brief, because it is generated from the bindings.
  handle.press({ name: "escape", sequence: "" });
  expect(handle.state().help).toBe(false);
});

test("the brief is never written into the manuscript (AC4)", async () => {
  const { chapter } = vault();
  const before = readFileSync(chapter);
  const { handle, setup } = await view(chapter, {
    brief: { resolve: () => "/fake/think", spawn: spawner({ stdout: BRIEF }, []) },
  });

  await handle.briefSettled;
  handle.press({ name: "b", sequence: "B" });
  await setup.renderOnce();
  handle.press({ name: "b", sequence: "B" });
  await setup.renderOnce();
  handle.reload();

  expect(readFileSync(chapter).equals(before)).toBe(true);
  expect(handle.state().doc.text).toBe(CHAPTER);
  expect(handle.state().doc.text).not.toContain("Casa della Luna");
});

test("a failing think leaves the view open and says so in one line (AC3)", async () => {
  const { chapter } = vault();
  const { handle, setup } = await view(chapter, {
    brief: {
      resolve: () => "/fake/think",
      spawn: spawner({ exitCode: 1, stderr: "error: cortex writing is not readable\n" }, []),
    },
  });

  await handle.briefSettled;
  await setup.renderOnce();

  expect(handle.state().running).toBe(true);
  expect(handle.state().brief.status).toBe("unavailable");
  expect(handle.briefText()).toBeUndefined();

  const frame = setup.captureCharFrame();
  expect(frame).toContain("The cellar was cold");
  expect(frame).toContain("exit 1");

  // The pane does not open on nothing; it repeats the reason instead.
  handle.press({ name: "b", sequence: "B" });
  expect(handle.state().brief.open).toBe(false);
  expect(handle.state().message).toContain("exit 1");
});

test("think missing from PATH is the same non-event (AC3)", async () => {
  const { chapter } = vault();
  const empty = mkdtempSync(join(tmpdir(), "pablo-empty-"));
  directories.push(empty);

  const { handle, setup } = await view(chapter, { brief: { path: empty } });
  await handle.briefSettled;
  await setup.renderOnce();

  expect(handle.state().running).toBe(true);
  expect(handle.state().brief.status).toBe("unavailable");
  expect(setup.captureCharFrame()).toContain("The cellar was cold");
  expect(handle.state().message).toContain("PATH");
});

test("a file outside a vault briefs nothing and spawns nothing", async () => {
  const calls: string[][] = [];
  const { handle } = await view(loose(), {
    brief: { resolve: () => "/fake/think", spawn: spawner({ stdout: BRIEF }, calls) },
  });

  await handle.briefSettled;
  expect(calls).toEqual([]);
  expect(handle.work()).toBeUndefined();
  expect(handle.briefText()).toBeUndefined();
  expect(handle.state().brief.status).toBe("none");

  handle.press({ name: "b", sequence: "B" });
  expect(handle.state().brief.open).toBe(false);
  expect(handle.state().message).toContain("not under");
});

test("`brief: false` skips the whole thing", async () => {
  const calls: string[][] = [];
  const { chapter } = vault();
  const { handle } = await view(chapter, { brief: false });
  await handle.briefSettled;

  expect(calls).toEqual([]);
  expect(handle.work()).toBeUndefined();
  expect(handle.state().brief.status).toBe("none");
});

test("quitting kills a brief that is still running, and does not hang", async () => {
  const { chapter } = vault();
  const bin = fakeThink("#!/bin/sh\nexec sleep 30\n");
  const { handle } = await view(chapter, { brief: { path: bin, timeoutMs: 30_000 } });

  expect(handle.state().brief.status).toBe("loading");
  handle.stop();

  const started = Date.now();
  await handle.briefSettled;
  await handle.closed;

  expect(Date.now() - started).toBeLessThan(5_000);
  expect(handle.briefText()).toBeUndefined();
});
