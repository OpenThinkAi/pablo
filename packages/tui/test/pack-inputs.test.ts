import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemblePack } from "@openthink/pablo-core";
import { findVaultRoot } from "../src/brief";
import { buildSpanEditInputs } from "../src/pack-inputs";

/**
 * Finding the vault around a file, and what the pack carries as a result (AC7).
 * No fixture reaches `~/writing`: every vault here is built in a temp directory
 * with the same shape.
 */

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop() ?? "", { recursive: true, force: true });
});

const CHAPTER = "# Twenty-Six\n\nThe cellar was cold.\n\nShe counted the barrels twice.\n";

/** `<vault>/style/*.md`, `<vault>/novels/valleys-shadow/{QWEN.md,chapters/}`. */
function vault(options: { style?: Record<string, string>; workRules?: string } = {}): {
  root: string;
  chapter: string;
} {
  const root = mkdtempSync(join(tmpdir(), "pablo-vault-"));
  directories.push(root);

  const style = options.style ?? { "prose.md": "Straight quotes, never curly.", "anti-tells.md": "No tricolons." };
  mkdirSync(join(root, "style"), { recursive: true });
  for (const [name, text] of Object.entries(style)) writeFileSync(join(root, "style", name), text, "utf8");

  const work = join(root, "novels", "valleys-shadow");
  mkdirSync(join(work, "chapters"), { recursive: true });
  if (options.workRules !== undefined) writeFileSync(join(work, "QWEN.md"), options.workRules, "utf8");

  const chapter = join(work, "chapters", "26-the-cellar.md");
  writeFileSync(chapter, CHAPTER, "utf8");
  return { root, chapter };
}

function inputsFor(path: string, extraContext?: string) {
  return buildSpanEditInputs({
    doc: { path, text: CHAPTER },
    span: { start: CHAPTER.indexOf("The cellar"), end: CHAPTER.indexOf("The cellar") + 20 },
    instruction: "cut this by a third",
    extraContext,
  });
}

test("the vault is the nearest ancestor with a style/ directory", () => {
  // The same `findVaultRoot` the brief uses: one definition of a vault, and one
  // of a work, shared by the brief and the pack.
  const { root, chapter } = vault();
  expect(findVaultRoot(chapter)).toBe(root);
  expect(inputsFor(chapter).vaultRoot).toBe(root);
});

test("a file with no vault above it has no vault root", () => {
  const loose = mkdtempSync(join(tmpdir(), "pablo-loose-"));
  directories.push(loose);
  const path = join(loose, "notes.md");
  writeFileSync(path, CHAPTER, "utf8");

  const built = buildSpanEditInputs({ doc: { path, text: CHAPTER }, span: { start: 0, end: 4 }, instruction: "x" });
  expect(built.vaultRoot).toBeUndefined();
  expect(built.notices.join(" ")).toContain("no vault above this file");
  expect(built.inputs.style).toEqual([]);

  // It still assembles: a file outside a vault is prompted on with a smaller
  // pack, never refused.
  expect(assemblePack("spanEdit", built.inputs).prompt).toContain("# The passage");
});

test("the style files land in the pack, sorted, with their vault-relative paths (AC7)", () => {
  const { chapter } = vault();
  const built = inputsFor(chapter);

  expect(built.inputs.style.map((source) => source.path)).toEqual([
    "style/anti-tells.md",
    "style/prose.md",
  ]);
  expect(assemblePack("spanEdit", built.inputs).prompt).toContain("Straight quotes, never curly.");
});

test("the work's own rules file is read when it is there, and skipped when it is not (AC7)", () => {
  const withRules = vault({ workRules: "# The Valley's Shadow\n\nNo anachronisms after 1919.\n" });
  const built = inputsFor(withRules.chapter);

  expect(built.workRoot).toBe(join(withRules.root, "novels", "valleys-shadow"));
  expect(built.inputs.workRules?.text).toContain("No anachronisms");
  expect(assemblePack("spanEdit", built.inputs).prompt).toContain("Rules for this work");

  // The work still exists without a rules file; it is the rules that are absent.
  const without = vault();
  const bare = inputsFor(without.chapter);
  expect(bare.workRoot).toBe(join(without.root, "novels", "valleys-shadow"));
  expect(bare.inputs.workRules).toBeUndefined();
});

test("a vault whose own QWEN.md sits at the root is not mistaken for a work", () => {
  // A work is `<vault>/<kind>/<slug>`, so the root can never be one and the
  // vault's own rules file is not a work's rules file.
  const { root, chapter } = vault();
  writeFileSync(join(root, "QWEN.md"), "vault-wide rules", "utf8");
  expect(inputsFor(chapter).workRoot).toBe(join(root, "novels", "valleys-shadow"));
  expect(inputsFor(chapter).inputs.workRules).toBeUndefined();
});

test("a vault with an empty style/ says so rather than sending nothing quietly", () => {
  const { chapter } = vault({ style: {} });
  const built = inputsFor(chapter);
  expect(built.inputs.style).toEqual([]);
  expect(built.notices.join(" ")).toContain("no style rules");
});

test("extraContext is the AGT-1207 seam: it lands after the style files", () => {
  const { chapter } = vault();
  const built = inputsFor(chapter, "Brief: Act I has to put Nora in the cellar alone.");

  expect(built.inputs.style.map((source) => source.path)).toEqual([
    "style/anti-tells.md",
    "style/prose.md",
    "the session brief",
  ]);

  const prompt = assemblePack("spanEdit", built.inputs).prompt;
  expect(prompt.indexOf("Straight quotes")).toBeLessThan(prompt.indexOf("Nora in the cellar"));
  expect(prompt.indexOf("Nora in the cellar")).toBeLessThan(prompt.indexOf("# The passage"));

  // Blank extra context adds nothing at all.
  expect(inputsFor(chapter, "   ").inputs.style).toHaveLength(2);
});
