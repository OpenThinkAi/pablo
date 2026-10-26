import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "bun:test";
import { VERBS, runVoiceEdit, runVoiceList, runVoiceRemove, runVoiceRule, runVoiceUse } from "../src/verbs";
import { parseLayerTarget, parseRules, ruleId } from "../src/voice-rules";

/**
 * AGT-2140: `voice rule --target global|vault|work|output:<type>`, rule ids in `voice list`, `voice edit`,
 * `voice remove`, `voice use`. A throwaway git-initialised copy of the synthetic fixture vault and a temp
 * XDG_CONFIG_HOME; the real ~/.config/pablo and ~/writing are never touched.
 */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const git = (vault: string, ...args: string[]) => execFileSync("git", ["-C", vault, ...args], { encoding: "utf8" });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pablo-voice-edit-"));
  dirs.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  git(vault, "init", "-q");
  git(vault, "config", "user.email", "t@t.example");
  git(vault, "config", "user.name", "Test");
  git(vault, "add", "--", ".");
  git(vault, "commit", "-qm", "base");
  const config = join(dir, "config");
  const env = { PABLO_VAULT: vault, XDG_CONFIG_HOME: config };
  return { vault, config, env, ctx: { cwd: vault, env, caller: "cli" as const }, work: join(vault, "novels", "ice-house") };
}

const body = (r: { body: unknown }) => r.body as Record<string, any>;

test("parseLayerTarget accepts the four layers and rejects the rest", () => {
  expect(parseLayerTarget("global")).toBe("global");
  expect(parseLayerTarget("output:radio")).toBe("output:radio");
  expect(parseLayerTarget("output:../x")).toBeUndefined();
  expect(parseLayerTarget("output:")).toBeUndefined();
  expect(parseLayerTarget("voice")).toBeUndefined();
  expect(parseLayerTarget("nope")).toBeUndefined();
});

test("--target global appends to the global default voice, created on demand, never committed", () => {
  const { ctx, config } = setup();
  const r = runVoiceRule({ text: "Plain words.", target: "global" }, ctx);
  expect(r.exitCode).toBe(0);
  const path = join(config, "pablo", "voices", "default", "voice.md");
  expect(body(r).path).toBe(path);
  expect(body(r).committed).toBe(false);
  expect(readFileSync(path, "utf8")).toContain("## Rules\n\n- Plain words.");
});

test("--target vault appends to style/prose.md and commits", () => {
  const { ctx, vault } = setup();
  const r = runVoiceRule({ text: "No adverbs.", target: "vault" }, ctx);
  expect(body(r).path).toBe(join(vault, "style", "prose.md"));
  expect(body(r).committed).toBe(true);
  expect(readFileSync(join(vault, "style", "prose.md"), "utf8")).toContain("- No adverbs.");
  expect(git(vault, "log", "-1", "--format=%s").trim()).toBe("voice: add a rule to prose.md");
});

test("--target work needs --project and an existing QWEN.md", () => {
  const { ctx, work } = setup();
  expect(runVoiceRule({ text: "x", target: "work" }, ctx).exitCode).toBe(2);
  const r = runVoiceRule({ text: "Keep it dry.", target: "work", project: "ice-house" }, ctx);
  expect(r.exitCode).toBe(0);
  expect(body(r).path).toBe(join(work, "QWEN.md"));
  expect(readFileSync(join(work, "QWEN.md"), "utf8")).toContain("- Keep it dry.");
});

test("--target output:<type> appends to outputs/<type>/RULES.md, creating it", () => {
  const { ctx, work, vault } = setup();
  const r = runVoiceRule({ text: "Scenes end on a question.", target: "output:radio", project: "ice-house" }, ctx);
  expect(r.exitCode).toBe(0);
  const path = join(work, "outputs", "radio", "RULES.md");
  expect(body(r).path).toBe(path);
  expect(body(r).target).toBe("output:radio");
  expect(readFileSync(path, "utf8")).toContain("- Scenes end on a question.");
  expect(git(vault, "log", "-1", "--format=%s").trim()).toBe("voice: add a rule to RULES.md");
});

test("a bad --target is refused; an output type cannot traverse", () => {
  const { ctx } = setup();
  expect(runVoiceRule({ text: "x", target: "nope" }, ctx).exitCode).toBe(2);
  expect(runVoiceRule({ text: "x", target: "output:../../etc", project: "ice-house" }, ctx).exitCode).toBe(2);
});

test("voice list shows every rule with an id; project rules need --project or a cwd inside the work", () => {
  const { ctx, work } = setup();
  runVoiceRule({ text: "Global one.", target: "global" }, ctx);
  runVoiceRule({ text: "Vault one.", target: "vault" }, ctx);
  runVoiceRule({ text: "Work one.", target: "work", project: "ice-house" }, ctx);
  runVoiceRule({ text: "Radio one.", target: "output:radio", project: "ice-house" }, ctx);
  const without = body(runVoiceList({}, ctx)).rules as { id: string; target: string; text: string }[];
  expect(without.map((r) => r.target)).toEqual(["global", "vault"]);
  const withProject = body(runVoiceList({ project: "ice-house" }, ctx)).rules as { id: string; target: string; text: string }[];
  expect(withProject.map((r) => r.target)).toEqual(["global", "vault", "work", "output:radio"]);
  expect(withProject.find((r) => r.text === "Work one.")?.id).toBe(ruleId("Work one."));
  expect(body(runVoiceList({}, { ...ctx, cwd: work })).rules).toHaveLength(4);
});

test("voice edit changes one rule by id, keeps its Flagged example, returns the new id, and commits", () => {
  const { ctx, vault } = setup();
  runVoiceRule({ name: "fiction", text: "Do not open on weather.", example: "The rain fell." }, ctx);
  runVoiceRule({ text: "Other rule.", target: "vault" }, ctx);
  const id = ruleId("Do not open on weather.");
  const r = runVoiceEdit({ id, text: "Never open on weather." }, ctx);
  expect(r.exitCode).toBe(0);
  expect(body(r).id).toBe(ruleId("Never open on weather."));
  const text = readFileSync(join(vault, "style", "prose.md"), "utf8");
  expect(text).toContain('- Never open on weather.\n  Flagged: "The rain fell."');
  expect(text).not.toContain("Do not open on weather.");
  expect(text).toContain("- Other rule.");
  expect(git(vault, "log", "-1", "--format=%s").trim()).toBe("voice: edit a rule in prose.md");
});

test("voice remove deletes the rule and its example lines, nothing else", () => {
  const { ctx, vault } = setup();
  runVoiceRule({ name: "fiction", text: "Drop me.", example: "An example." }, ctx);
  runVoiceRule({ text: "Keep me.", target: "vault" }, ctx);
  const r = runVoiceRemove({ id: ruleId("Drop me.") }, ctx);
  expect(r.exitCode).toBe(0);
  const text = readFileSync(join(vault, "style", "prose.md"), "utf8");
  expect(text).not.toContain("Drop me.");
  expect(text).not.toContain("An example.");
  expect(text).toContain("- Keep me.");
  expect(parseRules(text).map((x) => x.text)).toEqual(["Keep me."]);
  expect(git(vault, "log", "-1", "--format=%s").trim()).toBe("voice: remove a rule from prose.md");
});

test("an unknown id is refused; the same rule in two files needs --target", () => {
  const { ctx, vault, config } = setup();
  expect(runVoiceRemove({ id: "abcdef" }, ctx).exitCode).toBe(2);
  runVoiceRule({ text: "Shared rule.", target: "vault" }, ctx);
  runVoiceRule({ text: "Shared rule.", target: "global" }, ctx);
  const id = ruleId("Shared rule.");
  const ambiguous = runVoiceRemove({ id }, ctx);
  expect(ambiguous.exitCode).toBe(2);
  expect(body(ambiguous).message).toContain("--target");
  expect(runVoiceRemove({ id, target: "global" }, ctx).exitCode).toBe(0);
  expect(readFileSync(join(config, "pablo", "voices", "default", "voice.md"), "utf8")).not.toContain("Shared rule.");
  expect(readFileSync(join(vault, "style", "prose.md"), "utf8")).toContain("Shared rule.");
});

test("edit refuses empty text and a duplicate of another rule", () => {
  const { ctx } = setup();
  runVoiceRule({ text: "One.", target: "vault" }, ctx);
  runVoiceRule({ text: "Two.", target: "vault" }, ctx);
  expect(runVoiceEdit({ id: ruleId("One."), text: "  " }, ctx).exitCode).toBe(2);
  expect(runVoiceEdit({ id: ruleId("One."), text: "Two." }, ctx).exitCode).toBe(2);
});

test("voice use adds a named voice to pablo.json once, keeping every other key", () => {
  const { ctx, work, vault } = setup();
  const marker = join(work, "pablo.json");
  const before = JSON.parse(readFileSync(marker, "utf8"));
  const r = runVoiceUse({ name: "plain", project: "ice-house" }, ctx);
  expect(r.exitCode).toBe(0);
  expect(body(r).added).toBe(true);
  const after = JSON.parse(readFileSync(marker, "utf8"));
  expect(after.voice).toEqual([...(before.voice ?? ["../../style", "QWEN.md"]), "plain"]);
  expect({ ...after, voice: undefined }).toEqual({ ...before, voice: undefined });
  expect(git(vault, "log", "-1", "--format=%s").trim()).toBe("voice: use plain");
  const again = runVoiceUse({ name: "plain", project: "ice-house" }, ctx);
  expect(body(again).added).toBe(false);
  expect(JSON.parse(readFileSync(marker, "utf8")).voice.filter((v: string) => v === "plain")).toHaveLength(1);
});

test("voice use refuses an unknown voice, a path, and a missing project", () => {
  const { ctx } = setup();
  expect(runVoiceUse({ name: "nosuch", project: "ice-house" }, ctx).exitCode).toBe(2);
  expect(runVoiceUse({ name: "../x.md", project: "ice-house" }, ctx).exitCode).toBe(2);
  expect(runVoiceUse({ name: "plain" }, ctx).exitCode).toBe(2);
});

test("the voice verb's sub field reaches edit, remove and use", async () => {
  const { ctx } = setup();
  const voice = VERBS.find((v) => v.name === "voice")!;
  runVoiceRule({ text: "Via verb.", target: "vault" }, ctx);
  const run = (args: Record<string, unknown>) => voice.run(voice.args.parse(args) as never, { ...ctx, stderr: { write: () => {} } } as never);
  expect((await run({ sub: "edit", name: ruleId("Via verb."), text: "Via the verb." })).exitCode).toBe(0);
  expect((await run({ sub: "remove", name: ruleId("Via the verb.") })).exitCode).toBe(0);
  expect((await run({ sub: "use", name: "plain", project: "ice-house" })).exitCode).toBe(0);
  expect(existsSync(join(ctx.cwd, "style"))).toBe(true);
});
