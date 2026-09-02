import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import {
  createProviders,
  CRITICMARKUP_EDIT_CLOSING,
  parse,
  parseConfig,
  receiptsPath,
  TOOL_EDIT_CLOSING,
  type Providers,
} from "@openthink/pablo-core";
// One fake endpoint for the whole repo. It is the core adapter tests' server —
// SSE `chat/completions` on a random free port — and duplicating it here would
// mean two things to keep honest. **No test in pablo talks to the real local
// writer on :8002**: it is a shared, one-prompt-at-a-time server.
import { startFakeEndpoint, type FakeEndpoint } from "../../core/test/fake-endpoint";
import { openView, type ViewHandle } from "../src/view";

/**
 * The span verbs through the real renderer and a real HTTP endpoint (AGT-1204).
 *
 * Everything is torn down in `afterEach` — a leaked renderer or a leaked server
 * holds the process open — and every view runs with `watch: false` so a
 * re-render is something a verb caused rather than something the filesystem did.
 */

const directories: string[] = [];
const open: ViewHandle[] = [];
const renderers: TestRendererSetup[] = [];
const endpoints: FakeEndpoint[] = [];

afterEach(async () => {
  // Stop the views before the renderers: a run still unwinding would otherwise
  // draw into a destroyed buffer.
  const closing = open.map((handle) => {
    handle.stop();
    return handle.closed;
  });
  open.length = 0;
  await Promise.all(closing);
  while (renderers.length > 0) renderers.pop()?.renderer.destroy();
  while (endpoints.length > 0) endpoints.pop()?.stop();
  while (directories.length > 0) rmSync(directories.pop() ?? "", { recursive: true, force: true });
});

const FIRST = "The cellar was cold in a way the house never was.";
const CHAPTER = `# Twenty-Six

${FIRST}

She counted the barrels twice. There were nineteen.

The lamp guttered once and held.
`;

interface Workspace {
  readonly root: string;
  readonly path: string;
  text(): string;
}

/** A writing vault in a temp directory: `style/`, a work with its own rules, a chapter. */
function workspace(text = CHAPTER): Workspace {
  const root = mkdtempSync(join(tmpdir(), "pablo-verbs-"));
  directories.push(root);
  mkdirSync(join(root, "style"), { recursive: true });
  writeFileSync(join(root, "style", "prose.md"), "Straight quotes, never curly. No em-dashes.\n", "utf8");

  const work = join(root, "novels", "valleys-shadow");
  mkdirSync(join(work, "chapters"), { recursive: true });
  writeFileSync(join(work, "QWEN.md"), "# The Valley's Shadow\n\nNothing after 1919.\n", "utf8");

  const path = join(work, "chapters", "26-the-cellar.md");
  writeFileSync(path, text, "utf8");
  return { root, path, text: () => readFileSync(path, "utf8") };
}

function providersFor(endpoint: FakeEndpoint): Providers {
  return createProviders(
    parseConfig(
      JSON.stringify({
        default: "local",
        providers: { local: { endpoint: endpoint.url, model: "fake-writer", local: true, timeoutMs: 200 } },
      }),
      "the test config",
    ),
  );
}

async function view(
  space: Workspace,
  endpoint?: FakeEndpoint,
  size = { width: 100, height: 16 },
): Promise<[ViewHandle, TestRendererSetup]> {
  const setup = await createTestRenderer(size);
  renderers.push(setup);
  const handle = await openView(space.path, {
    renderer: setup.renderer,
    watch: false,
    // No test here spawns `think`. The one test that is about the brief passes
    // its own fake spawner; every other one wants no child process at all.
    brief: false,
    timeoutFloorMs: 150,
    ...(endpoint === undefined ? {} : { providers: providersFor(endpoint) }),
  });
  open.push(handle);
  await setup.renderOnce();
  // The view opens on the first block, which is the heading; every verb here
  // wants the first paragraph of prose under it.
  setup.mockInput.pressKey("n");
  return [handle, setup];
}

/**
 * Poll for something the renderer's own frame pacing does not drive: a socket,
 * a child process, or a bare `esc` — which the terminal parser has to hold for
 * a moment in case it turns out to be the start of a CSI sequence.
 */
async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the view to catch up");
    await Bun.sleep(5);
  }
}

/** Open the prompt field, type an instruction, send it. */
async function prompt(handle: ViewHandle, setup: TestRendererSetup, instruction: string): Promise<void> {
  setup.mockInput.pressKey(">");
  await setup.mockInput.typeText(instruction);
  setup.mockInput.pressEnter();
}

// --------------------------------------------------------------------- AC1

test("`>` prompts, and the answer lands as a substitution the app wrote (AC1)", async () => {
  const endpoint = startFakeEndpoint({ tokens: ["The cellar ", "held ", "its own cold."], gapMs: 1 });
  endpoints.push(endpoint);
  const space = workspace();
  const [handle, setup] = await view(space, endpoint);

  setup.mockInput.pressKey(">");
  expect(handle.state().field?.kind).toBe("prompt");

  await setup.mockInput.typeText("tighten");
  setup.mockInput.pressEnter();
  await handle.idle();

  expect(space.text()).toContain(`{~~${FIRST}~>The cellar held its own cold.~~}`);
  // Nothing was applied: the old text is still in the file, waiting for review.
  expect(space.text()).toContain(FIRST);
  expect(parse(space.text()).violations).toEqual([]);
  expect(handle.state().doc.text).toBe(space.text());
  expect(handle.state().field).toBeUndefined();
});

test("the pack the model was sent carries the style rules and the work's rules (AC1, AC7)", async () => {
  const endpoint = startFakeEndpoint({ tokens: ["Colder."], gapMs: 1 });
  endpoints.push(endpoint);
  const [handle, setup] = await view(workspace(), endpoint);

  await prompt(handle, setup, "tighten");
  await handle.idle();

  const body = endpoint.requests[0]?.body as { messages?: { content?: string }[] };
  const sent = String(body.messages?.[0]?.content);
  expect(sent).toContain("Straight quotes, never curly.");
  expect(sent).toContain("Nothing after 1919.");
  expect(sent).toContain(`# The passage\n\n${FIRST}`);
  expect(sent).toContain("tighten");
});

test("a real instruction is typed whole: spaces, hyphens and punctuation (AC1)", async () => {
  const endpoint = startFakeEndpoint({ tokens: ["Colder."], gapMs: 1 });
  endpoints.push(endpoint);
  const [handle, setup] = await view(workspace(), endpoint);

  // Every character goes through the same key path a terminal drives, which is
  // the point: an instruction is mostly the characters between the words.
  const instruction = "cut this by a third, and keep the well-lit half";
  await prompt(handle, setup, instruction);
  await handle.idle();

  expect(handle.state().receipt).not.toBe("");
  const body = endpoint.requests[0]?.body as { messages?: { content?: string }[] };
  expect(String(body.messages?.[0]?.content)).toContain(`# What to do to it\n\n${instruction}`);
});

test("a zero-width selection prompts into an addition, not a substitution (AC1)", async () => {
  const endpoint = startFakeEndpoint({ tokens: ["The door stood open."], gapMs: 1 });
  endpoints.push(endpoint);
  const space = workspace();
  const [handle, setup] = await view(space, endpoint);

  setup.mockInput.pressKey("i");
  expect(handle.state().selection.span.start).toBe(handle.state().selection.span.end);

  await prompt(handle, setup, "draft the next beat");
  await handle.idle();

  expect(space.text()).toContain("{++The door stood open.++}");
  expect(parse(space.text()).violations).toEqual([]);
});

test("a model answer is normalized before it becomes a mark (AC1)", async () => {
  // Curly quotes and an em-dash are two of the four `style/prose.md` forbids and
  // the ones a local model produces anyway; `normalizeProposal` is in the path.
  const endpoint = startFakeEndpoint({ tokens: ["The cellar—cold—held ", "“its own” time."], gapMs: 1 });
  endpoints.push(endpoint);
  const space = workspace();
  const [handle, setup] = await view(space, endpoint);

  await prompt(handle, setup, "rougher");
  await handle.idle();

  expect(space.text()).toContain('The cellar, cold, held "its own" time.');
  expect(space.text()).not.toContain("—");
});

test("the pack asks for the path pablo actually takes: CriticMarkup, not a tool call", async () => {
  const endpoint = startFakeEndpoint({ tokens: ["Colder."], gapMs: 1 });
  endpoints.push(endpoint);
  const [handle, setup] = await view(workspace(), endpoint);

  await prompt(handle, setup, "tighten");
  await handle.idle();

  const body = endpoint.requests[0]?.body as { messages?: { content?: string }[] };
  const sent = String(body.messages?.[0]?.content);
  // A bare `complete()` has no tools to call, so the pack must price — and
  // send — the CriticMarkup closing line, not `propose_edit` (AGT-1202).
  expect(sent).toContain(CRITICMARKUP_EDIT_CLOSING);
  expect(sent).not.toContain(TOOL_EDIT_CLOSING);
  expect(body.messages).toHaveLength(1);
});

test("an answer that is already CriticMarkup is written as the model marked it (AC1)", async () => {
  // The CriticMarkup path's whole point: the model marks the words it changed
  // rather than restating the paragraph, and the app writes exactly that.
  const marked = "The cellar was cold in a way the house {~~never~>had never~~} was.";
  const endpoint = startFakeEndpoint({ tokens: [marked], gapMs: 1 });
  endpoints.push(endpoint);
  const space = workspace();
  const [handle, setup] = await view(space, endpoint);

  await prompt(handle, setup, "tighten");
  await handle.idle();

  expect(space.text()).toContain(marked);
  expect(space.text()).not.toContain(`{~~${FIRST}`);
  const model = parse(space.text());
  expect(model.violations).toEqual([]);
  expect(model.marks).toHaveLength(1);
});

test("an answer with a mangled substitution is refused, and nothing is written (AC1)", async () => {
  const endpoint = startFakeEndpoint({ tokens: ["{~~cold~>colder~~} and then ~> loose"], gapMs: 1 });
  endpoints.push(endpoint);
  const space = workspace();
  const [handle, setup] = await view(space, endpoint);

  await prompt(handle, setup, "tighten");
  await handle.idle();

  expect(space.text()).toBe(CHAPTER);
  expect(handle.state().message).toContain("not usable CriticMarkup");
});

// ------------------------------------------------- AGT-1207 AC2: the brief

test("the work brief is in the pack, after the style rules (AGT-1207 AC2)", async () => {
  const endpoint = startFakeEndpoint({ tokens: ["Colder."], gapMs: 1 });
  endpoints.push(endpoint);
  const space = workspace();
  const setup = await createTestRenderer({ width: 100, height: 16 });
  renderers.push(setup);

  const brief = "BRIEF: Nora is alone in the cellar until chapter 28.";
  const handle = await openView(space.path, {
    renderer: setup.renderer,
    watch: false,
    timeoutFloorMs: 150,
    providers: providersFor(endpoint),
    brief: {
      // A fake `think`: no child process, a known line, and a slug the vault
      // layout would have produced anyway.
      resolve: () => "/nowhere/think",
      spawn: async () => ({ exitCode: 0, stdout: `${brief}\n`, stderr: "", timedOut: false }),
    },
  });
  open.push(handle);

  await handle.briefSettled;
  expect(handle.briefText()).toContain(brief);

  setup.mockInput.pressKey("n");
  await prompt(handle, setup, "tighten");
  await handle.idle();

  const body = endpoint.requests[0]?.body as { messages?: { content?: string }[] };
  const sent = String(body.messages?.[0]?.content);
  expect(sent).toContain(brief);
  // After the style rules and before the work's own rules, which is where a
  // slice about *this work* belongs.
  expect(sent.indexOf("Straight quotes, never curly.")).toBeLessThan(sent.indexOf(brief));
  expect(sent.indexOf(brief)).toBeLessThan(sent.indexOf("Nothing after 1919."));
});

test("a prompt run before the brief lands simply has one slice fewer (AGT-1207 AC2)", async () => {
  const endpoint = startFakeEndpoint({ tokens: ["Colder."], gapMs: 1 });
  endpoints.push(endpoint);
  const space = workspace();
  const setup = await createTestRenderer({ width: 100, height: 16 });
  renderers.push(setup);

  // The brief never settles while the prompt runs, which is the ordering the
  // seam exists for: it is read at run time, so an unfinished fetch is simply
  // absent rather than something the run waits on.
  let release: (() => void) | undefined;
  const handle = await openView(space.path, {
    renderer: setup.renderer,
    watch: false,
    timeoutFloorMs: 150,
    providers: providersFor(endpoint),
    brief: {
      resolve: () => "/nowhere/think",
      spawn: () =>
        new Promise((settle) => {
          release = () => settle({ exitCode: 0, stdout: "too late", stderr: "", timedOut: false });
        }),
    },
  });
  open.push(handle);

  setup.mockInput.pressKey("n");
  await prompt(handle, setup, "tighten");
  await handle.idle();

  const body = endpoint.requests[0]?.body as { messages?: { content?: string }[] };
  expect(String(body.messages?.[0]?.content)).not.toContain("too late");
  expect(handle.briefText()).toBeUndefined();
  release?.();
  await handle.briefSettled;
});

// --------------------------------------------------------------------- AC5

test("the view keeps scrolling and selecting while a run is in flight (AC5)", async () => {
  const endpoint = startFakeEndpoint({ tokens: ["one ", "two ", "three ", "four ", "five"], gapMs: 25 });
  endpoints.push(endpoint);
  const [handle, setup] = await view(workspace(), endpoint);

  await prompt(handle, setup, "tighten");

  // The key that started the run has already returned; the request has not.
  expect(handle.state().run).toBeDefined();
  const before = handle.state().selection.span.start;

  setup.mockInput.pressKey("n");
  await setup.renderOnce();
  expect(handle.state().selection.span.start).toBeGreaterThan(before);
  expect(handle.state().run).toBeDefined();
  expect(setup.captureCharFrame()).toContain("The cellar was cold");

  await handle.idle();
  expect(handle.state().run).toBeUndefined();
});

test("an endpoint that never answers is a named error with a retry key (AC5)", async () => {
  const silent = startFakeEndpoint({ silent: true });
  endpoints.push(silent);
  const space = workspace();
  const [handle, setup] = await view(space, silent);

  await prompt(handle, setup, "tighten");
  await handle.idle();

  const run = handle.state().run;
  expect(run?.phase).toBe("failed");
  expect(run?.error).toContain(silent.url);
  expect(run?.error).toContain("sent nothing");
  expect(space.text()).toBe(CHAPTER);

  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("R retries");
  // Still a usable view underneath the error.
  expect(frame).toContain("The cellar was cold");
});

test("`R` sends the same prompt again (AC5)", async () => {
  const silent = startFakeEndpoint({ silent: true });
  const good = startFakeEndpoint({ tokens: ["Colder still."], gapMs: 1 });
  endpoints.push(silent, good);

  const space = workspace();
  const setup = await createTestRenderer({ width: 100, height: 16 });
  renderers.push(setup);

  // One provider, two servers behind it: the first request hangs and the retry
  // is answered, which is what proves `R` re-sends rather than replays.
  let url = silent.url;
  const routed = ((input: string | Request | URL, init?: RequestInit) =>
    fetch(String(input).replace("http://unused/v1", url), init)) as unknown as typeof fetch;
  const providers = createProviders(
    parseConfig(
      JSON.stringify({ default: "local", providers: { local: { endpoint: "http://unused/v1", local: true } } }),
      "the test config",
    ),
    { fetch: routed },
  );

  const handle = await openView(space.path, {
    renderer: setup.renderer,
    watch: false,
    brief: false,
    providers,
    timeoutFloorMs: 150,
  });
  open.push(handle);
  setup.mockInput.pressKey("n");

  await prompt(handle, setup, "tighten");
  await handle.idle();
  expect(handle.state().run?.phase).toBe("failed");

  url = good.url;
  setup.mockInput.pressKey("R");
  await handle.idle();

  expect(space.text()).toContain("~>Colder still.~~}");
  expect(handle.state().run).toBeUndefined();
});

// --------------------------------------------------------------------- AC6

test("the pack size, the live rate and then the receipt are all on screen (AC6)", async () => {
  const endpoint = startFakeEndpoint({
    tokens: ["Colder ", "than ", "the ", "house."],
    gapMs: 10,
    usage: { prompt_tokens: 812, completion_tokens: 9 },
  });
  endpoints.push(endpoint);
  const space = workspace();
  const [handle, setup] = await view(space, endpoint);

  await prompt(handle, setup, "tighten");

  // Before a byte comes back: the size of the pack, the estimated wait, and a
  // second counter that moves so a prefill is not mistaken for a hang.
  await setup.renderOnce();
  expect(handle.state().run?.phase).toBe("sending");
  expect(handle.state().run?.summary).toContain("span edit pack");
  expect(handle.state().run?.summary).toContain("Estimated wait");
  expect(setup.captureCharFrame()).toContain("waiting 0s");
  expect(setup.captureCharFrame()).toContain("span edit pack");

  // During: time to first token and tokens per second.
  await until(() => handle.state().run?.tokensPerSecond !== undefined);
  expect(handle.state().run?.timeToFirstTokenMs).toBeGreaterThanOrEqual(0);
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("tok/s");

  await handle.idle();
  await setup.renderOnce();

  // After: the receipt, and it survives the re-read the write caused.
  expect(handle.state().receipt).toMatch(/^read 812 tokens in .+, wrote 9 in .+$/);
  expect(setup.captureCharFrame()).toContain("read 812 tokens in");

  // And it is gone as soon as the author does something else.
  setup.mockInput.pressKey("n");
  expect(handle.state().receipt).toBe("");
});

test("the receipt is written to the vault's own log, not to this repo", async () => {
  const endpoint = startFakeEndpoint({
    tokens: ["Colder."],
    gapMs: 1,
    usage: { prompt_tokens: 40, completion_tokens: 2 },
  });
  endpoints.push(endpoint);
  const space = workspace();
  const [handle, setup] = await view(space, endpoint);

  await prompt(handle, setup, "tighten");
  await handle.idle();

  const log = receiptsPath(space.root);
  await until(() => existsSync(log));
  const receipt = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0] ?? "{}");
  expect(receipt.intent).toBe("prompt");
  // The run drives `complete()`, so the receipt is measured, not wall-clocked.
  expect(receipt.measurement).toBe("stream");
  expect(receipt.tokens_read).toBe(40);
  expect(receipt.ttft_ms).not.toBeNull();
});

test("`d` shows the pack instead of sending it (AC6)", async () => {
  const endpoint = startFakeEndpoint({ tokens: ["never sent"], gapMs: 1 });
  endpoints.push(endpoint);
  const space = workspace();
  const [handle, setup] = await view(space, endpoint);

  setup.mockInput.pressKey("d");
  await setup.renderOnce();

  const preview = handle.state().overlay?.lines.join("\n") ?? "";
  expect(handle.state().overlay?.title).toContain("nothing was sent");
  expect(preview).toContain("span edit pack");
  expect(preview).toContain("style/prose.md");
  expect(preview).toContain("# The passage");
  expect(preview).toContain(FIRST);
  expect(handle.frame()).toContain("dry run");
  expect(endpoint.requests).toHaveLength(0);
  expect(space.text()).toBe(CHAPTER);

  // The same scroll keys read the rest of it, and esc closes it.
  setup.mockInput.pressKey(" ");
  expect(handle.state().helpOffset).toBeGreaterThan(0);
  setup.mockInput.pressEscape();
  await until(() => handle.state().overlay === undefined);
});

// --------------------------------------------------------------------- AC2, AC3

test("`e` opens the span for hand editing and ctrl+s replaces it with no markup (AC2)", async () => {
  const space = workspace();
  const [handle, setup] = await view(space);

  setup.mockInput.pressKey("e");
  await setup.renderOnce();

  expect(handle.state().field?.value).toBe(FIRST);
  expect(setup.captureCharFrame()).toContain("manual edit");

  for (let step = 0; step < FIRST.length; step += 1) setup.mockInput.pressBackspace();
  await setup.mockInput.typeText("The cellar kept its cold.");
  setup.mockInput.pressKey("s", { ctrl: true });

  expect(space.text()).toContain("The cellar kept its cold.");
  expect(space.text()).not.toContain("in a way the house never was");
  expect(parse(space.text()).marks).toEqual([]);
  expect(handle.state().doc.text).toBe(space.text());
  expect(handle.state().field).toBeUndefined();
});

test("esc cancels a field and changes nothing (AC2)", async () => {
  const space = workspace();
  const [handle, setup] = await view(space);

  setup.mockInput.pressKey("e");
  await setup.mockInput.typeText("xyz");
  setup.mockInput.pressEscape();
  await until(() => handle.state().field === undefined);

  expect(space.text()).toBe(CHAPTER);
});

test("ctrl+c in a field leaves the field, not the app (AC2)", async () => {
  const space = workspace();
  const [handle, setup] = await view(space);

  setup.mockInput.pressKey("e");
  await setup.mockInput.typeText(" and then some");
  expect(handle.state().field?.value).toBe(`${FIRST} and then some`);

  setup.mockInput.pressCtrlC();
  await until(() => handle.state().field === undefined);

  expect(handle.state().running).toBe(true);
  expect(space.text()).toBe(CHAPTER);
});

test("`x` cuts the selection and the view re-renders from disk (AC3)", async () => {
  const space = workspace();
  const [handle, setup] = await view(space);

  setup.mockInput.pressKey("x");
  await setup.renderOnce();

  expect(space.text()).not.toContain(FIRST);
  expect(space.text()).not.toMatch(/\n{3,}/);
  expect(handle.state().doc.text).toBe(space.text());
  expect(setup.captureCharFrame()).not.toContain("The cellar was cold");
});

test("`m` then `m` at a boundary moves the paragraph in one write (AC3)", async () => {
  const space = workspace();
  const [handle, setup] = await view(space);

  setup.mockInput.pressKey("m");
  expect(handle.state().pendingMove?.text).toBe(FIRST);
  // Nothing on disk yet: the cut and the insert are one write.
  expect(space.text()).toBe(CHAPTER);

  setup.mockInput.pressKey("G");
  setup.mockInput.pressKey("a");
  setup.mockInput.pressKey("m");

  const moved = space.text();
  expect(moved.indexOf(FIRST)).toBeGreaterThan(moved.indexOf("The lamp guttered"));
  expect(moved).not.toMatch(/\n{3,}/);
  expect(handle.state().pendingMove).toBeUndefined();
  expect(handle.state().doc.text).toBe(moved);
});

test("a move whose file changed under it is abandoned, not applied (AC3)", async () => {
  const space = workspace();
  const [handle, setup] = await view(space);

  setup.mockInput.pressKey("m");
  expect(handle.state().pendingMove).toBeDefined();

  // The two presses of `m` are two moments, and the file belongs to the vault
  // in between them.
  writeFileSync(space.path, `A new first line.\n\n${CHAPTER}`, "utf8");
  handle.reload();
  setup.mockInput.pressKey("m");

  expect(space.text()).toBe(`A new first line.\n\n${CHAPTER}`);
  expect(handle.state().message).toContain("the file changed since the cut");
  expect(handle.state().pendingMove).toBeUndefined();
});

test("esc abandons a pending move without touching the file (AC3)", async () => {
  const space = workspace();
  const [handle, setup] = await view(space);

  setup.mockInput.pressKey("m");
  expect(handle.state().pendingMove).toBeDefined();
  setup.mockInput.pressEscape();
  await until(() => handle.state().pendingMove === undefined);

  expect(space.text()).toBe(CHAPTER);
});

// --------------------------------------------------------------------- AC4

test("`o` hands the terminal to $EDITOR at the cursor line and re-reads on return (AC4)", async () => {
  const space = workspace();
  const setup = await createTestRenderer({ width: 100, height: 16 });
  renderers.push(setup);

  const seen: string[][] = [];
  const handle = await openView(space.path, {
    renderer: setup.renderer,
    watch: false,
    brief: false,
    editor: {
      env: { EDITOR: "nvim" },
      spawn: async (argv) => {
        seen.push([...argv]);
        writeFileSync(space.path, CHAPTER.replace("nineteen", "twenty-one"), "utf8");
        return 0;
      },
    },
  });
  open.push(handle);

  setup.mockInput.pressKey("n");
  setup.mockInput.pressKey("n");
  const line = handle.state().doc.text.slice(0, handle.state().selection.span.start).split("\n").length;
  expect(line).toBe(5);

  setup.mockInput.pressKey("o");
  await until(() => handle.state().message === "back from $EDITOR");

  expect(seen).toEqual([["nvim", "+5", space.path]]);
  expect(handle.state().doc.text).toContain("twenty-one");
});

test("a missing $EDITOR is a message, not a crash (AC4)", async () => {
  const space = workspace();
  const setup = await createTestRenderer({ width: 100, height: 16 });
  renderers.push(setup);
  const handle = await openView(space.path, {
    renderer: setup.renderer,
    watch: false,
    brief: false,
    editor: { env: {} },
  });
  open.push(handle);

  setup.mockInput.pressKey("o");
  await until(() => handle.state().message.includes("$EDITOR"));

  expect(handle.state().message).toContain("$EDITOR is not set");
  expect(space.text()).toBe(CHAPTER);
});

// --------------------------------------------------------------------- guards

test("a run started while one is in flight is refused, not queued", async () => {
  const endpoint = startFakeEndpoint({ tokens: ["one ", "two ", "three"], gapMs: 20 });
  endpoints.push(endpoint);
  const [handle, setup] = await view(workspace(), endpoint);

  await prompt(handle, setup, "tighten");
  await prompt(handle, setup, "again");
  await handle.idle();

  expect(endpoint.requests).toHaveLength(1);
});

test("an empty prompt sends nothing", async () => {
  const endpoint = startFakeEndpoint({ tokens: ["x"], gapMs: 1 });
  endpoints.push(endpoint);
  const [handle, setup] = await view(workspace(), endpoint);

  setup.mockInput.pressKey(">");
  setup.mockInput.pressEnter();
  await handle.idle();

  expect(endpoint.requests).toHaveLength(0);
  expect(handle.state().message).toBe("nothing to prompt with");
});

test("a file that changed under a run is not written over", async () => {
  const endpoint = startFakeEndpoint({ tokens: ["Colder ", "still."], gapMs: 25 });
  endpoints.push(endpoint);
  const space = workspace();
  const [handle, setup] = await view(space, endpoint);

  await prompt(handle, setup, "tighten");

  // Something else rewrites the file while the model is working, so the offsets
  // pablo planned against no longer address the text it showed the model.
  writeFileSync(space.path, `A new first line.\n\n${CHAPTER}`, "utf8");
  handle.reload();
  await handle.idle();

  expect(space.text()).not.toContain("~>");
  expect(handle.state().message).toContain("the file changed while the model worked");
});

test("a second prompt while one is in flight says something esc can actually do", async () => {
  const endpoint = startFakeEndpoint({ tokens: ["one ", "two ", "three"], gapMs: 20 });
  endpoints.push(endpoint);
  const [handle, setup] = await view(workspace(), endpoint);

  await prompt(handle, setup, "tighten");
  await prompt(handle, setup, "again");

  // `esc` closes pages and clears a failed run; it does not abort a live one,
  // so the message must not send the author there.
  expect(handle.state().message).not.toContain("esc");
  setup.mockInput.pressEscape();
  await until(() => handle.state().message === "");
  expect(handle.state().run?.phase).not.toBe("failed");

  await handle.idle();
  expect(endpoint.requests).toHaveLength(1);
});
