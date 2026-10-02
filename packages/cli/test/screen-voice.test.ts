import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectVoiceName, screenVoicer } from "../src/screen-voice";

/** `a v` on the screen (AGT-1547) against temp copies of the fixture vault and a temp XDG_CONFIG_HOME: never a real voice directory. */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pablo-screen-voice-"));
  roots.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const project = join(vault, "novels", "ice-house");
  return { dir, vault, project, env: { XDG_CONFIG_HOME: join(dir, "config"), PABLO_VAULT: vault } };
}

test("a novel's voice is fiction (style/); a voices/<name> entry in pablo.json names that voice", () => {
  const { vault, project } = setup();
  expect(projectVoiceName(vault, project)).toBe("fiction");
  const json = JSON.parse(readFileSync(join(project, "pablo.json"), "utf8"));
  writeFileSync(join(project, "pablo.json"), JSON.stringify({ ...json, voice: ["../../voices/plain", "QWEN.md"] }));
  expect(projectVoiceName(vault, project)).toBe("plain");
});

test("flag writes a Flagged line into style/prose.md and says where", async () => {
  const { vault, project, env } = setup();
  const r = await screenVoicer(vault, project, { env })("flag", ["The well was dry.", "Nobody came."]);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.lines.join("\n")).toContain("style/prose.md");
  expect(readFileSync(join(vault, "style", "prose.md"), "utf8")).toContain('Flagged: "The well was dry. Nobody came."');
});

test("exemplar keeps the selection under the project's named voice, dated and slugged", async () => {
  const { vault, project, env } = setup();
  const json = JSON.parse(readFileSync(join(project, "pablo.json"), "utf8"));
  writeFileSync(join(project, "pablo.json"), JSON.stringify({ ...json, voice: ["../../voices/plain"] }));
  const r = await screenVoicer(vault, project, { env, now: () => new Date("2026-10-02T00:00:00Z") })("exemplar", ["The well was dry."]);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.lines[0]).toContain("voices/plain/exemplars/2026-10-02-the-well-was-dry.md");
  expect(readFileSync(join(vault, "voices", "plain", "exemplars", "2026-10-02-the-well-was-dry.md"), "utf8")).toBe("The well was dry.\n");
  expect(readdirSync(tmpdir()).filter((f) => f.startsWith("pablo-exemplar-")).length).toBe(0);
});

test("an exemplar for fiction is refused with the reason and a way forward; a duplicate flag says so; nothing selected is refused", async () => {
  const { vault, project, env } = setup();
  const voicer = screenVoicer(vault, project, { env });
  const e = await voicer("exemplar", ["The well was dry."]);
  expect(e.ok).toBe(false);
  if (!e.ok) expect(e.message).toContain("no exemplars directory");
  await voicer("flag", ["Same line."]);
  const again = await voicer("flag", ["Same line."]);
  expect(again.ok && again.lines[0]).toContain("already flagged");
  expect((await voicer("flag", [])).ok).toBe(false);
  expect(existsSync(join(vault, "style", "exemplars"))).toBe(false);
  mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
});
