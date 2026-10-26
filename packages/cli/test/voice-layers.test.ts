import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeVoiceLayers, layerOf, resolveVoiceLayers } from "../src/voice-layers";

/** The layered voice resolver (AGT-2138) against temp copies of the fixture vault and a temp XDG_CONFIG_HOME. */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pablo-voice-layers-"));
  roots.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  const config = join(dir, "config");
  const globalVoices = join(config, "pablo", "voices");
  return { dir, vault, work, globalVoices, env: { XDG_CONFIG_HOME: config } };
}

function writeVoice(dir: string, body: string, exemplars: Record<string, string> = {}) {
  mkdirSync(join(dir, "exemplars"), { recursive: true });
  writeFileSync(join(dir, "voice.md"), `---\nmodel: local\n---\n${body}\n`);
  for (const [name, text] of Object.entries(exemplars)) writeFileSync(join(dir, "exemplars", name), text);
}

function setVoiceList(work: string, voice: readonly string[]) {
  const json = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8"));
  writeFileSync(join(work, "pablo.json"), JSON.stringify({ ...json, voice }));
}

function setOutputRules(work: string, output: string, text: string) {
  mkdirSync(join(work, "outputs", output), { recursive: true });
  writeFileSync(join(work, "outputs", output, "RULES.md"), text);
}

test("all four layers, lowest first: global default + named, vault style/, the work's rules, the output's RULES.md", () => {
  const { vault, work, globalVoices, env } = setup();
  writeVoice(join(globalVoices, "default"), "Global default rule.");
  writeVoice(join(globalVoices, "noir"), "Noir rule.", { "2026-01-01-a.md": "Old.\n", "2026-02-01-b.md": "New.\n" });
  setVoiceList(work, ["noir", "../../style", "QWEN.md"]);
  setOutputRules(work, "novel", "# Novel rules\n\n- Chapters end on an image.\n");

  const resolved = resolveVoiceLayers({ vaultRoot: vault, workRoot: work, output: "novel", env });

  expect(resolved.layers.map((l) => [l.layer, l.name])).toEqual([
    ["global", "default"],
    ["global", "noir"],
    ["vault", "style"],
    ["work", "QWEN.md"],
    ["output", "RULES.md (novel)"],
  ]);
  expect(resolved.missing).toEqual([]);

  // Each layer says where it came from.
  const [def, noir, style, rules, output] = resolved.layers;
  expect(def?.path).toBe(join(globalVoices, "default"));
  expect(def?.via).toBeUndefined();
  expect(noir?.via).toBe("voice[0]: noir");
  expect(noir?.rules).toEqual([{ path: `${join(globalVoices, "noir")}/voice.md`, text: "Noir rule." }]);
  expect(noir?.exemplars.map((e) => e.path)).toEqual([
    `${join(globalVoices, "noir")}/exemplars/2026-02-01-b.md`,
    `${join(globalVoices, "noir")}/exemplars/2026-01-01-a.md`,
  ]);
  expect(style?.label).toBe("style");
  expect(style?.rules.map((r) => r.path)).toEqual(["style/anti-tells.md", "style/prose.md"]);
  expect(rules?.label).toBe("novels/ice-house/QWEN.md");
  expect(output?.label).toBe("novels/ice-house/outputs/novel/RULES.md");
  expect(output?.rules[0]?.text).toContain("Chapters end on an image.");

  expect(describeVoiceLayers(resolved)[1]).toContain("global  ");
  expect(describeVoiceLayers(resolved)[1]).toContain("[voice[0]: noir]");
});

test("an entry is placed by where it lives, not by its position in the list", () => {
  const { vault, work, globalVoices, env } = setup();
  writeVoice(join(globalVoices, "noir"), "Noir rule.");
  mkdirSync(join(work, "voices"), { recursive: true });
  writeFileSync(join(work, "voices", "local.md"), "A work-only voice.\n");
  // Listed last, the vault voice and the global voice still sit in their own lower layers.
  setVoiceList(work, ["voices/local.md", "QWEN.md", "../../voices/plain", "noir"]);

  const resolved = resolveVoiceLayers({ vaultRoot: vault, workRoot: work, env });
  expect(resolved.layers.map((l) => [l.layer, l.name])).toEqual([
    ["global", "noir"],
    ["vault", "style"],
    ["vault", "plain"],
    ["work", "local"],
    ["work", "QWEN.md"],
  ]);
  expect(layerOf(resolved, "vault")[1]?.via).toBe("voice[2]: ../../voices/plain");
  expect(layerOf(resolved, "work")[0]?.rules).toEqual([{ path: "novels/ice-house/voices/local.md", text: "A work-only voice." }]);
});

test("a bare name resolves vault first, then global; fiction is style/ and is kept once", () => {
  const { vault, work, globalVoices, env } = setup();
  writeVoice(join(globalVoices, "plain"), "The global plain, shadowed by the vault's.");
  setVoiceList(work, ["plain", "fiction", "../../style"]);

  const resolved = resolveVoiceLayers({ vaultRoot: vault, workRoot: work, env });
  expect(resolved.layers.map((l) => [l.layer, l.path])).toEqual([
    ["vault", join(vault, "style")],
    ["vault", join(vault, "voices", "plain")],
    ["work", join(work, "QWEN.md")],
  ]);
});

test("a path into a voice's directory stands for the whole voice, read once", () => {
  const { vault, work, env } = setup();
  setVoiceList(work, ["../../voices/plain/voice.md", "../../voices/plain"]);
  const resolved = resolveVoiceLayers({ vaultRoot: vault, workRoot: work, env });
  expect(layerOf(resolved, "vault").map((l) => l.name)).toEqual(["style", "plain"]);
});

test("missing layers are reported, never thrown, and the rest still resolve", () => {
  const { vault, work, globalVoices, env } = setup();
  setVoiceList(work, ["ghost", "../../voices/gone", "QWEN.md"]);
  rmSync(join(vault, "style"), { recursive: true });

  const resolved = resolveVoiceLayers({ vaultRoot: vault, workRoot: work, output: "radio", env });
  expect(resolved.layers.map((l) => [l.layer, l.name])).toEqual([["work", "QWEN.md"]]);
  const byName = Object.fromEntries(resolved.missing.map((m) => [m.name, m]));
  expect(byName["default"]?.layer).toBe("global");
  expect(byName["default"]?.tried).toEqual([join(globalVoices, "default")]);
  expect(byName["style"]?.layer).toBe("vault");
  expect(byName["ghost"]?.via).toBe("voice[0]: ghost");
  expect(byName["ghost"]?.tried).toEqual([join(vault, "voices", "ghost"), join(globalVoices, "ghost")]);
  expect(byName["../../voices/gone"]?.layer).toBe("vault");
  expect(byName["RULES.md (radio)"]?.layer).toBe("output");
});

test("an empty file is a missing layer, and no output means no output layer", () => {
  const { vault, work, env } = setup();
  writeFileSync(join(work, "QWEN.md"), "");
  setOutputRules(work, "novel", "# rules\n");
  const resolved = resolveVoiceLayers({ vaultRoot: vault, workRoot: work, env });
  expect(layerOf(resolved, "work")).toEqual([]);
  expect(layerOf(resolved, "output")).toEqual([]);
  expect(resolved.missing.find((m) => m.name === "QWEN.md")?.reason).toContain("is empty");
  expect(resolved.missing.some((m) => m.layer === "output")).toBe(false);
});

test("no pablo.json reads the default list; a voice option overrides the marker", () => {
  const { vault, work, env } = setup();
  rmSync(join(work, "pablo.json"));
  const fallback = resolveVoiceLayers({ vaultRoot: vault, workRoot: work, env });
  expect(fallback.layers.map((l) => l.name)).toEqual(["style", "QWEN.md"]);

  const overridden = resolveVoiceLayers({ vaultRoot: vault, workRoot: work, env, voice: ["plain"] });
  expect(overridden.layers.map((l) => l.name)).toEqual(["style", "plain", "QWEN.md"]);
});

test("describeVoiceLayers labels the global default and lists a voice pablo.json names that was not found (AGT-2139)", () => {
  const { vault, work, globalVoices, env } = setup();
  writeVoice(join(globalVoices, "default"), "Global default rule.");
  setVoiceList(work, ["../../style", "ghost", "QWEN.md"]);
  const lines = describeVoiceLayers(resolveVoiceLayers({ vaultRoot: vault, workRoot: work, env }));
  expect(lines[0]).toContain("[global default]");
  expect(lines.at(-1)).toBe('missing  ghost  [voice[1]: ghost]: no voice "ghost"');
});
