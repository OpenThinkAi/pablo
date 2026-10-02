// Reads the file behind a rail row from the project (the one place the main pane touches the disk): the loader the
// app is given. A file that is not there yet is a notice in the pane, not an error ("chapter 3 has no draft yet").

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { sourceOf, stripFrontmatter, type MainDoc } from "./document";

const read = (path: string): string | undefined => {
  try { return statSync(path).isFile() ? readFileSync(path, "utf8") : undefined; } catch { return undefined; }
};

/** The `.md` files under `dir`, sorted, as paths relative to `root`. */
const markdownUnder = (root: string, dir: string): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? markdownUnder(root, join(dir, e.name)) : e.name.endsWith(".md") ? [relative(root, join(dir, e.name))] : []));
};

/** The document the row `id` names in the project at `root`, or undefined for an id that names nothing readable. */
export function loadDocument(root: string, id: string): MainDoc | undefined {
  const source = sourceOf(id);
  switch (source.kind) {
    case "chapter": {
      const dir = join(root, "chapters");
      const file = existsSync(dir) ? readdirSync(dir).sort().find((f) => f.endsWith(".md") && Number.parseInt(f, 10) === source.number) : undefined;
      if (!file) return { title: `chapter ${source.number}`, text: `Chapter ${source.number} has no draft yet.` };
      const text = read(join(dir, file)) ?? "";
      const status = /^---\r?\n(?:[^\n]*\r?\n)*?status:[ \t]*([^\r\n]+)/.exec(text)?.[1]?.trim();
      return { title: `chapters/${file}${status ? ` · ${status}` : ""}`, text, file: `chapters/${file}`, editable: `chapters/${file}` };
    }
    case "file": {
      const file = source.file;
      const text = read(join(root, file));
      return { title: file, text: text ?? `${file} does not exist yet.`, ...(text === undefined ? {} : { editable: file }) };
    }
    case "bible": {
      const files = markdownUnder(root, join(root, "bible"));
      if (files.length === 0) return { title: "bible", text: "The bible has no files yet." };
      return { title: "bible", text: files.map((f) => `# ${f}\n\n${stripFrontmatter(read(join(root, f)) ?? "")}`).join("\n\n") };
    }
    case "path": {
      // Only a file inside the project: an id is never a way out of it.
      const path = resolve(root, source.path);
      if (path !== resolve(root) && !path.startsWith(resolve(root) + sep)) return undefined;
      const text = read(path);
      return text === undefined ? undefined : { title: source.path, text, editable: relative(resolve(root), path) };
    }
  }
}
