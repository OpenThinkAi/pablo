import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "bun:test";
import { screenVoicer } from "../src/screen-voice";
import { VERBS, runVoiceRule } from "../src/verbs";
import { addRule, resolveVoice } from "../src/voice";
import type { VoiceLocation } from "../src/voice";

/**
 * AGT-1594: `voice rule` / `a v r` — a typed rule becomes a bullet under `## Rules`, in the voice's rules file
 * (style/prose.md for fiction, voice.md for a named voice) or the work's QWEN.md. Every test works on a throwaway,
 * git-initialised copy of the synthetic fixture vault; nothing touches ~/writing.
 */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function git(vault: string, ...args: string[]): string {
  return execFileSync("git", ["-C", vault, ...args], { encoding: "utf8" });
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pablo-voice-rule-"));
  dirs.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  git(vault, "init", "-q");
  git(vault, "config", "user.email", "t@t.example");
  git(vault, "config", "user.name", "Test");
  git(vault, "add", "--", ".");
  git(vault, "commit", "-qm", "base");
  const env = { PABLO_VAULT: vault, XDG_CONFIG_HOME: join(dir, "config") };
  return { vault, env, project: join(vault, "novels", "ice-house") };
}

function location(vault: string, name: string, env: Record<string, string>): VoiceLocation {
  const r = resolveVoice(name, { cwd: vault, env });
  if (!r.ok) throw new Error(`fixture voice ${name} did not resolve`);
  return r;
}

const lastSubject = (vault: string) => git(vault, "log", "-1", "--format=%s").trim();

test("a named voice with no ## Rules section gets one at EOF: heading, blank line, the bullet; committed", () => {
  const { vault, env } = setup();
  const path = join(vault, "voices", "plain", "voice.md");
  const before = readFileSync(path, "utf8");
  const r = addRule(location(vault, "plain", env), "Use contractions in narration.");
  expect(r.ok && r.path).toBe(path);
  expect(r.ok && r.committed).toBe(true);
  const after = readFileSync(path, "utf8");
  expect(after.startsWith(before.trimEnd())).toBe(true);
  expect(after.trimEnd().endsWith("## Rules\n\n- Use contractions in narration.")).toBe(true);
  expect(lastSubject(vault)).toBe("voice: add a rule to voice.md");
});

test("an existing ## Rules section takes the bullet as its last line, the rest byte-for-byte unchanged", () => {
  const { vault, env } = setup();
  const path = join(vault, "voices", "plain", "voice.md");
  const original = readFileSync(path, "utf8");
  writeFileSync(path, original.replace("## Flagged", "## Rules\n\n- First rule.\n\n## Flagged"));
  const withRules = readFileSync(path, "utf8");
  addRule(location(vault, "plain", env), "Second rule.");
  const after = readFileSync(path, "utf8").split("\n");
  const at = after.indexOf("## Rules");
  expect(after.slice(at, at + 5)).toEqual(["## Rules", "", "- First rule.", "- Second rule.", ""]);
  expect(after.filter((l) => l === "## Rules").length).toBe(1);
  for (const line of withRules.split("\n")) expect(after).toContain(line);
});

test("fiction's rule goes to style/prose.md; with sentences it is followed by an indented Flagged line that check reads", () => {
  const { vault, env } = setup();
  const r = addRule(location(vault, "fiction", env), "Do not open on weather.", { example: "The rain fell all night." });
  expect(r.ok && r.path).toBe(join(vault, "style", "prose.md"));
  const text = readFileSync(join(vault, "style", "prose.md"), "utf8");
  expect(text).toContain('## Rules\n\n- Do not open on weather.\n  Flagged: "The rain fell all night."');
  // check.ts: `/^\s*Flagged:/` per line, so the indented line is a flagged pattern.
  expect(text.split("\n")).toContain('  Flagged: "The rain fell all night."');
  expect(lastSubject(vault)).toBe("voice: add a rule to prose.md");
});

test("target work: appended under the work's existing Ground rules section in QWEN.md; a missing section is ## Rules", () => {
  const { vault, project } = setup();
  const qwen = join(project, "QWEN.md");
  const r = addRule(undefined, "No dream sequences.", { target: "work", projectPath: project });
  expect(r.ok && r.path).toBe(qwen);
  const lines = readFileSync(qwen, "utf8").split("\n");
  const ground = lines.findIndex((l) => l.startsWith("## Ground rules"));
  const next = lines.findIndex((l, i) => i > ground && l.startsWith("## "));
  expect(lines.slice(ground, next)).toContain("- No dream sequences.");
  expect(lines).not.toContain("## Rules");
  expect(lastSubject(vault)).toBe("voice: add a rule to QWEN.md");

  writeFileSync(qwen, "# Work\n\nNotes.\n");
  addRule(undefined, "No dream sequences.", { target: "work", projectPath: project, example: "She woke." });
  expect(readFileSync(qwen, "utf8")).toBe('# Work\n\nNotes.\n\n## Rules\n\n- No dream sequences.\n  Flagged: "She woke."');
});

test("a duplicate bullet changes nothing; empty text, a work with no QWEN.md and a missing project are refused", () => {
  const { vault, env, project } = setup();
  const loc = location(vault, "plain", env);
  addRule(loc, "Once.");
  const again = addRule(loc, "Once.");
  expect(again.ok && again.committed).toBe(false);
  expect(again.ok && again.notice).toContain("already a rule");
  expect(readFileSync(join(vault, "voices", "plain", "voice.md"), "utf8").match(/- Once\./g)?.length).toBe(1);
  expect(addRule(loc, "  ").ok).toBe(false);
  expect(addRule(undefined, "x", { target: "work" }).ok).toBe(false);
  rmSync(join(project, "QWEN.md"));
  const gone = addRule(undefined, "x", { target: "work", projectPath: project });
  expect(!gone.ok && gone.message).toContain("no QWEN.md");
});

test("newlines in text and example are flattened: neither can forge a heading", () => {
  const { vault, env } = setup();
  addRule(location(vault, "plain", env), "Plain.\n## Injected", { example: "A.\n## AlsoInjected" });
  const text = readFileSync(join(vault, "voices", "plain", "voice.md"), "utf8");
  expect(text).toContain('- Plain. ## Injected\n  Flagged: "A. ## AlsoInjected"');
  expect(text).not.toMatch(/^## (Injected|AlsoInjected)$/m);
});

test("voice rule: the CLI, VOICE_ARGS' rule branch and the voice_rule MCP tool share runVoiceRule", async () => {
  const { vault, env, project } = setup();
  const ctx = { cwd: vault, env, stderr: { write: () => {} } };
  const voice = VERBS.find((v) => v.name === "voice")!;
  const tool = voice.mcpTools!.find((t) => t.name === "voice_rule")!;
  expect(tool).toBeDefined();
  expect(Object.keys(tool.args.shape).sort()).toEqual(["example", "name", "project", "target", "text"]);
  expect(tool.args.safeParse({ name: "plain" }).success).toBe(false);

  const direct = runVoiceRule({ name: "plain", text: "From the function." }, ctx);
  const viaVerb = await voice.run({ sub: "rule", name: "plain", text: "From the verb.", global: false }, ctx);
  const viaTool = await tool.run({ name: "plain", text: "From the tool." }, { ...ctx, caller: "mcp" });
  for (const o of [direct, viaVerb, viaTool]) expect(o).toMatchObject({ exitCode: 0, body: { ok: true, target: "voice", committed: true } });
  const text = readFileSync(join(vault, "voices", "plain", "voice.md"), "utf8");
  for (const t of ["From the function.", "From the verb.", "From the tool."]) expect(text).toContain(`- ${t}`);

  const work = await tool.run({ name: "plain", text: "Work rule.", target: "work", project: "ice-house" }, { ...ctx, caller: "mcp" });
  expect(work).toMatchObject({ exitCode: 0, body: { ok: true, target: "work", path: join(project, "QWEN.md") } });
  expect((await tool.run({ name: "plain", text: "x", target: "work" }, ctx)).exitCode).toBe(2);
  expect((await voice.run({ sub: "rule", name: "plain", global: false }, ctx)).exitCode).toBe(2);
});

test("over MCP a path-shaped voice name outside the vault is refused; the CLI path is the author's", async () => {
  const { vault, env } = setup();
  const ctx = { cwd: vault, env, stderr: { write: () => {} } };
  const tool = VERBS.find((v) => v.name === "voice")!.mcpTools!.find((t) => t.name === "voice_rule")!;
  const refused = await tool.run({ name: "/etc/hosts", text: "x" }, { ...ctx, caller: "mcp" });
  expect(refused.exitCode).toBe(2);
  expect((refused.body as { message: string }).message).toContain("inside the vault");
});

test("the screen path: rule lands in style/prose.md for fiction with the selection as its example, or in QWEN.md for the work", async () => {
  const { vault, env, project } = setup();
  const voicer = screenVoicer(vault, project, { env });
  const r = await voicer("rule", ["The rain fell.", "Nobody came."], { text: "No weather openings.", target: "voice" });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.lines).toEqual(["Rule added in style/prose.md (voice fiction), committed.", "- No weather openings.", 'Flagged: "The rain fell. Nobody came."']);
  expect(readFileSync(join(vault, "style", "prose.md"), "utf8")).toContain('- No weather openings.\n  Flagged: "The rain fell. Nobody came."');

  const w = await voicer("rule", [], { text: "Keep chapters short.", target: "work" });
  expect(w.ok && w.lines[0]).toBe("Rule added in novels/ice-house/QWEN.md (the work's QWEN.md), committed.");
  expect(readFileSync(join(project, "QWEN.md"), "utf8")).toContain("- Keep chapters short.");

  const again = await voicer("rule", [], { text: "Keep chapters short.", target: "work" });
  expect(again.ok && again.lines[0]).toContain("already a rule");
  expect((await voicer("rule", [], { text: "  ", target: "voice" })).ok).toBe(false);
  expect((await voicer("rule", [])).ok).toBe(false);
  expect((await voicer("flag", [])).ok).toBe(false); // flag and exemplar still need a selection
});

test("the screen path follows pablo.json's voice: a voices/<name> work gets voice.md", async () => {
  const { vault, env, project } = setup();
  const json = JSON.parse(readFileSync(join(project, "pablo.json"), "utf8"));
  writeFileSync(join(project, "pablo.json"), JSON.stringify({ ...json, voice: ["../../voices/plain", "QWEN.md"] }));
  const r = await screenVoicer(vault, project, { env })("rule", [], { text: "Plain words.", target: "voice" });
  expect(r.ok && r.lines[0]).toBe("Rule added in voices/plain/voice.md (voice plain), committed.");
});
