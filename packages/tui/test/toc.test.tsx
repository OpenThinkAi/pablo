/** AGT-1672: the rail is the core's stages, then a group per output; the status line names the output under the cursor; `a w` writes that output's unit. */
import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app";
import { bookCounts, bookRail, writeArgv, writeRequest, type BookStage } from "../src/book";
import type { WriteResult } from "../src/screen";

afterEach(() => cleanup());
const plain = (frame: string | undefined) => (frame ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOWN = "\x1b[B", RIGHT = "\x1b[C";

const core = (id: string, status: BookStage["status"] = "ready"): BookStage => ({ id, name: id, depth: 0, status, missing: [] });
const group = (output: string, name: string): BookStage => ({ id: `output:${output}`, name, depth: 0, group: true, status: "ready", missing: [], output });
const unit = (output: string, n: number, status: BookStage["status"]): BookStage => ({ id: `unit:${output}:${n}`, name: String(n), depth: 1, status, missing: [], output, unit: n });
const STAGES: BookStage[] = [
  core("premise"), core("research"), core("bible"), core("acts"), core("beats"),
  group("novel", "novel (1/2)"), unit("novel", 1, "drafted"), unit("novel", 2, "ready"),
  group("radio", "radio (0/3)"), unit("radio", 1, "ready"), unit("radio", 2, "missing"), unit("radio", 3, "ready"),
];

test("state model: the rail lists the core, then both output groups; `a w` on radio › 3 is `write --output radio --unit 3`", () => {
  const rail = bookRail(STAGES);
  expect(rail.rows.filter((r) => r.depth === 0).map((r) => r.id)).toEqual(["premise", "research", "bible", "acts", "beats", "output:novel", "output:radio"]);
  expect(rail.folded).toEqual(["output:novel", "output:radio"]);
  expect(rail.outputOf["unit:radio:3"]).toBe("radio");
  expect(rail.outputOf["beats"]).toBeUndefined();
  expect(rail.counts).toEqual({ novel: { drafted: 1, total: 2 }, radio: { drafted: 0, total: 3 } });
  expect(bookCounts(STAGES)).toEqual({ drafted: 1, total: 5 });
  const request = writeRequest(rail, "unit:radio:3");
  expect(request).toEqual({ output: "radio", unit: 3 });
  expect(writeArgv(request!)).toEqual(["write", "--output", "radio", "--unit", "3"]);
  expect(writeRequest(rail, "output:radio")).toBeUndefined();
  expect(writeRequest(rail, "premise")).toBeUndefined();
});

test("moving from the core into each group changes the status line's output name; `a w` on radio › 3 reaches the writer with its output", async () => {
  const calls: [number, string | undefined][] = [];
  const writer = (n: number, _progress: (l: string) => void, output?: string) => {
    calls.push([n, output]);
    return new Promise<WriteResult>(() => {});
  };
  const app = render(<App title="Ice House" format="core" book={bookRail(STAGES)} writer={writer} size={{ cols: 110, rows: 32 }} />);
  await sleep(30);
  const statusLine = () => plain(app.lastFrame()).split("\n").find((l) => l.includes("drafted")) ?? "";
  expect(statusLine()).toContain("core");
  for (let i = 0; i < 5; i++) { app.stdin.write(DOWN); await sleep(20); } // premise .. beats, then onto the novel group
  expect(statusLine()).toContain("novel");
  expect(statusLine()).toContain("1 of 2 drafted");
  app.stdin.write(DOWN); await sleep(20); // the radio group
  expect(statusLine()).toContain("radio");
  expect(statusLine()).toContain("0 of 3 drafted");
  app.stdin.write(RIGHT); await sleep(20); // open it
  for (let i = 0; i < 3; i++) { app.stdin.write(DOWN); await sleep(20); } // radio 1, 2, 3
  app.stdin.write("a"); await sleep(20); app.stdin.write("w"); await sleep(40);
  expect(calls).toEqual([[3, "radio"]]);
  expect(plain(app.lastFrame())).toContain("Writing radio 3");
});
