import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app";
import { resolve } from "../src/chord";
import { keyStateOf } from "../src/keys";
import { clean } from "../src/sanitize";
import { initialState } from "../src/state";

afterEach(() => cleanup());

/** A frame as plain text: Ink colours the dim labels. */
const plain = (frame: string | undefined) => (frame ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the screen shows the project's title and format with the quit key", () => {
  const app = render(<App title="Ice House" format="novel" size={{ cols: 80, rows: 24 }} />);
  const frame = app.lastFrame() ?? "";
  expect(frame).toContain("Ice House");
  expect(frame).toContain("novel");
  expect(frame).toMatch(/q\s+quit/);
});

test("below the minimum size a too-small notice replaces the layout", () => {
  const app = render(<App title="Ice House" format="novel" size={{ cols: 40, rows: 10 }} />);
  const frame = app.lastFrame() ?? "";
  expect(frame).toContain("too small");
  expect(frame).toContain("60x20");
  expect(frame).not.toContain("Ice House");
});

test("q exits the app and clears its frame", async () => {
  const app = render(<App title="Ice House" format="novel" size={{ cols: 80, rows: 24 }} />);
  await sleep(20);
  expect(app.lastFrame()).toContain("Ice House");
  app.stdin.write("q");
  await sleep(50);
  expect(app.lastFrame()).not.toContain("Ice House");
});

test("the keys reach the model: → enters the main pane, Tab is refused with no content, Esc backs out", async () => {
  const app = render(<App title="Ice House" format="novel" size={{ cols: 80, rows: 24 }} />);
  await sleep(20);
  expect(app.lastFrame()).toContain("book · rail");
  // Nothing is loaded in the rail yet, so → has no row to enter; Tab has no content area to move into.
  app.stdin.write("\x1b[C");
  await sleep(30);
  expect(app.lastFrame()).toContain("book · rail");
  app.stdin.write("\t");
  await sleep(30);
  expect(app.lastFrame()).toContain("book · rail");
  app.stdin.write("\x1b");
  await sleep(30);
  expect(app.lastFrame()).toContain("book · rail");
  expect(app.lastFrame()).toContain("Ice House");
});

test("the key panel lists the keys that act, and a prefix swaps it for its second keys", async () => {
  const app = render(<App title="Ice House" format="novel" size={{ cols: 80, rows: 24 }} />);
  await sleep(20);
  expect(app.lastFrame()).toMatch(/v\s+view…/);
  app.stdin.write("v");
  await sleep(30);
  expect(app.lastFrame()).toMatch(/z\s+zen/);
  expect(app.lastFrame()).toContain("v view");
  app.stdin.write("\x1b");
  await sleep(30);
  expect(app.lastFrame()).toMatch(/v\s+view…/);
});

test("a command key reaches onCommand; an unbound key does nothing", async () => {
  const seen: string[] = [];
  const app = render(<App title="Ice House" format="novel" size={{ cols: 80, rows: 24 }} onCommand={(c) => seen.push(c.id)} />);
  await sleep(20);
  app.stdin.write("a");
  await sleep(30);
  app.stdin.write("p");
  await sleep(30);
  app.stdin.write("!");
  await sleep(30);
  expect(seen).toEqual(["ai.plan"]);
});

test("the arrows act in the focused region, Tab moves focus, Esc backs out", () => {
  const rail = initialState();
  const at = (s: typeof rail, token: string) => resolve(keyStateOf(s), s.pending, token);
  expect(at(rail, "down")).toEqual([{ type: "rail.down" }]);
  expect(at(rail, "right")).toEqual([{ type: "rail.expand" }]);
  expect(at(rail, "left")).toEqual([{ type: "rail.collapse" }]);
  expect(at(rail, "esc")).toEqual([{ type: "escape" }]);
  expect(at(rail, "x")).toEqual([]);
  expect(at(rail, "tab")).toEqual([]); // nothing in the content area to move into
  const main = { ...rail, pane: "main" as const, focus: "main" as const };
  expect(at(main, "down")).toEqual([{ type: "main.down" }]);
  expect(at(main, "left")).toEqual([{ type: "main.to_rail" }]);
  expect(at(main, "right")).toEqual([{ type: "command", id: "check.open" }]); // the hit on this line, if any
  const content = { ...rail, focus: "content" as const, content: { title: "t", body: "b" } };
  expect(at(content, "down")).toEqual([{ type: "content.down" }]);
  expect(at(content, "tab")).toEqual([{ type: "focus.back" }]);
  expect(at({ ...rail, content: content.content }, "tab")).toEqual([{ type: "focus.content" }]);
});

test("control characters in the title never reach the screen as escapes", () => {
  const app = render(<App title={"Ice\x1b]0;pwned\x07 House"} format="novel" size={{ cols: 80, rows: 24 }} />);
  expect(app.lastFrame()).not.toContain("\x1b]");
  expect(clean("a\x1b[2Jb")).toBe("ab");
});

const ROWS = [
  { id: "premise", depth: 0 }, { id: "beats", depth: 0 }, { id: "chapters", depth: 0, group: true }, { id: "ch1", depth: 1 }, { id: "ch2", depth: 1 },
];
const book = { title: "Ice House", format: "novel", drafted: 1, total: 2, branch: "draft/ch02", comments: { continuity: 3 }, rows: ROWS, labels: { ch1: "1 The well" }, mainTitle: "chapters/01-the-well.md", lines: ["The well had been dry since June.", "She did not look up."] };

test("the three parts: status area, rail and main pane, content area beside the key panel", async () => {
  const app = render(<App {...book} size={{ cols: 120, rows: 32 }} />);
  await sleep(30);
  const frame = plain(app.lastFrame());
  for (const want of ["Ice House", "novel", "ch 1 of 2 drafted", "branch draft/ch02", "▲ 3 continuity", "BOOK", "premise", "▾ chapters", "1 The well", "chapters/01-the-well.md", "The well had been dry", "CONTENT"]) {
    expect(frame).toContain(want);
  }
  expect(frame.split("\n").length).toBeLessThanOrEqual(32);
});

test("resizing relayouts without a restart", async () => {
  const app = render(<App {...book} size={{ cols: 120, rows: 32 }} />);
  await sleep(30);
  expect(app.lastFrame()).toContain("▾ chapters");
  app.rerender(<App {...book} size={{ cols: 80, rows: 24 }} />);
  await sleep(30);
  const small = plain(app.lastFrame());
  expect(small).toContain("The well had been dry");
  expect(small).toContain("q quit");
  expect(small.split("\n").length).toBeLessThanOrEqual(24);
  app.rerender(<App {...book} size={{ cols: 40, rows: 10 }} />);
  await sleep(30);
  expect(app.lastFrame()).toContain("too small");
  app.rerender(<App {...book} size={{ cols: 120, rows: 32 }} />);
  await sleep(30);
  expect(app.lastFrame()).toContain("▾ chapters");
});

test("at under 100 columns the rail is a narrow strip", async () => {
  const app = render(<App {...book} size={{ cols: 80, rows: 24 }} />);
  await sleep(30);
  const frame = plain(app.lastFrame());
  expect(frame).toContain("BK");
  expect(frame).not.toContain("BOOK");
});

test("the arrows move the rail's cursor through the loaded rows", async () => {
  const app = render(<App {...book} size={{ cols: 120, rows: 32 }} />);
  await sleep(30);
  app.stdin.write("\x1b[B\x1b[B");
  await sleep(30);
  // The cursor is on `chapters`; → steps into it, → again enters the main pane.
  app.stdin.write("\x1b[C\x1b[C\x1b[C");
  await sleep(30);
  expect(app.lastFrame()).toContain("book · main");
});

test("the main pane shows the file behind the selected row, and starts a new document at its top", async () => {
  const docs: Record<string, { title: string; text: string }> = {
    premise: { title: "bible/overview.md", text: "---\ntitle: x\n---\n\nA pond, a house, a family." },
    ch1: { title: "chapters/01-the-well.md · draft", text: "The well had been dry since June.\nShe did not look up.\n\n" + Array.from({ length: 30 }, (_, i) => `Line ${i + 1}.\n`).join("\n") },
  };
  const app = render(<App {...book} lines={[]} mainTitle="" load={(id) => docs[id]} size={{ cols: 120, rows: 32 }} />);
  await sleep(30);
  expect(plain(app.lastFrame())).toContain("bible/overview.md");
  expect(plain(app.lastFrame())).toContain("A pond, a house, a family.");
  expect(plain(app.lastFrame())).not.toContain("title: x");
  for (const key of ["\x1b[B", "\x1b[B", "\x1b[B"]) { app.stdin.write(key); await sleep(20); }
  await sleep(30);
  const frame = plain(app.lastFrame());
  expect(frame).toContain("chapters/01-the-well.md · draft");
  expect(frame).toContain("The well had been dry since June. She did not look up.");
  // → enters the main pane; g e goes to the end, the view scrolls with it; g g returns to the top.
  app.stdin.write("\x1b[C"); await sleep(30);
  app.stdin.write("g"); await sleep(20); app.stdin.write("e"); await sleep(40);
  expect(plain(app.lastFrame())).toContain("Line 30.");
  expect(plain(app.lastFrame())).not.toContain("She did not look up.");
  app.stdin.write("g"); await sleep(20); app.stdin.write("g"); await sleep(40);
  expect(plain(app.lastFrame())).toContain("She did not look up.");
});

test("an opened chapter is checked: each hit is a box under its line, g f / g F walk them, → opens the detail", async () => {
  const text = "---\nchapter: 1\n---\n\nThe well had been dry since June.\nShe did not look up — not once.\n\nEdwin stood in the doorway.\nLittle did he know.";
  const docs: Record<string, { title: string; text: string; file?: string }> = {
    premise: { title: "bible/overview.md", text: "A pond." },
    ch1: { title: "chapters/01-the-well.md · draft", text, file: "chapters/01-the-well.md" },
  };
  const scanned: string[] = [];
  const checks = (file: string, t: string) => {
    scanned.push(file);
    return t === text ? [{ line: 6, rule: "em-dash", excerpt: "She did not look up — not once." }, { line: 9, rule: "foreshadow", excerpt: "Little did he know." }] : [];
  };
  const app = render(<App {...book} lines={[]} mainTitle="" load={(id) => docs[id]} checks={checks} size={{ cols: 120, rows: 32 }} />);
  await sleep(30);
  // The premise has no file, so it is not scanned; the first chapter is, as it opens.
  expect(scanned).toEqual([]);
  for (const key of ["\x1b[B", "\x1b[B", "\x1b[B"]) { app.stdin.write(key); await sleep(20); }
  await sleep(30);
  expect(scanned).toContain("chapters/01-the-well.md");
  let frame = plain(app.lastFrame());
  expect(frame).toContain("╭ ▲ tells · em-dash");
  expect(frame).toContain("╭ ▲ tells · foreshadow");
  expect(frame).toContain("▲ 3 continuity · 2 check"); // the status area counts them
  // The box is under its line: the line, then its top border, before the next paragraph.
  expect(frame.indexOf("She did not look up")).toBeLessThan(frame.indexOf("tells · em-dash"));
  expect(frame.indexOf("tells · em-dash")).toBeLessThan(frame.indexOf("Edwin stood"));
  // → enters the main pane (cursor on the first line, which is not yet a hit's); g f goes to the first box; → opens it.
  app.stdin.write("\x1b[C"); await sleep(30);
  app.stdin.write("g"); await sleep(20); app.stdin.write("f"); await sleep(30);
  app.stdin.write("\x1b[C"); await sleep(30);
  frame = plain(app.lastFrame());
  expect(frame).toContain("check · em-dash · line 6");
  expect(frame).toContain("pattern: an em-dash");
  // g F from the first hit wraps to the last; Esc closes the detail.
  app.stdin.write("g"); await sleep(20); app.stdin.write("F"); await sleep(30);
  app.stdin.write("\x1b[C"); await sleep(30);
  expect(plain(app.lastFrame())).toContain("check · foreshadow · line 9");
  app.stdin.write("\x1b"); await sleep(30);
  expect(plain(app.lastFrame())).not.toContain("check · foreshadow · line 9");
});
