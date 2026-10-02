import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bodyParagraphs, compileDraft, curlQuotes, publishWork, stripFrontmatter } from "../src/publish";
import { VERBS } from "../src/verbs";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");

function tempVault(): string {
  const vault = join(mkdtempSync(join(tmpdir(), "pablo-publish-test-")), "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  return vault;
}

test("curlQuotes curls doubles, singles, and apostrophes by context", () => {
  expect(curlQuotes('"Four thousand ton," he said. "We fill her this year."')).toBe(
    "“Four thousand ton,” he said. “We fill her this year.”",
  );
  expect(curlQuotes("Odile's mother didn't say.")).toBe("Odile’s mother didn’t say.");
  expect(curlQuotes(`"She said 'go' twice."`)).toBe("“She said ‘go’ twice.”");
  expect(curlQuotes("'Tis the winter of '29, and the saws, 'em all.")).toBe("’Tis the winter of ’29, and the saws, ’em all.");
  expect(curlQuotes('"I thought—" he said.')).toBe("“I thought—” he said.");
  expect(curlQuotes('He said—"Go."')).toBe("He said—“Go.”");
  expect(curlQuotes("“already curly”")).toBe("“already curly”");
});

test("stripFrontmatter drops a leading block and leaves other text alone", () => {
  expect(stripFrontmatter("---\nchapter: 1\n---\n\nBody.\n")).toBe("\nBody.\n");
  expect(stripFrontmatter("No frontmatter.\n---\nstill body\n")).toBe("No frontmatter.\n---\nstill body\n");
});

test("bodyParagraphs joins sentence lines and splits on blank lines", () => {
  expect(bodyParagraphs("One.\nTwo.\n\n\nThree.\nFour.\n")).toEqual(["One. Two.", "Three. Four."]);
  expect(bodyParagraphs("\n\n")).toEqual([]);
});

test("compileDraft orders chapters by number, titles them, and keeps no frontmatter", () => {
  const out = compileDraft('The "Ice" House', [
    { number: 2, text: "---\ntitle: Second\nmodel: x\n---\n\n\"Hi.\"\nHe left.\n" },
    { number: 1, text: "---\ntitle: First\n---\nOne.\nTwo.\n\nThree.\n" },
    { number: 3, text: "Untitled body.\n" },
  ]);
  expect(out).toBe(
    [
      "# The “Ice” House",
      "## Chapter 1: First",
      "One. Two.",
      "Three.",
      "## Chapter 2: Second",
      "“Hi.” He left.",
      "## Chapter 3",
      "Untitled body.",
    ].join("\n\n") + "\n",
  );
  expect(out).not.toContain("model:");
});

test("publishWork writes one file under .pablo/out and refuses other targets", () => {
  const vault = tempVault();
  const work = join(vault, "novels", "ice-house");
  mkdirSync(join(work, "chapters"), { recursive: true });
  writeFileSync(join(work, "chapters", "02-second.md"), "---\ntitle: Second\n---\nHe said \"go\".\nShe didn't.\n");

  const outcome = publishWork(work, "ice-house", "The Ice House", "draft");
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.where).toBe(join(work, ".pablo", "out", "ice-house-draft.md"));
  expect(outcome.chapters).toBe(2);
  const text = readFileSync(outcome.where, "utf8");
  expect(text.indexOf("## Chapter 1: The Last Full Cut")).toBeLessThan(text.indexOf("## Chapter 2: Second"));
  expect(text).toContain("He said “go”. She didn’t.");
  expect(text).not.toMatch(/^---$/m);
  expect(text).not.toMatch(/["']/);

  for (const target of ["review", "final", "pdf", undefined]) {
    const refused = publishWork(work, "ice-house", "The Ice House", target);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe(2);
  }

  expect(publishWork(work, "../../../escape", "The Ice House", "draft").ok).toBe(false);
  expect(existsSync(join(vault, "novels", "escape-draft.md"))).toBe(false);

  const empty = join(vault, "novels", "empty");
  mkdirSync(empty, { recursive: true });
  expect(publishWork(empty, "empty", "Empty", "draft").ok).toBe(false);
  expect(existsSync(join(empty, ".pablo"))).toBe(false);
});

test("the publish verb resolves the project and returns {target, where}", async () => {
  const vault = tempVault();
  const verb = VERBS.find((v) => v.name === "publish")!;
  const ctx = { cwd: vault, env: { PABLO_VAULT: vault, PATH: NO_THINK_PATH }, stderr: { write: () => {} } };

  const ok = await verb.run({ project: "ice-house", target: "draft" }, ctx);
  expect(ok.exitCode).toBe(0);
  expect((ok.body as { where: string }).where).toBe(join(vault, "novels", "ice-house", ".pablo", "out", "ice-house-draft.md"));

  const refused = await verb.run({ project: "ice-house", target: "final" }, ctx);
  expect(refused.exitCode).toBe(2);
});

test("pablo publish --project --target draft works end to end through the CLI", () => {
  const vault = tempVault();
  const run = (args: string[]) =>
    Bun.spawnSync(["bun", "run", CLI, ...args], {
      cwd: vault,
      env: { PABLO_VAULT: vault, PATH: NO_THINK_PATH, XDG_CONFIG_HOME: join(vault, "xdg-c"), XDG_STATE_HOME: join(vault, "xdg-s") },
    });

  const ok = run(["publish", "--project", "ice-house", "--target", "draft", "--json"]);
  expect(ok.exitCode).toBe(0);
  const body = JSON.parse(ok.stdout.toString());
  expect(body.target).toBe("draft");
  expect(existsSync(body.where)).toBe(true);

  expect(run(["publish", "--project", "ice-house", "--target", "final"]).exitCode).toBe(2);
  const help = run(["--help"]).stdout.toString();
  const [verbs, later] = help.split("Later (not yet implemented):");
  expect(verbs).toMatch(/^ {2}publish$/m);
  expect(later).not.toMatch(/^ {2}publish$/m);
});
