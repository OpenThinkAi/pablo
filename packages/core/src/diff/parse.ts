// git's unified diff, parsed into files, hunks and lines numbered on both sides.
// Adapted from prview's diff.ts. Pure: text in, data out.

export type DiffLine = { t: " " | "+" | "-"; text: string; o: number | null; n: number | null };
export type Hunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  context: string;
  lines: DiffLine[];
};
export type FileDiff = {
  path: string;
  oldPath?: string;
  status: "added" | "deleted" | "renamed" | "modified";
  binary: boolean;
  hunks: Hunk[];
};

const unquote = (p: string) => (p.startsWith('"') ? (JSON.parse(p) as string) : p);

export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let f: FileDiff | undefined;
  let h: Hunk | undefined;
  let o = 0;
  let n = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/);
      f = { path: m?.[2] ?? line, status: "modified", binary: false, hunks: [] };
      files.push(f);
      h = undefined;
      continue;
    }
    if (!f) continue;
    if (h && /^[ +\-\\]/.test(line)) {
      // Inside a hunk every line starts with one of these.
      if (line[0] === "\\") continue; // "\ No newline at end of file"
      const t = line[0] as DiffLine["t"];
      h.lines.push({ t, text: line.slice(1), o: t === "+" ? null : o++, n: t === "-" ? null : n++ });
      continue;
    }
    const hm = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
    if (hm) {
      h = {
        oldStart: Number(hm[1]),
        oldCount: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: Number(hm[3]),
        newCount: hm[4] === undefined ? 1 : Number(hm[4]),
        context: hm[5] ?? "",
        lines: [],
      };
      f.hunks.push(h);
      o = h.oldStart;
      n = h.newStart;
    } else if (line.startsWith("new file mode")) f.status = "added";
    else if (line.startsWith("deleted file mode")) f.status = "deleted";
    else if (line.startsWith("rename from ")) {
      f.status = "renamed";
      f.oldPath = unquote(line.slice(12));
    } else if (line.startsWith("rename to ")) f.path = unquote(line.slice(10));
    else if (line.startsWith("Binary files ")) f.binary = true;
  }
  return files;
}

/** Added and removed line counts for a file. */
export function countLines(f: FileDiff): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of f.hunks)
    for (const l of h.lines) {
      if (l.t === "+") added++;
      else if (l.t === "-") removed++;
    }
  return { added, removed };
}
