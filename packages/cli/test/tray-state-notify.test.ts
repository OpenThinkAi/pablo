import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NOTIFICATION_TITLE, notificationBody, osascriptArgs, safeText } from "../src/tray/notify";
import { notifiedPath, readNotified, toTrayRounds, trayDir, writeNotified, writeTrayState } from "../src/tray/state";
import { tempDir } from "./tray-fakes";

let dir: string;
beforeEach(() => {
  dir = tempDir("pablo-tray-state-");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("state", () => {
  test("trayDir follows XDG_STATE_HOME, else ~/.local/state", () => {
    expect(trayDir({ XDG_STATE_HOME: "/x/state" })).toBe("/x/state/pablo/tray");
    expect(trayDir({ HOME: "/h" })).toBe("/h/.local/state/pablo/tray");
  });

  test("the state projects rounds down to ref, title, sender and status only", () => {
    const rounds = toTrayRounds([
      { repo: "OpenThinkAi/a-reading", pr: 1, ref: "OpenThinkAi/a-reading#1", title: "T", url: "u", sender: "matt", date: "d", chapters: [{ number: 3, path: "novels/x/chapters/03-a.md" }], status: "waiting" },
    ]);
    expect(rounds).toEqual([{ ref: "OpenThinkAi/a-reading#1", title: "T", sender: "matt", status: "waiting" }]);
  });

  test("writeTrayState is temp-then-rename and creates its directory", () => {
    const path = join(dir, "deep", "tray-state.json");
    writeTrayState(path, { daemonPid: 7, version: "0.1.0", rounds: [] });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ daemonPid: 7, version: "0.1.0", rounds: [] });
  });

  test("notified refs round-trip; a missing or damaged file is empty", () => {
    const path = notifiedPath(dir);
    expect(readNotified(path).size).toBe(0);
    writeNotified(path, new Set(["b", "a"]));
    expect([...readNotified(path)]).toEqual(["a", "b"]);
    writeFileSync(path, "{{");
    expect(readNotified(path).size).toBe(0);
    writeFileSync(path, JSON.stringify(["ok", 3, null]));
    expect([...readNotified(path)]).toEqual(["ok"]);
  });
});

describe("notify", () => {
  test("the AppleScript is a constant; the text travels as argv after --", () => {
    const hostile = { ref: "OpenThinkAi/a-reading#1", sender: 'x" & (do shell script "id") & "', title: "-e evil\nline" };
    const args = osascriptArgs(hostile);
    const dashes = args.indexOf("--");
    const script = args.slice(0, dashes).join("\n");
    expect(script).not.toContain("shell script");
    expect(script).not.toContain("evil");
    expect(args.slice(dashes + 1)).toEqual([notificationBody(hostile), NOTIFICATION_TITLE]);
    expect(notificationBody(hostile)).not.toContain("\n");
  });

  test("safeText strips control characters, falls back, and truncates", () => {
    expect(safeText("a\u0000b\nc", "x")).toBe("a b c");
    expect(safeText("   ", "fallback")).toBe("fallback");
    expect(safeText(undefined, "fallback")).toBe("fallback");
    expect(safeText("y".repeat(200), "x", 10)).toHaveLength(10);
  });
});
