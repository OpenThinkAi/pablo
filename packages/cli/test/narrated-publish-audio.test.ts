/**
 * `pablo publish --output narrated --target audio` (AGT-2306, pm project `pablo-platform`).
 *
 * AC1: joins every reading's newest mix, in unit order, into `.pablo/out/<slug>-narrated.m4a` with a
 *      configurable gap; refuses, naming the readings, while any is unperformed.
 * AC2: optional chapter markers per reading, titled from the source unit.
 * AC3: fake audio: `ffmpeg` and `ffprobe` are fake scripts first on PATH that record their argv, so
 *      nothing here needs ffmpeg or a model. Runs on a temp copy of the synthetic fixture vault.
 */

import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliArgs } from "../src/cli";
import { chapterMetadata, joinArgs } from "../src/outputs/narrated/audio-join";
import { publishOutput } from "../src/verbs";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
/** The fixture novel has four chapters, so a narrated work has four readings. */
const UNITS = [1, 2, 3, 4];
const dirs: string[] = [];
const savedPath = process.env["PATH"];
afterEach(() => {
  process.env["PATH"] = savedPath;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A work with readings 1..4 (titles from frontmatter); `mixed` lists the units with a mixed render. */
function work(mixed: readonly number[], versions: Record<number, number> = {}): string {
  const vault = join(temp("pablo-narrated-audio-"), "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const dir = join(vault, "novels", "ice-house");
  const marker = JSON.parse(readFileSync(join(dir, "pablo.json"), "utf8")) as Record<string, unknown>;
  delete marker["format"];
  const outputs = { novel: { dir: "chapters", added: "2026-09-01" }, narrated: { added: "2026-10-26", from: "novel" } };
  writeFileSync(join(dir, "pablo.json"), `${JSON.stringify({ ...marker, outputs }, null, 2)}\n`);
  mkdirSync(join(dir, "outputs", "narrated", "readings"), { recursive: true });
  for (const unit of UNITS) {
    const tag = String(unit).padStart(2, "0");
    writeFileSync(join(dir, "outputs", "narrated", "readings", `${tag}-r${unit}.md`), `---\noutput: narrated\nunit: ${unit}\ntitle: Reading Title ${unit}\n---\nCAST: NARRATOR\nNARRATOR: Words of reading ${unit}.\n`);
  }
  for (const unit of mixed) {
    const tag = `ep${String(unit).padStart(2, "0")}`;
    const rdir = join(dir, "outputs", "narrated", "casting", "renders", tag);
    mkdirSync(rdir, { recursive: true });
    for (let v = 1; v <= (versions[unit] ?? 1); v++) {
      writeFileSync(join(rdir, `v${v}.json`), JSON.stringify({ version: v, lines: [], audio: `${tag}.v${v}.m4a` }));
      writeFileSync(join(rdir, `${tag}.v${v}.m4a`), "fake-aac");
    }
  }
  return dir;
}

/** Puts fake ffmpeg/ffprobe first on PATH; returns the file ffmpeg's argv (one JSON line per call) lands in. */
function fakeTools(fail = false): string {
  const bin = temp("pablo-fake-ffmpeg-");
  const log = join(bin, "calls.jsonl");
  const ffmpeg = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${fail ? "echo boom >&2; exit 1" : 'for last; do :; done; echo joined > "$last"'}\n`;
  writeFileSync(join(bin, "ffmpeg"), ffmpeg);
  writeFileSync(join(bin, "ffprobe"), "#!/bin/sh\necho 10.5\n");
  chmodSync(join(bin, "ffmpeg"), 0o755);
  chmodSync(join(bin, "ffprobe"), 0o755);
  process.env["PATH"] = `${bin}:${savedPath}`;
  return log;
}

test("joins every reading's newest mix in unit order into <slug>-narrated.m4a", () => {
  const dir = work(UNITS, { 2: 2 });
  const log = fakeTools();
  const result = publishOutput(dir, "audio", "narrated", { gap: 2 });
  expect(result.exitCode).toBe(0);
  const body = result.body as { where: string; chapters: number; target: string };
  expect(body.target).toBe("audio");
  expect(body.where).toBe(join(dir, ".pablo", "out", "ice-house-narrated.m4a"));
  expect(body.chapters).toBe(4);
  expect(existsSync(body.where)).toBe(true);
  const call = readFileSync(log, "utf8");
  const inputs = [...call.matchAll(/-i (\S+\.m4a)/g)].map((m) => m[1] as string);
  expect(inputs.map((p) => p.slice(p.lastIndexOf("/") + 1))).toEqual(["ep01.v1.m4a", "ep02.v2.m4a", "ep03.v1.m4a", "ep04.v1.m4a"]);
  expect(call).toContain("apad=pad_dur=2");
  expect(call).not.toContain("chapters.ffmetadata");
});

test("refuses, naming the readings, while any is unperformed", () => {
  const dir = work([1]);
  fakeTools();
  const result = publishOutput(dir, "audio", "narrated");
  expect(result.exitCode).toBe(2);
  const message = (result.body as { message: string }).message;
  expect(message).toContain("reading 2 (Reading Title 2)");
  expect(message).toContain("reading 3 (Reading Title 3)");
  expect(message).toContain("reading 4 (Reading Title 4)");
  expect(message).not.toContain("reading 1 (");
  expect(existsSync(join(dir, ".pablo", "out", "ice-house-narrated.m4a"))).toBe(false);
});

test("--chapters writes one chapter per reading titled from its unit", () => {
  const dir = work(UNITS);
  const log = fakeTools();
  const result = publishOutput(dir, "audio", "narrated", { chapters: true });
  expect(result.exitCode).toBe(0);
  expect(readFileSync(log, "utf8")).toContain("-map_chapters 4");
});

test("a failing ffmpeg is a refusal, not a throw", () => {
  const dir = work(UNITS);
  fakeTools(true);
  const out = join(dir, ".pablo", "out", "ice-house-narrated.m4a");
  mkdirSync(join(dir, ".pablo", "out"), { recursive: true });
  writeFileSync(out, "last good");
  const result = publishOutput(dir, "audio", "narrated");
  expect(result.exitCode).toBe(2);
  // The last good file is untouched and no partial is left behind.
  expect(readFileSync(out, "utf8")).toBe("last good");
  expect(existsSync(`${out}.partial.m4a`)).toBe(false);
  expect((result.body as { message: string }).message).toContain("boom");
});

test("script target still works", () => {
  const dir = work([]);
  const result = publishOutput(dir, "script", "narrated");
  expect(result.exitCode).toBe(0);
});

test("chapter metadata starts each chapter after the previous reading and the gap", () => {
  const readings = [
    { unit: 1, title: "One; =", audio: "a" },
    { unit: 2, title: "Two", audio: "b" },
  ];
  const text = chapterMetadata(readings, [10, 5], 1.4);
  expect(text).toContain("START=0\nEND=10000\ntitle=One\\; \\=");
  expect(text).toContain("START=11400\nEND=16400\ntitle=Two");
});

test("the last reading gets no trailing gap", () => {
  const args = joinArgs([{ unit: 1, title: "a", audio: "a.m4a" }, { unit: 2, title: "b", audio: "b.m4a" }], "out.m4a", 1.4).join(" ");
  expect(args).toContain("[0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=pad_dur=1.4[a0]");
  expect(args).toContain("[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a1]");
  expect(args).toContain("concat=n=2:v=0:a=1");
});

test("--gap and --chapters parse on the CLI", () => {
  const parsed = parseCliArgs(["publish", "--project", "x", "--output", "narrated", "--target", "audio", "--gap", "2.5", "--chapters"]);
  expect(parsed.values["gap"]).toBe("2.5");
  expect(parsed.values["chapters"]).toBe(true);
});
