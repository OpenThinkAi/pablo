/**
 * The mixer's marker store (AGT-1792): `renders/epNN/notes.json` (the listener's notes, kept apart from the mix
 * document), the punch list written beside it (`punch-list.md`), and "to flags" (dialogue markers become
 * `flags.json` entries of the shape the review player writes, which `pablo fix` reads).
 *
 * Every write is atomic (temp file in the same directory, then rename). A notes file that is not valid is
 * never overwritten: the call is refused in plain words and nothing changes.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATEGORIES, flagDraft, isCategory, punchList, removeMarker, roundTime, upsertMarker } from "../views/mixer-notes";
import type { Marker, NotesFile, Sounding } from "../views/mixer-notes";
import type { ExportPayload, NotesPayload, ToFlagsPayload } from "../views/mixer-protocol";
import { castingDir, episodeDir, episodeTitle, flagsFile, readFlagsFile, writeFlagsFile } from "./review-host";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const KINDS = ["LINE", "SFX", "BED", "MUSIC"];
const TRACKS = ["dialogue", "sfx", "beds", "music"];

export interface NotesHost {
  listNotes(args: unknown): NotesPayload;
  saveNote(args: unknown): NotesPayload;
  deleteNote(args: unknown): NotesPayload;
  exportNotes(args: unknown): ExportPayload;
  notesToFlags(args: unknown): ToFlagsPayload;
}

function episodeArg(args: unknown): number {
  const value = isRecord(args) ? args["episode"] : undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error("episode must be a whole number of 1 or more");
  return value;
}

const text = (value: unknown, what: string, max: number): string => {
  if (typeof value !== "string") throw new Error(`${what} must be text`);
  if (value.length > max) throw new Error(`${what} is too long (${max} characters at most)`);
  return value;
};

function soundingRow(raw: unknown): Sounding {
  if (!isRecord(raw)) throw new Error("each sounding entry must be an object");
  const { track, clip, kind, line, speaker, text: lineText, cue, desc, key } = raw;
  if (typeof track !== "string" || !TRACKS.includes(track)) throw new Error("sounding.track must be dialogue, sfx, beds or music");
  if (typeof kind !== "string" || !KINDS.includes(kind)) throw new Error("sounding.kind must be LINE, SFX, BED or MUSIC");
  const num = (v: unknown, what: string): number => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error(`${what} must be a whole number of 0 or more`);
    return v;
  };
  return {
    track: track as Sounding["track"],
    clip: text(clip, "sounding.clip", 200),
    kind: kind as Sounding["kind"],
    ...(line === undefined ? {} : { line: num(line, "sounding.line") }),
    ...(speaker === undefined ? {} : { speaker: text(speaker, "sounding.speaker", 200) }),
    ...(lineText === undefined ? {} : { text: text(lineText, "sounding.text", 2000) }),
    ...(cue === undefined ? {} : { cue: num(cue, "sounding.cue") }),
    ...(desc === undefined ? {} : { desc: text(desc, "sounding.desc", 1000) }),
    ...(key === undefined ? {} : { key: text(key, "sounding.key", 200) }),
  };
}

/** A marker as the view sends it, checked field by field (a stored marker is checked the same way on read). */
export function markerFrom(raw: unknown): Marker {
  if (!isRecord(raw)) throw new Error("marker must be an object");
  const id = text(raw["id"], "marker.id", 40);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("marker.id may hold letters, digits, - and _ only");
  const time = raw["time"];
  if (typeof time !== "number" || !Number.isFinite(time) || time < 0) throw new Error("marker.time must be a number of seconds, 0 or more");
  const version = raw["mix_version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) throw new Error("marker.mix_version must be a whole number of 1 or more");
  const category = raw["category"] ?? null;
  if (category !== null && !isCategory(category)) throw new Error(`marker.category must be one of: ${CATEGORIES.join(", ")} (or none)`);
  const sounding = raw["sounding"] ?? [];
  if (!Array.isArray(sounding)) throw new Error("marker.sounding must be a list");
  return {
    id,
    time: roundTime(time),
    mix_version: version,
    sounding: sounding.map(soundingRow),
    category,
    note: text(raw["note"] ?? "", "marker.note", 5000),
    created: text(raw["created"], "marker.created", 40),
    updated: text(raw["updated"], "marker.updated", 40),
  };
}

export function notesPath(work: string, episode: number): string {
  return join(episodeDir(work, episode), "notes.json");
}

export function punchListPath(work: string, episode: number): string {
  return join(episodeDir(work, episode), "punch-list.md");
}

function writeAtomic(path: string, body: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, path);
}

export function readNotes(work: string, episode: number): Marker[] {
  const path = notesPath(work, episode);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`notes.json is not valid JSON (${path}); nothing was changed. Fix or move it, then try again.`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["notes"])) throw new Error(`notes.json must hold {"notes": [...]} (${path}); nothing was changed.`);
  return upsertAll(parsed["notes"].map(markerFrom));
}

const upsertAll = (markers: readonly Marker[]): Marker[] => markers.reduce<Marker[]>((acc, m) => upsertMarker(acc, m), []);

function writeNotes(work: string, episode: number, notes: readonly Marker[]): void {
  const file: NotesFile = { schema: 1, episode, notes };
  writeAtomic(notesPath(work, episode), `${JSON.stringify(file, null, 2)}\n`);
}

export interface NotesHostOptions {
  readonly work: string;
  /** The work's title, for the punch list's heading. */
  readonly title: string;
  readonly now?: () => Date;
}

export function createNotesHost(options: NotesHostOptions): NotesHost {
  const { work } = options;
  const now = options.now ?? (() => new Date());

  return {
    listNotes(args) {
      const episode = episodeArg(args);
      return { episode, notes: readNotes(work, episode) };
    },

    saveNote(args) {
      const episode = episodeArg(args);
      const marker = markerFrom(isRecord(args) ? args["marker"] : undefined);
      const notes = upsertMarker(readNotes(work, episode), marker);
      writeNotes(work, episode, notes);
      return { episode, notes };
    },

    deleteNote(args) {
      const episode = episodeArg(args);
      const id = text(isRecord(args) ? args["id"] : undefined, "id", 40);
      const before = readNotes(work, episode);
      const notes = removeMarker(before, id);
      if (notes.length !== before.length) writeNotes(work, episode, notes);
      return { episode, notes };
    },

    exportNotes(args) {
      const episode = episodeArg(args);
      const notes = readNotes(work, episode);
      const markdown = punchList({ title: options.title, episode, episodeTitle: episodeTitle(work, episode), markers: notes, exported: now().toISOString().slice(0, 10) });
      const path = punchListPath(work, episode);
      writeAtomic(path, markdown);
      return { episode, count: notes.length, path, markdown };
    },

    notesToFlags(args) {
      const episode = episodeArg(args);
      const idsArg = isRecord(args) ? args["ids"] : undefined;
      if (idsArg !== undefined && (!Array.isArray(idsArg) || idsArg.some((i) => typeof i !== "string"))) throw new Error("ids must be a list of marker ids");
      const wanted = idsArg === undefined ? undefined : new Set(idsArg as string[]);
      const notes = readNotes(work, episode).filter((m) => wanted === undefined || wanted.has(m.id));
      const written: string[] = [];
      const skipped: string[] = [];
      const file = readFlagsFile(work);
      let flags = [...file.flags];
      const stamp = now().toISOString();
      for (const m of notes) {
        const draft = flagDraft(m, episode);
        if (draft === null) {
          skipped.push(m.id);
          continue;
        }
        const id = `f-${stamp.replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-")}-ep${String(episode).padStart(2, "0")}-${draft.line}`;
        // One listener flag per line, as the review player keeps it: flagging it again updates reason and time. The performer's stays.
        flags = flags.filter((f) => !(f["episode"] === episode && f["line"] === draft.line && f["source"] !== "auto" && f["by"] !== "auto"));
        flags.push({ id, episode, line: draft.line, reason: draft.reason, time: draft.time, source: "human", by: "human", at: stamp });
        written.push(m.id);
      }
      if (written.length > 0) {
        mkdirSync(castingDir(work), { recursive: true });
        writeFlagsFile(work, file, flags);
      }
      return { episode, written, skipped, path: flagsFile(work) };
    },
  };
}
