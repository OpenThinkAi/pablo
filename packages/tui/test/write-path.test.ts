import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **Invariant 1, enforced mechanically (AGT-1205 AC6): the model has no write
 * tool. The model proposes; the app applies.**
 *
 * A model response must never reach the manuscript without passing through
 * review, and "must never" is worth exactly as much as the thing that checks
 * it. So this test is a grep over both source trees, in the same spirit as
 * `packages/core/test/tty-free.test.ts`, and it asserts four things:
 *
 * 1. **One writer.** `writeDocument` is defined in `apply.ts` and called from
 *    exactly one place, `view.ts`. Nothing else in pablo writes a manuscript.
 * 2. **No second writer.** `writeFileSync`, `writeFile`, `appendFileSync`,
 *    `Bun.write` and `createWriteStream` appear nowhere in either `src` tree
 *    except inside `apply.ts`'s `writeDocument` and the receipt log, which
 *    writes machine state to `.pablo/` and never a manuscript.
 * 3. **The provider layer cannot write at all.** Nothing under
 *    `packages/core/src/providers/` or `packages/core/src/pack/` imports
 *    `node:fs`, `writeDocument`, or the document-editing verbs — the modules
 *    that talk to a model have no way to reach a file, by construction rather
 *    than by convention. `pack/vault.ts`, `pack/receipt-log.ts` and
 *    `pack/estimate.ts` are the named exceptions, and each is checked for what
 *    it is allowed to do.
 * 4. **Only review resolves onto the write path.** `resolveMark` and
 *    `resolveAll` — the two functions that turn a pending proposal into plain,
 *    mark-free text — are called from three places: `review.ts`, and the two
 *    adapters, which use `resolveAll` to flatten a *text-path answer* held in
 *    memory into a `Proposal.replacement` (the `Document` they pass it is the
 *    endpoint URL and a string, not a file). The test pins that list and then
 *    proves the difference that matters: every resolver except `review.ts` is
 *    sealed off from the filesystem, so `review.ts` is the only producer of
 *    resolved text that is on the same side of the wall as the writer.
 *
 * A change that breaks any of these has broken the product's first invariant,
 * not this test. If a new module genuinely needs to be on the write path, add
 * it to the allow-list here **in the same commit** so the rule stays a
 * decision someone made rather than one that eroded.
 */

const TUI = fileURLToPath(new URL("../src", import.meta.url));
const CORE = fileURLToPath(new URL("../../core/src", import.meta.url));
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

interface SourceFile {
  /** Repo-relative, POSIX separators, so the assertion messages read as paths. */
  readonly name: string;
  readonly text: string;
}

function filesUnder(dir: string): SourceFile[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    if (!entry.name.endsWith(".ts")) return [];
    return [{ name: relative(ROOT, path).split("\\").join("/"), text: readFileSync(path, "utf8") }];
  });
}

const SOURCES: SourceFile[] = [...filesUnder(TUI), ...filesUnder(CORE)];

/** Files where a pattern occurs, ignoring comments — a rule about code, not prose. */
function occurrences(pattern: RegExp): string[] {
  return SOURCES.flatMap((file) => (pattern.test(stripComments(file.text)) ? [file.name] : []));
}

/**
 * Block and line comments removed.
 *
 * Every module here documents the invariant in its own header, so a grep over
 * raw text would match the prose that explains the rule and report the rule as
 * broken by its own explanation.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("the source trees are actually being walked", () => {
  // A rule that silently checks nothing is worse than no rule.
  expect(SOURCES.length).toBeGreaterThan(25);
  expect(SOURCES.map((file) => file.name)).toContain("packages/tui/src/view.ts");
  expect(SOURCES.map((file) => file.name)).toContain("packages/core/src/providers/anthropic.ts");
});

test("writeDocument has one definition and one call site (AC6)", () => {
  // The definition.
  expect(occurrences(/export function writeDocument\b/)).toEqual(["packages/tui/src/apply.ts"]);

  // The calls. `view.ts` is the app: it is where a key the author pressed turns
  // into bytes on disk, and it is the only place a resolved proposal is written.
  const callers = occurrences(/(?<!function )\bwriteDocument\s*\(/).filter(
    (name) => name !== "packages/tui/src/apply.ts",
  );
  expect(callers).toEqual(["packages/tui/src/view.ts"]);

  // And exactly once inside it, so "the app applies" is a call site and not a habit.
  const view = SOURCES.find((file) => file.name === "packages/tui/src/view.ts");
  expect(view).toBeDefined();
  expect(stripComments(view?.text ?? "").match(/\bwriteDocument\s*\(/g)).toHaveLength(1);
});

test("nothing else in either package writes a file (AC6)", () => {
  const writers = /\b(writeFileSync|appendFileSync|createWriteStream|Bun\.write)\s*\(|\bwriteFile\s*\(/;

  expect(occurrences(writers).sort()).toEqual([
    // The one manuscript writer.
    "packages/tui/src/apply.ts",
    // Machine state, not a manuscript: one JSONL line per model call.
    "packages/core/src/pack/receipt-log.ts",
  ].sort());

  // And the receipt log writes only the path it derives from a vault root the
  // app chose — never a path that came out of a model.
  const log = SOURCES.find((file) => file.name === "packages/core/src/pack/receipt-log.ts");
  expect(log?.text).toContain('join(".pablo", "receipts.jsonl")');
  expect(stripComments(log?.text ?? "")).not.toMatch(/\.md\b/);
});

test("the provider layer cannot reach the filesystem to write (AC6)", () => {
  const providers = SOURCES.filter((file) => file.name.startsWith("packages/core/src/providers/"));
  expect(providers.length).toBeGreaterThan(5);

  // One file in the layer reads a file, and it is not an adapter: `config.ts`
  // reads the author's own `config.json`. Named here so a second one is a
  // decision someone made rather than a line nobody noticed.
  const CONFIG = "packages/core/src/providers/config.ts";
  const touchesDisk = providers.filter((file) => /from\s+["']node:fs/.test(stripComments(file.text)));
  expect(touchesDisk.map((file) => file.name)).toEqual([CONFIG]);

  // And it imports the read half of `fs` and nothing else.
  const config = stripComments(SOURCES.find((file) => file.name === CONFIG)?.text ?? "");
  expect(/import\s*\{\s*readFileSync\s*\}\s*from\s*["']node:fs["']/.test(config)).toBe(true);

  for (const file of providers) {
    const code = stripComments(file.text);
    // An adapter with no writer in scope cannot write a manuscript however it
    // is asked to, by a prompt, a tool schema, or a model's answer.
    expect(`${file.name}: ${/\bwriteDocument\b/.test(code)}`).toBe(`${file.name}: false`);
  }
});

test("nothing in the core can reach the app that owns the writer (AC6)", () => {
  // The core is a library the app consumes, never the other way round: an
  // adapter cannot call into `view.ts`, `apply.ts` or `review.ts` even by
  // accident, because there is no edge for it to travel along.
  for (const file of SOURCES.filter((source) => source.name.startsWith("packages/core/src/"))) {
    const code = stripComments(file.text);
    expect(`${file.name}: ${/from\s+["'][^"']*(pablo-tui|@openthink\/pablo["']|\.\.\/tui)/.test(code)}`).toBe(
      `${file.name}: false`,
    );
  }
});

test("the pack layer writes nothing but its own receipts (AC6)", () => {
  const pack = SOURCES.filter((file) => file.name.startsWith("packages/core/src/pack/"));
  expect(pack.length).toBeGreaterThan(5);

  // Assembly is pure and the vault reader only reads; the receipt log is the
  // single file in `pack/` allowed to touch `node:fs` for writing.
  const touchesDisk = pack.filter((file) => /from\s+["']node:fs/.test(stripComments(file.text)));
  expect(touchesDisk.map((file) => file.name).sort()).toEqual([
    "packages/core/src/pack/receipt-log.ts",
    "packages/core/src/pack/vault.ts",
  ]);

  for (const file of pack) {
    const code = stripComments(file.text);
    expect(`${file.name}: ${/\bwriteDocument\b/.test(code)}`).toBe(`${file.name}: false`);
    expect(`${file.name}: ${/\b(resolveMark|resolveAll)\b/.test(code)}`).toBe(`${file.name}: false`);
  }
});

test("review is the only resolver of proposals that is on the write path (AC6)", () => {
  // The definitions live in the core's span verbs; `markup/index.ts` re-exports
  // them and `core/src/index.ts` re-exports that.
  const definitions = [
    "packages/core/src/markup/spans.ts",
    "packages/core/src/markup/index.ts",
    "packages/core/src/index.ts",
  ];

  const REVIEW = "packages/tui/src/review.ts";
  const resolvers = occurrences(/\b(resolveMark|resolveAll)\s*\(/).filter(
    (name) => !definitions.includes(name),
  );

  // Pinned, so a fourth resolver is a decision and not a drift. The two
  // adapters resolve a *text-path answer in memory* into the replacement
  // string a `Proposal` carries — the `Document` they hand `resolveAll` is the
  // endpoint URL and the answer, never a file.
  expect([...resolvers].sort()).toEqual(
    [
      "packages/core/src/providers/anthropic.ts",
      "packages/core/src/providers/openai.ts",
      REVIEW,
    ].sort(),
  );

  // The difference that matters: every resolver except review is sealed off
  // from the filesystem, so no resolved text but review's can reach a file.
  for (const name of resolvers.filter((candidate) => candidate !== REVIEW)) {
    const code = stripComments(SOURCES.find((file) => file.name === name)?.text ?? "");
    expect(`${name} touches fs: ${/from\s+["']node:fs/.test(code)}`).toBe(`${name} touches fs: false`);
    expect(`${name} writes: ${/\bwriteDocument\b/.test(code)}`).toBe(`${name} writes: false`);
  }

  // The verbs that write on the author's own behalf — cut, move, manual edit —
  // and the one that writes a *proposal* into the file never resolve one. A
  // proposal reaching `apply.ts` is markup; it leaves review as prose.
  expect(stripComments(SOURCES.find((file) => file.name === "packages/tui/src/apply.ts")?.text ?? "")).not.toMatch(
    /\b(resolveMark|resolveAll)\b/,
  );
});

test("the run that talks to the model neither writes nor resolves (AC6)", () => {
  // `run.ts` streams the answer and hands back a string. It has no path to a
  // file and no way to decide a proposal, which is the whole reason a model's
  // answer has to come back through `view.ts` and stop at a mark.
  const run = stripComments(SOURCES.find((file) => file.name === "packages/tui/src/run.ts")?.text ?? "");
  expect(run).not.toMatch(/from\s+["']node:fs/);
  expect(run).not.toMatch(/\bwriteDocument\b/);
  expect(run).not.toMatch(/\b(resolveMark|resolveAll)\b/);
});
