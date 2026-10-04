import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MountOptions, View } from "@openthink/ui-leaf";
import { cachedRoundDir, readCachedRound } from "../src/read";
import type { CachedRound } from "../src/read";
import { NO_CHROME_MESSAGE, createReaderHost, findChrome, openReader, readerMutations } from "../src/reader-host";
import type { RunResult, Runner } from "../src/share";
import { marksPath, readSent, sentPath } from "../src/submit";
import { parseCliArgs, runReadView } from "../src/cli";
import { readerActive } from "../src/tray/activity";
import type { ReaderData, ReviewDraft } from "../views/reader-protocol";

/**
 * AGT-1586: the reader window's host side. The window is a fake `mount` (nothing opens, no Chrome, no ui-leaf
 * binary), `gh` is a fake Runner (nothing reaches GitHub), and the round cache is a temp XDG_STATE_HOME. The
 * view's calls are made straight at the mutation handlers the host registers, which is the whole wire protocol.
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pablo-reader-host-test-"));
  dirs.push(dir);
  return dir;
};

const REPO = "OpenThinkAi/ice-house-reading";
const PATH = "novels/ice-house/chapters/03-the-thaw.md";
const PATH4 = "novels/ice-house/chapters/04-the-flood.md";
const SHA = "a".repeat(40);
const TEXT: Record<string, string> = {
  [PATH]: '---\nchapter: 3\ntitle: "The Thaw"\n---\n\n# The Thaw\n\nIce gave way by March.\nThe river rose.\n\nShe watched it go.\n',
  [PATH4]: "---\nchapter: 4\n---\n\nThe flood came.\n",
};
// PATH file lines: 1 ---, 2 chapter, 3 title, 4 ---, 5 blank, 6 "# The Thaw", 7 blank, 8 "Ice gave way by March.",
// 9 "The river rose.", 10 blank, 11 "She watched it go."  Paragraphs: 0 heading, 1 "Ice gave way by March. The river rose.", 2 "She watched it go."

const ROUND: CachedRound = {
  repo: REPO,
  pr: 7,
  id: "atara-2026-10-02",
  title: "Ice House: chapters 3-4",
  prUrl: `https://github.com/${REPO}/pull/7`,
  commit: SHA,
  sender: "matt",
  chapters: [
    { number: 3, path: PATH },
    { number: 4, path: PATH4 },
  ],
  fetchedAt: "2026-10-02T10:00:00Z",
};

/** A round cache dir holding the chapters, as `fetchRound` leaves it. */
function cacheDir(): string {
  const dir = join(temp(), "round");
  for (const [path, text] of Object.entries(TEXT)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

interface Call {
  args: readonly string[];
  body: unknown;
}
function fakeGh(answers: (call: Call) => Partial<RunResult> = () => ({})): { run: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const run: Runner = (command, args, options) => {
    expect(command).toBe("gh");
    const call = { args, body: options?.input === undefined ? undefined : JSON.parse(options.input) };
    calls.push(call);
    return { code: 0, stdout: JSON.stringify({ id: 99, node_id: "PRR_1", html_url: "https://github.com/x/y/pull/7#pullrequestreview-99" }), stderr: "", ...answers(call) };
  };
  return { run, calls };
}

const sel = (p: number, a: number, b: number) => ({ start: { paragraph: p, offset: a }, end: { paragraph: p, offset: b } });
const DRAFT: ReviewDraft = {
  summary: "Loved it.",
  marks: [
    { kind: "comment", path: PATH, selection: sel(1, 0, 4), tag: "keep", body: "the opening" },
    { kind: "suggestion", path: PATH, selection: sel(1, 23, 38), replacement: "The river climbed." },
    { kind: "chapter", path: PATH4, tag: "fix", body: "too short" },
  ],
};

function host(run: Runner, dir = cacheDir()) {
  return { dir, host: createReaderHost({ round: ROUND, dir, run, now: () => new Date("2026-10-02T12:00:00Z") }) };
}

test("data: chapters as plain paragraphs with their titles, no sentence lines, frontmatter or paths of lines", () => {
  const { host: h } = host(fakeGh().run);
  const data = h.data();
  expect(data.round).toEqual({ ref: `${REPO}#7`, title: ROUND.title, sender: "matt", id: ROUND.id });
  expect(data.chapters.map((c) => [c.number, c.title])).toEqual([[3, "The Thaw"], [4, ""]]); // no title: the view says "Chapter 4"
  expect(data.chapters[0]?.paragraphs).toEqual([
    { text: "# The Thaw", prose: false },
    { text: "Ice gave way by March. The river rose.", prose: true },
    { text: "She watched it go.", prose: true },
  ]);
  expect(JSON.stringify(data)).not.toContain("chapter: 3"); // frontmatter is hidden
  expect(data.draft).toEqual({ summary: "", marks: [] });
  expect(data.sent).toBeUndefined();
});

test("saveDraft writes the marks to <id>.marks.json, and a reopened window gets them back", () => {
  const { run, calls } = fakeGh();
  const { host: h, dir } = host(run);
  expect(h.saveDraft({ draft: DRAFT })).toEqual({ ok: true });
  expect(JSON.parse(readFileSync(marksPath(dir, ROUND.id), "utf8"))).toEqual(DRAFT);
  expect(calls).toHaveLength(0); // saving never touches GitHub
  const reopened = createReaderHost({ round: ROUND, dir, run }).data();
  expect(reopened.draft).toEqual(DRAFT);
});

test("saveDraft refuses marks that do not fit the round, and writes nothing", () => {
  const { host: h, dir } = host(fakeGh().run);
  const wrongChapter = h.saveDraft({ draft: { summary: "", marks: [{ kind: "comment", path: "novels/other/chapters/01-x.md", selection: sel(0, 0, 1), body: "x" }] } });
  expect(wrongChapter.ok).toBe(false);
  const pastTheEnd = h.saveDraft({ draft: { summary: "", marks: [{ kind: "comment", path: PATH, selection: sel(9, 0, 1), body: "x" }] } });
  expect(pastTheEnd.ok).toBe(false);
  const malformed = h.saveDraft({ draft: { summary: "", marks: [{ kind: "nope", path: PATH }] } });
  expect(malformed.ok).toBe(false);
  expect(h.saveDraft(undefined).ok).toBe(false);
  expect(existsSync(marksPath(dir, ROUND.id))).toBe(false);
});

test("a corrupt marks file is ignored, never trusted", () => {
  const { dir } = host(fakeGh().run);
  writeFileSync(marksPath(dir, ROUND.id), '{"summary": 5, "marks": [{"kind": "x"}]}');
  expect(createReaderHost({ round: ROUND, dir, run: fakeGh().run }).data().draft).toEqual({ summary: "", marks: [] });
});

test("submit sends ONE review through submit.ts, records the round as sent, and the window is read-only after", () => {
  const { run, calls } = fakeGh((call) => {
    if (call.args.includes("graphql")) return { stdout: '{"data":{}}' };
    if (call.args.some((a) => a.endsWith("/events"))) return { stdout: JSON.stringify({ html_url: "https://github.com/x/y/pull/7#pullrequestreview-99" }) };
    return {};
  });
  const { host: h, dir } = host(run);
  const answer = h.submit({ draft: DRAFT });
  expect(answer).toEqual({ ok: true, sent: { reviewUrl: "https://github.com/x/y/pull/7#pullrequestreview-99", sentAt: "2026-10-02T12:00:00.000Z" } });
  // The review is pinned to the round's commit and carries the line comments, as submit.ts builds them from the marks.
  const created = calls[0]?.body as { commit_id: string; body: string; event?: string; comments: { path: string; line: number; body: string }[] };
  expect(created.commit_id).toBe(SHA);
  expect(created.body).toBe("Loved it.");
  expect(created.comments.map((c) => [c.path, c.line, c.body])).toEqual([
    [PATH, 8, "**[keep]** the opening"],
    [PATH, 9, "```suggestion\nThe river climbed.\n```"],
  ]);
  expect(created.event).toBeUndefined(); // a chapter comment is pending until the GraphQL thread is added
  expect(calls.filter((c) => c.args.includes("graphql"))).toHaveLength(1);
  expect(readSent(dir, ROUND.id)?.reviewId).toBe(99);

  const after = h.data();
  expect(after.sent).toEqual({ reviewUrl: "https://github.com/x/y/pull/7#pullrequestreview-99", sentAt: "2026-10-02T12:00:00.000Z" });
  expect(after.draft).toEqual(DRAFT); // the marks stay on screen
  const n = calls.length;
  expect(h.saveDraft({ draft: DRAFT }).ok).toBe(false);
  expect(h.submit({ draft: DRAFT }).ok).toBe(false);
  expect(calls).toHaveLength(n); // refused without a call
});

test("submit failures are plain words and keep the marks; an empty round is refused before any call", () => {
  const down = fakeGh(() => ({ code: 1, stdout: "", stderr: "gh: HTTP 401" }));
  const { host: h, dir } = host(down.run);
  const answer = h.submit({ draft: DRAFT });
  expect(answer.ok).toBe(false);
  if (!answer.ok) {
    expect(answer.message).toContain("gh auth login");
    expect(answer.message).not.toContain("pablo: submit:");
  }
  expect(JSON.parse(readFileSync(marksPath(dir, ROUND.id), "utf8"))).toEqual(DRAFT); // saved before the network call
  expect(existsSync(sentPath(dir, ROUND.id))).toBe(false);

  const quiet = fakeGh();
  const { host: h2 } = host(quiet.run);
  const nothing = h2.submit({ draft: { summary: "", marks: [] } });
  expect(nothing.ok).toBe(false);
  expect(quiet.calls).toHaveLength(0);
});

test("the window can call exactly saveDraft and submit", async () => {
  const { host: h } = host(fakeGh().run);
  const mutations = readerMutations(h);
  expect(Object.keys(mutations).sort()).toEqual(["saveDraft", "submit"]);
  expect(await mutations["saveDraft"]?.({ draft: DRAFT })).toEqual({ ok: true });
});

test("a chapter path that is not a chapter file is refused when the host opens", () => {
  const dir = cacheDir();
  expect(() => createReaderHost({ round: { ...ROUND, chapters: [{ number: 1, path: "../../etc/passwd" }] }, dir, run: fakeGh().run })).toThrow(/not a chapter path/);
});

// --- opening the window ----------------------------------------------------------------------------------

/** gh answers for `fetchRound`: an open PR in the reading repo with one chapter. */
function fetchGh(): Runner {
  return (_command, args) => {
    const endpoint = args[args.indexOf("GET") + 1] as string;
    if (/\/pulls\/7$/.test(endpoint)) return { code: 0, stderr: "", stdout: JSON.stringify({ state: "open", title: ROUND.title, html_url: ROUND.prUrl, user: { login: "matt" }, head: { sha: SHA, ref: "round/atara-2026-10-02", repo: { full_name: REPO } } }) };
    if (endpoint.endsWith("/pulls/7/files")) return { code: 0, stderr: "", stdout: JSON.stringify([{ filename: PATH }]) };
    if (endpoint.includes("/contents/")) return { code: 0, stderr: "", stdout: TEXT[PATH] as string };
    return { code: 1, stdout: "", stderr: `unexpected ${endpoint}` };
  };
}

interface FakeView {
  view: View;
  disconnect: () => void;
  reconnect: () => void;
  close: () => void;
  closedCalls: number;
}
function fakeView(): FakeView {
  let onDisconnect: () => void = () => {};
  let onReconnect: () => void = () => {};
  let resolveClosed: (v: { reason: string }) => void = () => {};
  const state: FakeView = {
    closedCalls: 0,
    disconnect: () => onDisconnect(),
    reconnect: () => onReconnect(),
    close: () => resolveClosed({ reason: "test" }),
    view: {
      url: "http://127.0.0.1:5555/",
      id: "v1",
      port: 5555,
      onDisconnect: (h: () => void) => void (onDisconnect = h),
      onReconnect: (h: () => void) => void (onReconnect = h),
      onError: () => {},
      closed: new Promise((res) => void (resolveClosed = res)),
      close: async () => {
        state.closedCalls++;
        resolveClosed({ reason: "close" });
      },
    } as unknown as View,
  };
  return state;
}

test("findChrome probes the Chromium-family paths", () => {
  expect(findChrome(() => false)).toBeUndefined();
  expect(findChrome((p) => p.includes("Brave"))).toContain("Brave");
});

test("openReader without Chrome refuses plainly, before fetching or mounting anything", async () => {
  let mounted = 0;
  const gh = fakeGh();
  const out = await openReader({ repo: REPO, pr: 7 }, undefined, { run: gh.run, env: { XDG_STATE_HOME: temp() }, existsExecutable: () => false, mount: async () => (mounted++, fakeView().view) });
  expect(out).toEqual({ ok: false, code: 2, message: NO_CHROME_MESSAGE });
  expect(NO_CHROME_MESSAGE).toContain("Google Chrome");
  expect(mounted).toBe(0);
  expect(gh.calls).toHaveLength(0);
});

test("openReader fetches the round, mounts the reader view with the host's data and only its two mutations", async () => {
  const env = { XDG_STATE_HOME: temp() };
  const fake = fakeView();
  let options: MountOptions | undefined;
  const out = await openReader({ repo: REPO, pr: 7 }, undefined, {
    run: fetchGh(),
    env,
    existsExecutable: () => true,
    binaryPath: () => "/fake/ui-leaf-bin",
    mount: async (o) => ((options = o), fake.view),
  });
  expect(out.ok).toBe(true);
  expect(readCachedRound({ repo: REPO, pr: 7 }, env)?.commit).toBe(SHA);
  expect(options).toMatchObject({ view: "reader", shell: "app", port: 0, silent: true, binaryPath: "/fake/ui-leaf-bin", heartbeatTimeoutMs: 70_000 });
  expect(existsSync(join(options?.viewsRoot ?? "", "reader.tsx"))).toBe(true); // the views root ships the view
  expect(Object.keys(options?.mutations ?? {}).sort()).toEqual(["saveDraft", "submit"]);
  const data = options?.data as ReaderData;
  expect(data.chapters[0]?.title).toBe("The Thaw");
  expect(data.round.ref).toBe(`${REPO}#7`);
  // The view's saveDraft lands in the round's cache dir.
  expect(await options?.mutations?.["saveDraft"]?.({ draft: { summary: "hi", marks: [] } })).toEqual({ ok: true });
  expect(JSON.parse(readFileSync(marksPath(cachedRoundDir({ repo: REPO, pr: 7 }, env), ROUND.id), "utf8")).summary).toBe("hi");
});

test("a disconnected window is closed after the grace period unless it comes back", async () => {
  const fake = fakeView();
  const out = await openReader({ repo: REPO, pr: 7 }, undefined, { run: fetchGh(), env: { XDG_STATE_HOME: temp() }, existsExecutable: () => true, binaryPath: () => undefined, mount: async () => fake.view });
  expect(out.ok).toBe(true);
  fake.disconnect();
  fake.reconnect(); // back before the grace ran out: the timer is cancelled
  await new Promise((r) => setTimeout(r, 20));
  expect(fake.closedCalls).toBe(0);
  fake.close();
  if (out.ok) await out.closed;
});

test("openReader reports a refused round and a window that would not open", async () => {
  const closedPr: Runner = (c, a, o) => {
    const r = fetchGh()(c, a, o);
    return a.some((x) => x.endsWith("/pulls/7")) ? { ...r, stdout: JSON.stringify({ ...JSON.parse(r.stdout), state: "closed" }) } : r;
  };
  const refused = await openReader({ repo: REPO, pr: 7 }, undefined, { run: closedPr, env: { XDG_STATE_HOME: temp() }, existsExecutable: () => true, mount: async () => fakeView().view });
  expect(refused).toMatchObject({ ok: false, code: 2 });
  const broken = await openReader({ repo: REPO, pr: 7 }, undefined, {
    run: fetchGh(),
    env: { XDG_STATE_HOME: temp() },
    existsExecutable: () => true,
    mount: async () => {
      throw new Error("no ui-leaf binary");
    },
  });
  expect(broken).toMatchObject({ ok: false, code: 1 });
  if (!broken.ok) expect(broken.message).toContain("no ui-leaf binary");
});

test("pablo read <round> opens the window and holds until it closes; a bad ref is refused; --no-open is parsed", async () => {
  const fake = fakeView();
  const asked: string[] = [];
  const done = runReadView(parseCliArgs(["read", `${REPO.split("/")[1]}#7`]), async (ref) => {
    asked.push(`${ref.repo}#${ref.pr}`);
    return { ok: true, view: fake.view, closed: fake.view.closed.then(() => {}) };
  });
  await new Promise((r) => setTimeout(r, 10));
  fake.close();
  expect(await done).toBe(0);
  expect(asked).toEqual([`${REPO}#7`]);
  expect(await runReadView(parseCliArgs(["read", "not-a-round"]), async () => ({ ok: false, code: 1, message: "x" }))).toBe(2);
  expect(await runReadView(parseCliArgs(["read", `${REPO.split("/")[1]}#7`]), async () => ({ ok: false, code: 2, message: NO_CHROME_MESSAGE }))).toBe(2);
  expect(parseCliArgs(["read", "x-reading#7", "--no-open"]).noOpen).toBe(true);
  expect(parseCliArgs(["read", "x-reading#7"]).noOpen).toBe(false);
});

test("an open reader window marks the reader active for the tray's updater (AGT-1598), and the mark goes when it closes or never opens", async () => {
  const env = { XDG_STATE_HOME: temp() };
  const fake = fakeView();
  const deps = { run: fetchGh(), env, existsExecutable: () => true, binaryPath: () => undefined };
  expect(readerActive(env)).toBe(false);
  const out = await openReader({ repo: REPO, pr: 7 }, undefined, { ...deps, mount: async () => fake.view });
  expect(out.ok).toBe(true);
  expect(readerActive(env)).toBe(true);
  fake.close();
  if (out.ok) await out.closed;
  expect(readerActive(env)).toBe(false);

  await openReader({ repo: REPO, pr: 7 }, undefined, {
    ...deps,
    mount: async () => {
      throw new Error("no ui-leaf binary");
    },
  });
  expect(readerActive(env)).toBe(false);
});
