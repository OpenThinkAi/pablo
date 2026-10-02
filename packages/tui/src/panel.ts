// The key panel's shape: which entries a state lists, and how they lay out in the room there is. Pure, so a narrow
// terminal and a short one are tested without drawing anything. The entries come from the action rows in keys.ts
// (through `rowsOf`), never from a list of their own, so the panel always lists the keys that act in the current state.
// Copied from prview's panel.ts and adapted.
//
// The layout (AGT-1525) places the panel, at a width and height it chooses. It lays its entries out as a grid of as few
// columns as fit that height; when the grid is too wide it drops the secondary keys (the primaries still name every
// action), and when even that is too wide it flows the entries along the rows.

import { groups, keyStateOf, prefixesOf, prefixRows, rowsOf, showKey, isPrefix, PREFIXES, DEFAULT_KEYMAP, type KeyAction, type KeyState, type Keymap } from "./keys";
import type { Pending, State } from "./state";

/** `keys` is how a listing reads (`↓/↑ j/k`); `prim` and `sec` are its two halves, the secondary drawn dim. */
export interface Entry { readonly keys: string; readonly prim: string; readonly sec: string; readonly label: string }

const entry = (prim: string, sec: string, label: string): Entry => ({ keys: [prim, sec].filter(Boolean).join(" "), prim, sec, label });

/** A group's keys: the primaries, then the secondaries: `↓/↑ j/k`. */
const keysOfGroup = (g: KeyAction[]): Entry => {
  const prim = g.map((r) => (r.key ? showKey(r.key) : "")).filter(Boolean), sec = g.map((r) => (r.secondary ? showKey(r.secondary) : "")).filter(Boolean);
  return entry(prim.join("/"), sec.join("/"), g[0]!.label);
};

/**
 * What a state lists, in table order; rows with the same label share an entry (↓/↑ j/k row), then one entry per prefix
 * (`g go to…`). While a prefix is pending, its second keys instead; while a number is typed after g, how to finish it.
 */
export function entriesOf(ks: KeyState, pending: Pending | null = null, km: Keymap = DEFAULT_KEYMAP): Entry[] {
  if (pending?.digits !== undefined) return [entry("0-9", "", "line number"), entry(pending.prefix, "Enter", "go"), entry("Esc", "", "cancel")];
  if (pending && isPrefix(pending.prefix)) return groups(prefixRows(ks, pending.prefix, km)).map((g) => (g[0]!.id === "go.line" ? entry("0-9", "", g[0]!.label) : keysOfGroup(g)));
  return [...groups(rowsOf(ks, km)).map(keysOfGroup), ...prefixesOf(ks, km).map((p) => entry(p, "", `${PREFIXES[p]}…`))];
}

/** The panel's entries for the screen's state, with its pending prefix: what the layout draws. */
export const entriesFor = (s: State, km: Keymap = DEFAULT_KEYMAP): Entry[] => entriesOf(keyStateOf(s), s.pending, km);

/** The panel's title: the pending prefix and its meaning, else where the keys act. */
export function panelTitle(ks: KeyState, pending: Pending | null = null): string {
  if (pending) return isPrefix(pending.prefix) ? `${pending.prefix} ${PREFIXES[pending.prefix]}` : pending.prefix;
  return ks.state === "rail" ? (ks.review ? "changes" : "contents") : ks.state === "main" ? "keys" : "content";
}

/** A run of text in a panel line; `dim` for a secondary key. */
export interface Seg { readonly text: string; readonly dim?: boolean }
/**
 * The panel's lines inside its border, `width` by `height` with border and title. `fit` says how the entries were
 * laid out: `grid` in full, `primaries` a grid without the secondary keys, `flow` along the rows (cut with `…` if even
 * that does not fit).
 */
export interface PanelShape { readonly title: string; readonly lines: Seg[][]; readonly width: number; readonly height: number; readonly fit: "grid" | "primaries" | "flow" }

/** A panel line as plain text, as it reads on the screen. */
export const plain = (line: readonly Seg[]): string => line.map((s) => s.text).join("");
const len = (s: string) => [...s].length;
const pad = (n: number): Seg[] => (n > 0 ? [{ text: " ".repeat(n) }] : []);
const COL_GAP = 2;

export function panelOf(title: string, entries: readonly Entry[], width: number, height: number): PanelShape {
  const inner = Math.max(1, height - 3), innerW = Math.max(1, width - 4); // border twice and the title; border and padding each side
  const shape = (lines: Seg[][], fit: PanelShape["fit"]): PanelShape => ({ title, lines, width, height, fit });
  if (!entries.length) return shape([], "grid");
  for (const withSec of [true, false]) {
    const keysW = (e: Entry) => len(e.prim) + (withSec && e.sec ? 1 + len(e.sec) : 0);
    const per = Math.max(1, Math.min(inner, entries.length)), n = Math.ceil(entries.length / per);
    const cols = Array.from({ length: n }, (_, c) => entries.slice(c * per, (c + 1) * per));
    const keyWs = cols.map((c) => Math.max(...c.map(keysW)));
    const ws = cols.map((c, i) => Math.max(...c.map((e) => keyWs[i]! + 2 + len(e.label))));
    if (ws.reduce((a, b) => a + b, 0) + COL_GAP * (n - 1) > innerW) continue;
    const lines = Array.from({ length: per }, (_, r) => cols.flatMap((c, i): Seg[] => {
      const e = c[r];
      if (!e) return [];
      const last = i === n - 1 || !cols[i + 1]![r];
      return [
        ...(i ? pad(COL_GAP) : []),
        { text: e.prim }, ...(withSec && e.sec ? [{ text: ` ${e.sec}`, dim: true }] : []),
        ...pad(keyWs[i]! - keysW(e) + 2), { text: e.label },
        ...(last ? [] : pad(ws[i]! - keyWs[i]! - 2 - len(e.label))),
      ];
    }));
    return shape(lines.filter((l) => l.length), withSec ? "grid" : "primaries");
  }
  // Flow: `keys label` units along each row, two spaces apart, with the secondaries (dim) when they all fit whole, else
  // without; what does not fit even then ends in `…`.
  let cut = false;
  const flow = (withSec: boolean): Seg[][][] => {
    const units = entries.map((e): Seg[] => {
      const segs: Seg[] = [{ text: e.prim }, ...(withSec && e.sec ? [{ text: ` ${e.sec}`, dim: true }] : []), { text: ` ${e.label}` }];
      const t = plain(segs);
      if (len(t) <= innerW) return segs;
      cut = true;
      return [{ text: [...t].slice(0, Math.max(1, innerW - 1)).join("") + "…" }];
    });
    const rows: Seg[][][] = [[]];
    for (const u of units) {
      const row = rows[rows.length - 1]!;
      if (row.length && rowW(row) + COL_GAP + len(plain(u)) > innerW) rows.push([u]); else row.push(u);
    }
    return rows;
  };
  const rowW = (row: Seg[][]) => row.reduce((a, u) => a + len(plain(u)), 0) + COL_GAP * Math.max(0, row.length - 1);
  const joined = (row: Seg[][]): Seg[] => row.flatMap((u, i) => (i ? [...pad(COL_GAP), ...u] : u));
  const full = flow(true);
  if (full.length <= inner && !cut) return shape(full.map(joined), "flow");
  const rows = flow(false);
  if (rows.length > inner) {
    const kept = rows.slice(0, inner), last = kept[kept.length - 1]!;
    while (last.length > 1 && rowW(last) + COL_GAP + 1 > innerW) last.pop();
    last.push([{ text: "…" }]);
    return shape(kept.map(joined), "flow");
  }
  return shape(rows.map(joined), "flow");
}
