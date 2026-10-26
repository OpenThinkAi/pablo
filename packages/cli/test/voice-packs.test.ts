/**
 * Every pack uses the layered voice, with exemplars (AGT-2139, pablo-platform
 * D-15): the novel, story and radio packs assemble their voice from
 * `resolveVoiceLayers` (global default and named voices, the vault's style/,
 * the voices the work's `pablo.json` lists and its rules file, the output's
 * RULES.md), the voices' exemplars and `never.md` included; `prose` carries
 * the global default under its `--voice`; the dry run and the receipt list
 * the layers used, label the global default, and show a listed voice that was
 * not found.
 *
 * Everything runs on temp copies of the synthetic fixture vault with a temp
 * XDG_CONFIG_HOME and a fake writer: no model, never `~/writing`.
 */

import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, CompletionEvent, Pack } from "@openthink/pablo-core";
import { receiptsPath, renderPack } from "@openthink/pablo-core";
import { readMarker } from "../src/marker";
import type { Marker } from "../src/marker";
import { buildChapterPack } from "../src/novel/pack";
import { OUTPUTS } from "../src/outputs/registry";
import { proseCore } from "../src/prose";
import { runWrite } from "../src/write";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const GLOBAL_RULE = "Global rule: no sentence opens with a participle.";
const NOIR_RULE = "Noir rule: short declaratives when the weather turns.";
const PLAIN_EXEMPLAR = "Ice delivery moves to Thursdays"; // voices/plain's newest exemplar
const HOUSE_RULE = "House rule: the pond is always \"the pond\", never \"the lake\".";

function git(dir: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
}

function writeVoice(dir: string, body: string, extra: { exemplars?: Record<string, string>; never?: string } = {}) {
  mkdirSync(join(dir, "exemplars"), { recursive: true });
  writeFileSync(join(dir, "voice.md"), `---\nmodel: local\n---\n${body}\n`);
  for (const [name, text] of Object.entries(extra.exemplars ?? {})) writeFileSync(join(dir, "exemplars", name), text);
  if (extra.never !== undefined) writeFileSync(join(dir, "never.md"), extra.never);
}

/**
 * The fixture vault (a git repo, migrated to `outputs` with novel, story and radio), a global default voice, a global
 * `noir` voice with an exemplar and a `never.md`, and the work listing `noir` and the vault's `plain` voice.
 */
function setup(options: { voice?: readonly string[]; globalDefault?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pablo-voice-packs-"));
  roots.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  const config = join(dir, "config");
  const globalVoices = join(config, "pablo", "voices");
  if (options.globalDefault !== false) writeVoice(join(globalVoices, "default"), GLOBAL_RULE);
  writeVoice(join(globalVoices, "noir"), NOIR_RULE, {
    exemplars: { "2026-03-01-rain.md": "Rain on the pond. Nobody cut that day.\n" },
    never: "Never a simile about cigarettes.\n",
  });

  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as Record<string, unknown>;
  delete marker["format"];
  writeFileSync(
    join(work, "pablo.json"),
    `${JSON.stringify(
      {
        ...marker,
        voice: options.voice ?? ["../../style", "noir", "plain", "house-voice.md", "QWEN.md"],
        outputs: { novel: { dir: "chapters", added: "2026-09-01" }, story: { added: "2026-10-01" }, radio: { added: "2026-10-01" } },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(work, "house-voice.md"), `${HOUSE_RULE}\n`);
  mkdirSync(join(work, "outputs", "novel"), { recursive: true });
  writeFileSync(join(work, "outputs", "novel", "RULES.md"), "# Novel rules\n\n- Chapters end on an image.\n");
  // Chapter 3's beat names Mrs. Frayne, an undecided [pick] in the fixture: decide it so chapter 3 is ready.
  const tree = join(work, "bible", "characters", "family-tree.md");
  writeFileSync(tree, readFileSync(tree, "utf8").replace("Mrs. Frayne [pick]", "Mrs. Frayne"));
  writeFileSync(join(work, "chapters", "02-black-ice.md"), "---\nchapter: 2\ntitle: Black Ice\nstatus: draft\n---\n\nThe ice rang wrong.\n");

  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "pablo-test@example.com");
  git(vault, "config", "user.name", "Pablo Test");
  git(vault, "config", "commit.gpgsign", "false");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  return { dir, vault, work, globalVoices, env: { XDG_CONFIG_HOME: config } };
}

function markerOf(work: string): Marker {
  const result = readMarker(work);
  if (!result.ok) throw new Error(result.message);
  return result.marker;
}

function sliceText(pack: Pack, name: string): string {
  return pack.slices.find((slice) => slice.name === name)?.text ?? "";
}

test("AC3: a global voice rule reaches a novel pack", () => {
  const { vault, work, env } = setup({ voice: ["../../style", "QWEN.md"] });
  const result = buildChapterPack(vault, work, 1, { marker: markerOf(work), env });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(sliceText(result.pack, "style")).toContain(GLOBAL_RULE);
  expect(result.pack.prompt).toContain(GLOBAL_RULE);
  // Lowest layer first: the global default is read before the vault's style/.
  const style = sliceText(result.pack, "style");
  expect(style.indexOf(GLOBAL_RULE)).toBeLessThan(style.indexOf("# Prose")); // fixture style/prose.md's title
  expect(result.pack.voiceLayers?.layers[0]).toMatchObject({ layer: "global", name: "default", via: "global default" });
});

test("AC1: novel, story and radio packs carry the work's named voices, their exemplars and never.md, in layer order", () => {
  const { vault, work, env } = setup();
  const marker = markerOf(work);
  const packs: Record<string, Pack> = {};
  for (const [id, unit] of [["novel", 1], ["story", 1], ["radio", 1]] as const) {
    const result = OUTPUTS[id].pack(vault, work, unit, { marker, output: id, env });
    if (!result.ok) throw new Error(`${id}: ${result.message}`);
    packs[id] = result.pack;
  }

  for (const [id, pack] of Object.entries(packs)) {
    // The global layer (default + the named global voice) is below the vault's style/ in the style slice.
    const style = sliceText(pack, "style");
    expect(style).toContain(GLOBAL_RULE);
    expect(style).toContain(NOIR_RULE);
    // The vault's `plain` voice the work lists sits in the vault layer, after style/.
    const styleSource = pack.slices.find((slice) => slice.name === "style")?.source ?? "";
    expect(styleSource.indexOf("style/prose.md")).toBeLessThan(styleSource.indexOf("voices/plain/voice.md"));
    // The work layer: the one-off voice file the work lists, then its own rules file.
    const workRules = pack.slices.find((slice) => slice.name === "workRules");
    expect(workRules?.source).toBe("novels/ice-house/house-voice.md, novels/ice-house/QWEN.md");
    expect(workRules?.text.startsWith(HOUSE_RULE)).toBe(true);
    // Exemplars: the most specific voice's first (vault `plain`, then global `noir`).
    const exemplars = sliceText(pack, "exemplars");
    expect(exemplars).toContain(PLAIN_EXEMPLAR);
    expect(exemplars).toContain("Rain on the pond.");
    expect(exemplars.indexOf(PLAIN_EXEMPLAR)).toBeLessThan(exemplars.indexOf("Rain on the pond."));
    expect(sliceText(pack, "never")).toContain("Never a simile about cigarettes.");

    // The prompt reads the layers lowest first: style (global, vault), work, output, never; exemplars after craft.
    const order = ["style", "workRules", ...(id === "novel" ? ["outputRules"] : []), "never", "craft", "exemplars"];
    const names = pack.slices.map((slice) => slice.name).filter((name) => order.includes(name));
    expect(names).toEqual(order);

    const layers = pack.voiceLayers?.layers.map((l) => [l.layer, l.name, l.via]);
    expect(layers?.slice(0, 6)).toEqual([
      ["global", "default", "global default"],
      ["global", "noir", "voice[1]: noir"],
      ["vault", "style", undefined],
      ["vault", "plain", "voice[2]: plain"],
      ["work", "house-voice", "voice[3]: house-voice.md"],
      ["work", "QWEN.md", undefined],
    ]);
    expect(pack.voiceLayers?.missing).toEqual([]);
  }
  expect(packs["novel"]?.voiceLayers?.layers.at(-1)).toMatchObject({ layer: "output", name: "RULES.md (novel)" });
});

test("a voice pablo.json lists that is not found is shown in the dry run, with the entry that named it", () => {
  const { vault, work, env } = setup({ voice: ["../../style", "nosuch", "QWEN.md"], globalDefault: false });
  const result = buildChapterPack(vault, work, 1, { marker: markerOf(work), env });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.pack.voiceLayers?.missing).toEqual([{ name: "nosuch", via: "voice[1]: nosuch", reason: 'no voice "nosuch"' }]);
  // An absent global default is not a listed voice: it is not reported missing.
  expect(result.pack.voiceLayers?.layers.map((l) => l.name)).not.toContain("default");
  const text = renderPack(result.pack).text;
  expect(text).toContain("voice layers (lowest first):");
  expect(text).toContain('missing  nosuch  [voice[1]: nosuch]: no voice "nosuch"');
});

function fakeWriter(): Adapter {
  return {
    id: "local",
    model: "test-writer-model",
    preferredOutput: "text",
    async *complete(): AsyncIterable<CompletionEvent> {
      yield { type: "token", text: "The route was down to nine stops. Odile drove it herself." };
      yield { type: "done", stats: { timeToFirstTokenMs: 10, elapsedMs: 20, tokensRead: 100, tokensWritten: 12, tokensPerSecond: 600 } };
    },
    async proposeEdit(): Promise<never> {
      throw new Error("not used");
    },
    async extractFacts(): Promise<never> {
      throw new Error("not used");
    },
  };
}

async function captureLog(run: () => Promise<number>): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (text: unknown) => void lines.push(String(text));
  try {
    return { code: await run(), out: lines.join("\n") };
  } finally {
    console.log = log;
  }
}

test("AC2: write's dry run and its receipt list the voice layers used", async () => {
  const { dir, vault, work, env } = setup();
  const writeEnv = { ...env, PATH: NO_THINK_PATH, XDG_STATE_HOME: join(dir, "state"), PABLO_HOME: join(dir, "pablo-home") };
  const args = { chapter: undefined, unit: "3", output: "novel", words: undefined, scenes: undefined, json: true, force: false };
  const deps = { adapter: fakeWriter(), env: writeEnv, stderr: { write: () => {} }, now: () => new Date("2026-10-26T12:00:00Z") };

  const dry = await captureLog(() => runWrite({ ...args, dryRun: true }, vault, work, deps));
  expect(dry.code).toBe(0);
  const dryBody = JSON.parse(dry.out) as { voiceLayers: { layers: { name: string }[] } };
  expect(dryBody.voiceLayers.layers.map((l) => l.name)).toEqual(["default", "noir", "style", "plain", "house-voice", "QWEN.md", "RULES.md (novel)"]);

  const sent = await captureLog(() => runWrite({ ...args, dryRun: false }, vault, work, deps));
  expect(sent.code).toBe(0);
  const lines = readFileSync(receiptsPath(work), "utf8").trim().split("\n");
  const receipt = JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
  expect(receipt["voice_layers"]).toEqual([
    { layer: "global", name: "default", source: join(dir, "config", "pablo", "voices", "default"), via: "global default" },
    { layer: "global", name: "noir", source: join(dir, "config", "pablo", "voices", "noir"), via: "voice[1]: noir" },
    { layer: "vault", name: "style", source: "style" },
    { layer: "vault", name: "plain", source: "voices/plain", via: "voice[2]: plain" },
    { layer: "work", name: "house-voice", source: "novels/ice-house/house-voice.md", via: "voice[3]: house-voice.md" },
    { layer: "work", name: "QWEN.md", source: "novels/ice-house/QWEN.md" },
    { layer: "output", name: "RULES.md (novel)", source: "novels/ice-house/outputs/novel/RULES.md" },
  ]);
  expect(receipt["voice_missing"]).toBeUndefined();
});

test("AC1: a prose pack carries the global default under its --voice, and its dry run lists both", async () => {
  const { dir, vault, env } = setup();
  const brief = join(dir, "brief.md");
  writeFileSync(brief, "Tell the route customers the ice comes Tuesdays now.\n");
  const outcome = await proseCore(
    { voice: "plain", brief, context: [], format: undefined, words: undefined, dryRun: true, out: undefined, force: false, draft: undefined, instruction: undefined },
    { cwd: vault, env: { ...env, PABLO_VAULT: vault } },
  );
  expect(outcome.exitCode).toBe(0);
  const pack = outcome.pack as Pack;
  const rules = sliceText(pack, "rules");
  expect(rules.indexOf(GLOBAL_RULE)).toBeGreaterThanOrEqual(0);
  expect(rules.indexOf(GLOBAL_RULE)).toBeLessThan(rules.length - 1);
  expect(sliceText(pack, "exemplars")).toContain(PLAIN_EXEMPLAR);
  const body = outcome.body as unknown as { voiceLayers: { layers: unknown[] } };
  expect(body.voiceLayers.layers).toEqual([
    { layer: "global", name: "default", source: join(dir, "config", "pablo", "voices", "default"), via: "global default" },
    { layer: "vault", name: "plain", source: "voices/plain", via: "--voice" },
  ]);
});
