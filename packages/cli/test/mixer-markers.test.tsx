import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { parseCliArgs, runMixerView } from "../src/cli";
import { createNotesHost, notesPath, punchListPath } from "../src/mixer-notes-host";
import { placeClips } from "../views/mixer-logic";
import { MarkersPanel } from "../views/mixer-markers";
import type { MarkersApi } from "../views/mixer-markers";
import { CATEGORIES, KEY_CATEGORY, flagDraft, playingSummary, mmss, newMarker, nextMarkerId, punchList, removeMarker, soundingAt, stepMarker, upsertMarker } from "../views/mixer-notes";
import type { Marker } from "../views/mixer-notes";
import type { MixDocument } from "../views/mixer-protocol";

/**
 * AGT-1792: mixer markers. The state model (what is sounding at a marker, ordering, the punch list, flags) is
 * pure and checked without a browser; the host half over a temp work directory (notes.json, punch-list.md,
 * flags.json) and the `--export-notes` path; the panel as static markup.
 */
const G = JSON.parse(readFileSync(join(import.meta.dir, "../../casting/tests/fixtures/mix-anchors-golden.json"), "utf8"));
const DOC = G.document as MixDocument;
const KEY = (n: number): string => n.toString(16).padStart(64, "0");
const placed = placeClips(DOC).placed;
const MANIFEST = {
  lines: [
    { i: 0, speaker: "KEEPER", text: "Who keeps the lamp tonight?", take: KEY(1), stretch: 1, start: 0.5, end: 1.75 },
    { i: 1, speaker: "TOLLER", text: "I do.", take: KEY(2), stretch: 1, start: 1.55, end: 2.45 },
    { i: 2, speaker: "KEEPER", text: "Then mind the stair.", take: KEY(3), stretch: 1, start: 2.6, end: 3.5 },
    { i: 3, speaker: "TOLLER", text: "I always do.", take: KEY(4), stretch: 1, start: 3.5, end: 4.5 },
  ],
  cues: [
    { index: 0, kind: "SFX" as const, desc: "a gull overhead", key: KEY(0xa0), after: 1, line: null, start: null, end: null },
    { index: 1, kind: "BED" as const, desc: "wind on the rocks", key: KEY(0xb0), after: null, line: null, start: null, end: null },
    { index: 2, kind: "MUSIC" as const, desc: "a thin sting", key: KEY(0xc0), after: null, line: null, start: null, end: null },
  ],
};
const NOW = "2026-10-11T12:00:00.000Z";

test("M at 1.6 s: the right line (the one the manifest times there) and every clip under the playhead", () => {
  const sounding = soundingAt(MANIFEST, placed, 1.6);
  const ids = sounding.map((s) => s.clip).sort();
  expect(ids).toEqual(["bed-a", "line-0", "line-1"]);
  const dialogue = sounding.filter((s) => s.kind === "LINE");
  expect(dialogue.map((s) => [s.line, s.speaker, s.text])).toEqual([
    [0, "KEEPER", "Who keeps the lamp tonight?"],
    [1, "TOLLER", "I do."],
  ]);
  const bed = sounding.find((s) => s.clip === "bed-a");
  expect(bed).toMatchObject({ track: "beds", kind: "BED", cue: 1, desc: "wind on the rocks", key: KEY(0xb0) });
});

test("a clip that holds two lines names the one sounding now; the SFX clip appears only inside its span", () => {
  const at4 = soundingAt(MANIFEST, placed, 4.0);
  expect(at4.find((s) => s.clip === "line-2")).toMatchObject({ line: 3, speaker: "TOLLER" });
  const at3 = soundingAt(MANIFEST, placed, 3.0).map((s) => s.clip);
  expect(at3).toContain("cue-0");
  expect(soundingAt(MANIFEST, placed, 3.4).map((s) => s.clip)).not.toContain("cue-0"); // ends 3.33
  expect(soundingAt(MANIFEST, placed, 3.0).map((s) => s.clip)).not.toContain("bed-a"); // ends at 3.0 exactly
  expect(soundingAt(MANIFEST, placed, 7).length).toBe(0);
});

test("newMarker takes the playhead to 10 ms, the mix version and what is sounding; ids, ordering and stepping", () => {
  const m = newMarker({ id: "m1", t: 1.6049, mixVersion: 2, manifest: MANIFEST, placed, now: NOW });
  expect([m.time, m.mix_version, m.category, m.note, m.sounding.length]).toEqual([1.6, 2, null, "", 3]);
  const later = { ...m, id: "m2", time: 4 };
  const early = { ...m, id: "m3", time: 0.5 };
  const list = [m, later, early].reduce<Marker[]>((acc, x) => upsertMarker(acc, x), []);
  expect(list.map((x) => x.id)).toEqual(["m3", "m1", "m2"]);
  expect(nextMarkerId(list)).toBe("m4");
  expect(nextMarkerId([])).toBe("m1");
  expect(upsertMarker(list, { ...m, note: "edited" }).find((x) => x.id === "m1")?.note).toBe("edited");
  expect(removeMarker(list, "m1").map((x) => x.id)).toEqual(["m3", "m2"]);
  expect(stepMarker(list, 1.6, 1)?.id).toBe("m2");
  expect(stepMarker(list, 1.6, -1)?.id).toBe("m3");
  expect(stepMarker(list, 9, 1)).toBeNull();
});

test("the punch list gives every marker mm:ss, what was playing, category and note, in time order", () => {
  const a: Marker = { ...newMarker({ id: "m1", t: 65.4, mixVersion: 2, manifest: MANIFEST, placed, now: NOW }), category: "clipped", note: "Too fast." };
  const b: Marker = { ...newMarker({ id: "m2", t: 1.6, mixVersion: 2, manifest: MANIFEST, placed, now: NOW }), category: "sound effect", note: "Wind swamps the line" };
  const md = punchList({ title: "The Lamp Room", episode: 1, episodeTitle: "The First Night", markers: [a, b], exported: "2026-10-11" });
  expect(md).toContain("# Punch list: The Lamp Room, episode 1: The First Night");
  expect(md).toContain("2 notes");
  expect(md.indexOf("## 1. 00:01 · sound effect")).toBeGreaterThan(-1);
  expect(md.indexOf("## 2. 01:05 · clipped")).toBeGreaterThan(md.indexOf("## 1."));
  expect(md).toContain("Wind swamps the line");
  expect(md).toContain('Line 0 KEEPER: "Who keeps the lamp tonight?"');
  expect(md).toContain("BED: wind on the rocks (cue 1, key 000000000000");
  expect(md).toContain("Playing: silence"); // the 65 s marker is past every clip
  expect(mmss(3599.9)).toBe("59:59");
  expect(mmss(3600)).toBe("60:00");
});

test("flagDraft: only a clipped marker with a dialogue line becomes a flag; the keys map f/s/g (m = g); the row summary names the line or the cue", () => {
  const base = newMarker({ id: "m1", t: 1.6, mixVersion: 1, manifest: MANIFEST, placed, now: NOW });
  expect(flagDraft({ ...base, category: "clipped" }, 1)).toEqual({ episode: 1, line: 0, reason: "clipped", time: 1.6 });
  expect(flagDraft({ ...base, category: "sound effect" }, 1)).toBeNull();
  expect(flagDraft({ ...base, category: "general" }, 1)).toBeNull();
  expect(flagDraft({ ...base, category: null }, 1)).toBeNull();
  expect([KEY_CATEGORY["f"], KEY_CATEGORY["s"], KEY_CATEGORY["g"], KEY_CATEGORY["m"]]).toEqual(["clipped", "sound effect", "general", "general"]);
  expect(playingSummary(base)).toBe("KEEPER: Who keeps the lamp tonight?");
  expect(playingSummary(newMarker({ id: "m9", t: 5, mixVersion: 1, manifest: MANIFEST, placed, now: NOW }))).toBe("MUSIC a thin sting");
  const sfxOnly = newMarker({ id: "m2", t: 5, mixVersion: 1, manifest: MANIFEST, placed, now: NOW });
  expect(sfxOnly.sounding.map((s) => s.kind)).toEqual(["MUSIC"]);
  expect(flagDraft(sfxOnly, 1)).toBeNull();
  expect(CATEGORIES).toEqual(["clipped", "sound effect", "general"]);
});

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function work(): string {
  const root = mkdtempSync(join(tmpdir(), "pablo-mixer-markers-test-"));
  dirs.push(root);
  const w = join(root, "novels", "lamp-room");
  mkdirSync(join(w, "outputs", "radio", "episodes"), { recursive: true });
  writeFileSync(join(w, "outputs", "radio", "episodes", "01-the-first-night.md"), "---\ntitle: The First Night\n---\n\nCAST: HOST\n");
  return w;
}
const marker = (id: string, t: number, category: Marker["category"] = null, note = ""): Marker => ({ ...newMarker({ id, t, mixVersion: 2, manifest: MANIFEST, placed, now: NOW }), category, note });
const notesHost = (w: string) => createNotesHost({ work: w, title: "The Lamp Room", now: () => new Date(NOW) });

test("notes persist across reopening: a fresh host reads what an earlier one saved; edit and delete work; the file is {schema, episode, notes}", () => {
  const w = work();
  expect(notesHost(w).listNotes({ episode: 1 }).notes).toEqual([]);
  notesHost(w).saveNote({ episode: 1, marker: marker("m1", 4, "clipped", "fast") });
  notesHost(w).saveNote({ episode: 1, marker: marker("m2", 1.6, "general", "dull") });
  const reopened = notesHost(w).listNotes({ episode: 1 });
  expect(reopened.notes.map((m) => [m.id, m.time, m.category, m.note])).toEqual([
    ["m2", 1.6, "general", "dull"],
    ["m1", 4, "clipped", "fast"],
  ]);
  const edited = notesHost(w).saveNote({ episode: 1, marker: { ...marker("m1", 4, "general", "late") } });
  expect(edited.notes.find((m) => m.id === "m1")?.note).toBe("late");
  expect(notesHost(w).deleteNote({ episode: 1, id: "m2" }).notes.map((m) => m.id)).toEqual(["m1"]);
  expect(notesHost(w).deleteNote({ episode: 1, id: "nope" }).notes).toHaveLength(1);
  const onDisk = JSON.parse(readFileSync(notesPath(w, 1), "utf8"));
  expect([onDisk.schema, onDisk.episode, onDisk.notes.length]).toEqual([1, 1, 1]);
  expect(notesPath(w, 1).endsWith(join("outputs", "radio", "casting", "renders", "ep01", "notes.json"))).toBe(true);
  expect(existsSync(`${notesPath(w, 1)}.tmp-${process.pid}`)).toBe(false); // atomic: no temp file left
});

test("bad markers and a broken notes.json are refused in plain words and change nothing", () => {
  const w = work();
  const h = notesHost(w);
  expect(() => h.saveNote({ episode: 1, marker: { ...marker("m1", 1), category: "loud" } })).toThrow("marker.category must be one of");
  expect(() => h.saveNote({ episode: 1, marker: { ...marker("m1", 1), time: -1 } })).toThrow("marker.time");
  expect(() => h.saveNote({ episode: 0, marker: marker("m1", 1) })).toThrow("episode must be");
  expect(() => h.saveNote({ episode: 1, marker: { ...marker("a/b", 1) } })).toThrow("marker.id");
  expect(existsSync(notesPath(w, 1))).toBe(false);
  mkdirSync(join(notesPath(w, 1), ".."), { recursive: true });
  writeFileSync(notesPath(w, 1), "{not json", "utf8");
  expect(() => h.saveNote({ episode: 1, marker: marker("m1", 1) })).toThrow("notes.json is not valid JSON");
  expect(readFileSync(notesPath(w, 1), "utf8")).toBe("{not json");
});

test("exportNotes writes punch-list.md beside notes.json and returns the markdown", () => {
  const w = work();
  const h = notesHost(w);
  h.saveNote({ episode: 1, marker: marker("m1", 1.6, "sound effect", "Wind swamps the line") });
  const out = h.exportNotes({ episode: 1 });
  expect(out.count).toBe(1);
  expect(out.path).toBe(punchListPath(w, 1));
  expect(readFileSync(out.path, "utf8")).toBe(out.markdown);
  expect(out.markdown).toContain("The Lamp Room, episode 1: The First Night");
  expect(out.markdown).toContain("## 1. 00:01 · sound effect");
  expect(out.markdown).toContain("exported 2026-10-11");
});

test("notesToFlags writes review-host-shaped flags for dialogue markers, skips the rest, keeps the performer's flags and one human flag per line", () => {
  const w = work();
  const h = notesHost(w);
  const flagsPath = join(w, "outputs", "radio", "casting", "flags.json");
  mkdirSync(join(flagsPath, ".."), { recursive: true });
  writeFileSync(flagsPath, JSON.stringify({ flags: [{ id: "auto-1", episode: 1, line: 3, reason: "best of 4 failed: pace", time: 4, source: "auto", by: "auto", at: "t" }, { id: "old", episode: 1, line: 0, reason: "flat", time: 1, source: "human", by: "human", at: "t" }] }), "utf8");
  h.saveNote({ episode: 1, marker: marker("m1", 1.6, "clipped") });
  h.saveNote({ episode: 1, marker: marker("m2", 5, "clipped") }); // music only
  h.saveNote({ episode: 1, marker: marker("m3", 4.0, "sound effect") }); // dialogue, but not clipped
  const out = h.notesToFlags({ episode: 1 });
  expect(out.written).toEqual(["m1"]);
  expect([...out.skipped].sort()).toEqual(["m2", "m3"]);
  const flags = JSON.parse(readFileSync(flagsPath, "utf8")).flags as Record<string, unknown>[];
  expect(flags.find((f) => f["id"] === "auto-1")).toBeDefined(); // the performer's stays
  expect(flags.find((f) => f["id"] === "old")).toBeUndefined(); // replaced: one listener flag per line
  const fresh = flags.filter((f) => f["by"] === "human");
  expect(fresh.map((f) => [f["episode"], f["line"], f["reason"], f["time"], f["source"], f["by"], f["at"]]).sort()).toEqual([
    [1, 0, "clipped", 1.6, "human", "human", NOW],
  ]);
  expect(String(fresh[0]?.["id"])).toMatch(/^f-20261011-120000-ep01-\d+$/);
  // a named subset
  expect(h.notesToFlags({ episode: 1, ids: ["m2"] })).toMatchObject({ written: [], skipped: ["m2"] });
});

test("pablo mixer --export-notes writes the punch list with no window, no Chrome and no mix document", async () => {
  const w = work();
  notesHost(w).saveNote({ episode: 1, marker: marker("m1", 1.6, "general", "dull") });
  const opened: unknown[] = [];
  const open = (async (r: unknown) => {
    opened.push(r);
    return { ok: false, code: 1, message: "should not open" };
  }) as never;
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    expect(await runMixerView(parseCliArgs(["mixer", "--project", "x", "--episode", "1", "--export-notes"]), w, w, open)).toBe(0);
  } finally {
    console.log = log;
  }
  expect(opened).toHaveLength(0);
  expect(existsSync(punchListPath(w, 1))).toBe(true);
  expect(lines.join("\n")).toContain("wrote the punch list for episode 1 (1 note)");
});

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

const api = (notes: readonly Marker[], draft: MarkersApi["draft"] = null): MarkersApi => ({ notes, draft, status: null, failed: false, exported: null, begin() {}, commit() {}, cancel() {}, save() {}, remove() {}, exportList() {}, toFlags() {} });

test("the panel lists each marker with its time, category, what is playing and note, and says how to start when empty", () => {
  const empty = renderToStaticMarkup(<MarkersPanel api={api([])} onJump={() => {}} />);
  expect(empty).toContain("f = clipped, s = sound effect, g = general");
  const html = renderToStaticMarkup(<MarkersPanel api={api([marker("m1", 1.6, "general", "dull")])} onJump={() => {}} />);
  expect(html).toContain("Markers (1)");
  expect(html).toContain(">00:01<");
  expect(html).toContain("dull");
  expect(html).toContain("Who keeps the lamp tonight?");
  expect(html).not.toContain(">to flag<"); // general, not clipped
  expect(html).toContain("Export");
});

test("a marker being typed shows as a row with one text field and no dropdown; saved rows read mm:ss [F] what-was-playing — note", () => {
  const saved = marker("m1", 1.6, "clipped", "cut off");
  const typing = { marker: newMarker({ id: "m2", t: 4, mixVersion: 2, manifest: MANIFEST, placed, now: NOW, category: "sound effect" }), wasPlaying: true };
  const html = renderToStaticMarkup(<MarkersPanel api={api([saved], typing)} onJump={() => {}} />);
  expect(html.match(/<input/g)).toHaveLength(1);
  expect(html).not.toContain("<select");
  expect(html).not.toContain("<textarea");
  expect(html).toContain("[F]");
  expect(html).toContain("[S]");
  expect(html).toContain("KEEPER: Who keeps the lamp tonight?");
  expect(html).toContain("cut off");
  expect(html).toContain(">to flag<");
});
