// The settings screen, drawn full-screen over the book or review: a header with the config file's path, the fields by
// section (the cursor's field lit, a changed one marked *), and at the bottom the field's description, what the last
// key did, and the keys the screen takes now. The state is the model's (state.ts) and every rule is settings.ts; this
// only draws them, and holds nothing. Copied from prview's settings-view.tsx and adapted.

import { homedir } from "node:os";
import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { panelOf, type Entry } from "./panel";
import { changed, describeField, sectionOf } from "./settings";
import type { SettingsModel } from "./state";

const entry = (prim: string, label: string, sec = ""): Entry => ({ keys: [prim, sec].filter(Boolean).join(" "), prim, sec, label });

/** The key panel's entries: the screen's keys, or what a capture, the editor line or the way-out question takes. */
export function settingsEntries(s: SettingsModel): Entry[] {
  switch (s.sub?.kind) {
    case "capture": return [entry("any key", "bind it"), ...(s.slot === "secondary" ? [entry("Backspace", "clear")] : []), entry("Esc", "cancel")];
    case "typing": return [entry("Enter", "set"), entry("ctrl-u", "clear line"), entry("Esc", "cancel")];
    case "confirm": return [entry("y", "save"), entry("n", "discard"), entry("Esc", "keep editing")];
    default: return [entry("↓/↑", "field", "j/k"), entry("←/→", "primary / secondary", "h/l"), entry("Enter", "rebind / edit"), entry("Backspace", "clear 2nd"), entry("Esc", "save and leave")];
  }
}

export interface SettingsScreenProps { readonly s: SettingsModel; readonly cols: number; readonly rows: number }

/** A path with the home directory as `~`, so the config file fits the header. */
const tilde = (p: string): string => { const h = homedir(); return p === h || p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p; };

const HEADER_H = 4, BOTTOM_H = 7;

export function SettingsScreen({ s, cols, rows }: SettingsScreenProps) {
  const listH = Math.max(1, rows - HEADER_H - BOTTOM_H);
  // The list: a section title before the first field of each section, then the fields; scrolled to keep the cursor in view.
  const list: ({ title: string } | { at: number })[] = [];
  s.fields.forEach((f, at) => {
    const title = sectionOf(f);
    if (at === 0 || sectionOf(s.fields[at - 1]!) !== title) list.push({ title });
    list.push({ at });
  });
  const cur = list.findIndex((r) => "at" in r && r.at === s.cursor);
  const top = Math.max(0, Math.min(cur - Math.floor(listH / 2), list.length - listH));
  const shownRows = list.slice(top, top + listH);
  const idW = Math.max(...s.fields.map((f) => describeField(s, f).label.length));
  const n = changed(s.initial, s.values).length;

  const fieldRow = (at: number): ReactNode => {
    const f = s.fields[at]!, d = describeField(s, f), here = at === s.cursor;
    const mark = <Text color="yellow">{d.changed ? "*" : " "}</Text>;
    const name = <Text color={here ? "cyan" : undefined} bold={here} dimColor={d.fixed && !here}>{d.label.padEnd(idW)}</Text>;
    if (f.kind === "key") {
      const cell = (text: string, slot: "primary" | "secondary") => <Text inverse={here && s.slot === slot && !d.fixed} dimColor={d.fixed}>{` ${text} `.padEnd(12)}</Text>;
      return <Text key={`f${at}`} wrap="truncate">{mark}{name} <Text dimColor>{(d.states ?? "").padEnd(18)}</Text>{cell(d.primary!, "primary")} {cell(d.secondary!, "secondary")} <Text dimColor>{d.fixed ? "(fixed) " : ""}{d.description}</Text></Text>;
    }
    return <Text key={`f${at}`} wrap="truncate">{mark}{name} <Text inverse={here}>{` ${d.value} `}</Text></Text>;
  };

  const f = s.fields[s.cursor]!, d = describeField(s, f);
  const detail: ReactNode[] = [];
  if (s.sub?.kind === "capture") detail.push(<Text key="c" color="cyan" wrap="truncate">Press the new {s.slot} key for {d.label}. Esc cancels; Esc and Tab cannot be bound.</Text>);
  else if (s.sub?.kind === "typing") detail.push(<Text key="t" wrap="truncate"><Text color="cyan" bold>editor › </Text>{s.sub.text}<Text inverse> </Text></Text>);
  else if (s.sub?.kind === "confirm") detail.push(<Text key="q" color="yellow" bold wrap="truncate">Save changes? y / n / Esc to keep editing</Text>, <Text key="w" dimColor wrap="truncate">y writes {n} setting{n === 1 ? "" : "s"} to {tilde(s.path)}; the rest of the file is kept.</Text>);
  if (s.message) detail.push(<Text key="m" color={s.message.error ? "red" : "green"} wrap="truncate">{s.message.text}</Text>);
  const panelW = Math.min(Math.max(30, Math.floor(cols / 3)), cols - 20), contentW = cols - panelW;
  const panel = panelOf("settings", settingsEntries(s), panelW, BOTTOM_H);

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box flexDirection="column" borderStyle="single" paddingX={1} width={cols} height={HEADER_H}>
        <Text wrap="truncate"><Text bold>Settings</Text>{n ? <Text color="yellow">{`  ${n} unsaved change${n === 1 ? "" : "s"}`}</Text> : null}</Text>
        <Text wrap="truncate"><Text dimColor>saved to </Text>{tilde(s.path)}</Text>
      </Box>
      <Box height={listH} flexDirection="column" paddingX={1} overflow="hidden">
        {shownRows.map((r, i) => ("title" in r ? <Text key={`s${top + i}`} bold color="magenta" wrap="truncate">{r.title}</Text> : fieldRow(r.at)))}
      </Box>
      <Box height={BOTTOM_H}>
        <Box flexDirection="column" width={contentW} height={BOTTOM_H} overflow="hidden" borderStyle="single" borderColor={s.sub ? "cyan" : "gray"} paddingX={1}>
          <Text bold wrap="truncate">{sectionOf(f)} · {d.label}</Text>
          <Text dimColor wrap="truncate">{d.description}</Text>
          {detail}
        </Box>
        <Box flexDirection="column" width={panelW} height={BOTTOM_H} overflow="hidden" borderStyle="single" paddingX={1}>
          <Text bold wrap="truncate">{panel.title}</Text>
          {panel.lines.map((l, i) => <Text key={i} wrap="truncate">{l.map((sg, j) => <Text key={j} dimColor={sg.dim}>{sg.text}</Text>)}</Text>)}
        </Box>
      </Box>
    </Box>
  );
}
