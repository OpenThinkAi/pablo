import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { venvPython } from "../src/casting";
import type { CastingDeps, CastingLayout } from "../src/casting";
import { auditionArgv, castArgv } from "../src/casting-verbs";
import { castMutations, createCastHost } from "../src/mixer-cast-host";
import { createMixerHost, mixerMutations } from "../src/mixer-host";
import { CastPanel } from "../views/mixer-cast";
import { bindMessage, bindableVoices, defaultSlug, initialVoice, lineLabel, reperformOffer } from "../views/mixer-cast-logic";
import { CAST_MUTATIONS } from "../views/mixer-cast-protocol";
import type { CastRole, CastRolesPayload, LibraryVoice } from "../views/mixer-cast-protocol";
import { MUTATIONS } from "../views/mixer-protocol";

/**
 * AGT-2157: the mixer's Cast panel. The host over a fake casting machine (no uv, Python or model: canned bodies that
 * record the argv they were asked), the panel as static markup, and its pure helpers. Every directory is a mkdtemp
 * copy of the synthetic fixture vault; every role and voice is invented.
 */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pablo-mixer-cast-test-"));
  dirs.push(dir);
  return dir;
};

const SCRIPT = ["---", "episode: 1", "title: Invented Episode 1", "---", "", 'CAST: CORA=f "thirties, dry, exact", NED=m "forties, slow, gruff"', "CORA: The ice came in at dawn.", "NED: Then we cut it before noon.", ""].join("\n");

const ROLES: CastRolesPayload = {
  episode: 1,
  performed: true,
  roles: [
    { role: "CORA", gender: "f", description: "thirties, dry, exact", voice: { slug: "cora", cardHash: "h1", by: "manual", at: null, state: "ok" }, lines: [{ i: 0, text: "The ice came in at dawn." }], stale: [] },
    { role: "NED", gender: "m", description: "forties, slow, gruff", voice: { slug: "fenn", cardHash: "h3", by: "manual", at: null, state: "ok" }, lines: [{ i: 1, text: "Then we cut it before noon." }], stale: [1] },
  ],
};

const VOICES: LibraryVoice[] = [
  { slug: "ned", cast: true, hash: "h2", description: "an invented gruff voice", retired: false, auditions: 0 },
  { slug: "cora", cast: true, hash: "h1", description: "an invented dry voice", retired: false, auditions: 0 },
  { slug: "fenn", cast: true, hash: "h3", retired: false, auditions: 2 },
  { slug: "old", cast: true, hash: "h4", retired: true, auditions: 0 },
  { slug: "draft", cast: false, auditions: 3 },
];

interface Machine {
  readonly deps: CastingDeps;
  /** The `python -m pablo_casting ...` argv of each call, without the interpreter. */
  readonly calls: string[][];
  respond: (argv: readonly string[]) => { code: number; body: unknown };
}

function setup(): { m: Machine; vault: string; work: string; candidate: string } {
  const root = temp();
  const source = join(root, "casting");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "pyproject.toml"), '[project]\nname = "pablo-casting"\n', "utf8");
  writeFileSync(join(source, "uv.lock"), "version = 1\n", "utf8");
  const layout: CastingLayout = { source, venv: join(source, ".venv"), install: "checkout" };
  const vault = join(root, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  mkdirSync(join(work, "outputs", "radio", "episodes"), { recursive: true });
  writeFileSync(join(work, "outputs", "radio", "episodes", "01-invented-episode-1.md"), SCRIPT);
  const casting = join(work, "outputs", "radio", "casting");
  mkdirSync(join(casting, "renders", "ep01"), { recursive: true });
  const bound = { slug: "cora", card_hash: "h1", by: "manual", at: "2026-10-10T00:00:00Z" };
  writeFileSync(join(casting, "cast.json"), JSON.stringify({ version: 1, roles: { CORA: bound, NED: { ...bound, slug: "fenn", card_hash: "h3" } } }));
  writeFileSync(join(casting, "renders", "ep01", "v1.json"), JSON.stringify({ version: 1, lines: [] }));
  writeFileSync(join(casting, "flags.json"), JSON.stringify({ flags: [{ id: "f-player-1", episode: 1, line: 0, reason: "flat" }] }));
  const candidate = join(root, "2.wav");
  writeFileSync(candidate, "RIFF-invented-candidate");
  const m: Machine = {
    calls: [],
    respond: () => ({ code: 0, body: { ok: true } }),
    deps: {
      layout,
      which: () => "/fake/bin/uv",
      run: (argv) => {
        if (argv[1] === "sync") {
          mkdirSync(join(layout.venv, "bin"), { recursive: true });
          writeFileSync(venvPython(layout), "", "utf8");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (argv[3] === "pull") return { code: 0, stdout: JSON.stringify({ ok: true, weights: [] }), stderr: "" };
        m.calls.push(argv.slice(3));
        const answer = m.respond(argv.slice(3));
        return { code: answer.code, stdout: JSON.stringify(answer.body), stderr: "" };
      },
      now: () => new Date("2026-10-26T12:00:00Z"),
    },
  };
  return { m, vault, work, candidate };
}

const hostOver = (s: ReturnType<typeof setup>) =>
  createCastHost({ work: s.work, vault: s.vault, env: { PATH: "/nowhere", XDG_STATE_HOME: join(s.vault, "state") }, casting: s.m.deps, now: () => new Date("2026-10-26T12:00:00Z") });

const valueOf = (argv: readonly string[], name: string): string | undefined => argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);

describe("the host (AC1, AC3: the casting verbs' own functions)", () => {
  test("castRoles reads the episode's roles through castpanel roles, naming the vault", () => {
    const s = setup();
    s.m.respond = () => ({ code: 0, body: { ok: true, ...ROLES } });
    const roles = hostOver(s).castRoles({ episode: 1 });
    expect(roles.roles.map((r) => r.role)).toEqual(["CORA", "NED"]);
    expect(roles.performed).toBe(true);
    expect(s.m.calls[0]?.slice(0, 4)).toEqual(["castpanel", "roles", "--episode", "1"]);
    expect(s.m.calls[0]).toContain(`--vault=${s.vault}`);
    expect(s.m.calls[0]).toContain("--work");
    expect(() => hostOver(s).castRoles({ episode: 0 })).toThrow("episode must be a whole number");
  });

  test("listVoices is the voices verb's list; describeVoice is describe_voice", async () => {
    const s = setup();
    s.m.respond = (argv) =>
      argv[0] === "voices" ? { code: 0, body: { ok: true, voices: VOICES } } : { code: 0, body: { ok: true, traits: { gender: "m", age: "40s" }, freeText: ["smells of the sea"], instruct: "a man in his forties" } };
    const host = hostOver(s);
    expect((await host.listVoices({})).voices.map((v) => v.slug)).toEqual(VOICES.map((v) => v.slug));
    expect(s.m.calls[0]?.slice(0, 2)).toEqual(["voices", "list"]);
    const described = await host.describeVoice({ describe: "forties, smells of the sea", gender: "m", role: "NED" });
    expect(described.freeText).toEqual(["smells of the sea"]);
    expect(s.m.calls[1]?.[0]).toBe("describe");
    expect(valueOf(s.m.calls[1] ?? [], "--describe")).toBe("forties, smells of the sea");
    await expect(host.describeVoice({ describe: "x", gender: "q" })).rejects.toThrow("gender");
  });

  test("previewVoice reads one line in a library voice through castpanel preview", async () => {
    const s = setup();
    s.m.respond = () => ({ code: 0, body: { ok: true, role: "NED", text: "Then we cut it before noon.", b64: "UklGRg==", seconds: 1.2 } });
    const preview = await hostOver(s).previewVoice({ episode: 1, line: 1, voice: "ned" });
    expect(preview).toMatchObject({ role: "NED", voice: "ned", line: 1, mime: "audio/wav", b64: "UklGRg==" });
    expect(s.m.calls[0]?.slice(0, 8)).toEqual(["castpanel", "preview", "--episode", "1", "--line", "1", "--voice", "ned"]);
    await expect(hostOver(s).previewVoice({ episode: 1, line: 1, voice: "../etc" })).rejects.toThrow("voice slug");
  });

  test("auditionVoices runs the audition verb's argv; candidateAudio plays only what it named", async () => {
    const s = setup();
    s.m.respond = () => ({
      code: 0,
      body: { ok: true, slug: "ned", candidates: [{ candidate: 2, file: s.candidate, seconds: 9.5, reference_ok: true, near_duplicates: [], scores: { utmos: 4.1 } }], message: "1 candidate for NED" },
    });
    const host = hostOver(s);
    const auditioned = await host.auditionVoices({ role: "ned", describe: "a man in his forties, gruff and slow", n: 1 });
    expect(auditioned.candidates).toEqual([{ candidate: 2, seconds: 9.5, referenceOk: true, nearDuplicates: [], utmos: 4.1 }]);
    const expected = auditionArgv({ role: "NED", describe: "a man in his forties, gruff and slow", slug: "ned", n: 1 });
    expect(s.m.calls[0]?.slice(0, expected.length)).toEqual(expected);
    expect(host.candidateAudio({ slug: "ned", candidate: 2 }).b64).toBe(Buffer.from("RIFF-invented-candidate").toString("base64"));
    expect(() => host.candidateAudio({ slug: "ned", candidate: 3 })).toThrow("not from this window's audition");
    expect(() => host.candidateAudio({ slug: "cora", candidate: 2 })).toThrow("not from this window's audition");
  });

  test("castCandidate runs the cast verb's argv; a refusal comes back in its own words", async () => {
    const s = setup();
    s.m.respond = () => ({ code: 0, body: { ok: true, slug: "ned", hash: "h9", message: "cast ned from candidate 2" } });
    const made = await hostOver(s).castCandidate({ role: "NED", candidate: 2, slug: "ned", recast: true });
    expect(made).toEqual({ slug: "ned", hash: "h9", message: "cast ned from candidate 2" });
    const expected = castArgv({ role: "NED", candidate: 2, recast: true, slug: "ned" });
    expect(s.m.calls[0]?.slice(0, expected.length)).toEqual(expected);
    s.m.respond = () => ({ code: 2, body: { ok: false, code: 2, message: "ned already has a card; pass --recast" } });
    await expect(hostOver(s).castCandidate({ role: "NED", candidate: 2 })).rejects.toThrow("ned already has a card");
  });
});

describe("rebinding (AC1, AC2)", () => {
  test("bindVoice runs the bind verb and offers the role's lines performed in the old voice", async () => {
    const s = setup();
    s.m.respond = (argv) =>
      argv[0] === "bind" ? { code: 0, body: { ok: true, role: "NED", slug: "fenn", cardHash: "h3", replaced: "ned" } } : { code: 0, body: { ok: true, ...ROLES } };
    const bound = await hostOver(s).bindVoice({ episode: 1, role: "ned", voice: "fenn" });
    expect(bound).toMatchObject({ role: "NED", slug: "fenn", replaced: "ned", reperform: [1] });
    expect(s.m.calls[0]?.slice(0, 5)).toEqual(["bind", "--role", "NED", "--voice", "fenn"]);
    expect(bindMessage(bound)).toBe("NED is bound to fenn (was ned) in every episode.");
  });

  test("reperformRole flags exactly the stale lines and runs the fix verb on them", async () => {
    const s = setup();
    let flagsAtFix: unknown;
    s.m.respond = (argv) => {
      if (argv[0] === "fix") {
        flagsAtFix = JSON.parse(readFileSync(join(s.work, "outputs", "radio", "casting", "flags.json"), "utf8"));
        return { code: 0, body: { ok: true, version: 2, changedLines: [1] } };
      }
      return { code: 0, body: { ok: true, ...ROLES } };
    };
    const done = await hostOver(s).reperformRole({ episode: 1, role: "NED" });
    expect(done).toMatchObject({ episode: 1, role: "NED", lines: [1], version: 2 });
    expect(done.message).toBe("re-performed 1 line of NED in fenn (manifest v2) and remixed the episode");
    const fix = s.m.calls.find((c) => c[0] === "fix") ?? [];
    expect(fix).toContain("--episode=1");
    expect(fix).toContain("--json-lines");
    const flags = (flagsAtFix as { flags: Record<string, unknown>[] }).flags;
    expect(flags.map((f) => [f["line"], f["by"]])).toEqual([
      [0, undefined],
      [1, "mixer"],
    ]);
    expect(flags[1]).toMatchObject({ episode: 1, reason: "other", source: "human", note: "recast NED to fenn" });
  });

  test("a refused fix puts flags.json back as it was", async () => {
    const s = setup();
    const file = join(s.work, "outputs", "radio", "casting", "flags.json");
    const before = JSON.parse(readFileSync(file, "utf8"));
    s.m.respond = (argv) => (argv[0] === "fix" ? { code: 2, body: { ok: false, code: 2, message: "the cast changed since v1" } } : { code: 0, body: { ok: true, ...ROLES } });
    await expect(hostOver(s).reperformRole({ episode: 1, role: "NED" })).rejects.toThrow("the cast changed since v1");
    expect(JSON.parse(readFileSync(file, "utf8")).flags).toEqual(before.flags);
  });

  test("a role with nothing performed in another voice has nothing to re-perform", async () => {
    const s = setup();
    s.m.respond = () => ({ code: 0, body: { ok: true, ...ROLES } });
    await expect(hostOver(s).reperformRole({ episode: 1, role: "CORA" })).rejects.toThrow("nothing to re-perform");
    expect(s.m.calls.some((c) => c[0] === "fix")).toBe(false);
    expect(existsSync(join(s.work, "outputs", "radio", "casting", "flags.json"))).toBe(true);
  });
});

describe("the mixer registers the panel", () => {
  test("every Cast mutation is a mixer mutation with a handler", () => {
    const s = setup();
    for (const name of CAST_MUTATIONS) expect(MUTATIONS as readonly string[]).toContain(name);
    const handlers = mixerMutations(createMixerHost({ work: s.work, vault: s.vault, env: { PATH: "/nowhere" }, casting: s.m.deps }));
    expect(Object.keys(handlers).sort()).toEqual([...MUTATIONS].sort());
    expect(Object.keys(castMutations(hostOver(s))).sort()).toEqual([...CAST_MUTATIONS].sort());
  });
});

describe("the panel", () => {
  const noMutate = (async () => undefined) as never;

  test("each role shows its description, its bound voice, the library's bindable voices and its lines", () => {
    const html = renderToStaticMarkup(<CastPanel mutate={noMutate} episode={1} onClose={() => undefined} preloaded={{ roles: ROLES, voices: VOICES }} />);
    expect(html).toContain("Cast · episode 1");
    expect(html).toContain(">CORA<");
    expect(html).toContain("thirties, dry, exact");
    expect(html).toContain("cora · manual");
    expect(html).toContain("1. The ice came in at dawn.");
    expect(html).toContain(">ned — an invented gruff voice<");
    expect(html).not.toContain(">old"); // retired
    expect(html).not.toContain(">draft"); // no card yet
    expect((html.match(/>Hear</g) ?? []).length).toBe(2);
    expect((html.match(/>Bind</g) ?? []).length).toBe(2);
    expect((html.match(/Design a new voice/g) ?? []).length).toBe(2);
  });

  test("a role performed in another voice offers the re-perform", () => {
    const html = renderToStaticMarkup(<CastPanel mutate={noMutate} episode={1} onClose={() => undefined} preloaded={{ roles: ROLES, voices: VOICES }} />);
    expect(html).toContain("1 line of NED was performed in another voice than fenn. Re-perform it?");
    expect(html).toContain(">Re-perform 1<");
    expect((html.match(/Re-perform 1/g) ?? []).length).toBe(1);
  });

  test("with unsaved mix edits the re-perform waits for a save", () => {
    const html = renderToStaticMarkup(<CastPanel mutate={noMutate} episode={1} onClose={() => undefined} locked preloaded={{ roles: ROLES, voices: VOICES }} />);
    expect(html).toMatch(/<button[^>]*disabled[^>]*title="Save your mix edits first[^"]*"[^>]*>Re-perform 1<\/button>/);
  });

  test("before the host answers it says it is reading the cast", () => {
    const html = renderToStaticMarkup(<CastPanel mutate={noMutate} episode={2} onClose={() => undefined} />);
    expect(html).toContain("Reading the episode&#x27;s cast");
  });
});

describe("helpers", () => {
  const ned = ROLES.roles[1] as CastRole;
  test("bindable voices are cast and not retired, by slug; the picker starts on the bound voice", () => {
    const bindable = bindableVoices(VOICES);
    expect(bindable.map((v) => v.slug)).toEqual(["cora", "fenn", "ned"]);
    expect(initialVoice(ned, bindable)).toBe("fenn");
    expect(initialVoice({ ...ned, voice: null }, bindable)).toBe("cora");
  });
  test("offers, slugs and labels", () => {
    expect(reperformOffer({ ...ned, stale: [] })).toBeNull();
    expect(reperformOffer({ ...ned, voice: null })).toBeNull();
    expect(reperformOffer({ ...ned, stale: [1, 3] })).toBe("2 lines of NED were performed in another voice than fenn. Re-perform them?");
    expect(defaultSlug("OLD TOM")).toBe("old-tom");
    expect(lineLabel(4, "a".repeat(60), 10)).toBe("5. aaaaaaaaa…");
  });
});
