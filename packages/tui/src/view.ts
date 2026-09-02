/**
 * The manuscript view: the only place in pablo that owns a renderer, a key
 * listener, a file watch, a child process, and a model request.
 *
 * It is deliberately thin. Layout, key lookup, field editing, pack assembly,
 * the document edits themselves, and every state transition are pure modules
 * next to this one; this file wires them to opentui, to the filesystem, and to
 * the provider layer, and owns exactly the things that have to be torn down.
 * Anything that can be decided without a terminal is decided somewhere else.
 *
 * Three rules hold this file together:
 *
 * 1. **The app applies.** Every write to the manuscript is `writeDocument`,
 *    called from a verb the author pressed, on a `Document` built by `apply.ts`.
 *    A provider adapter never sees a path.
 * 2. **A verb that reaches outside the state machine is handled here**, by
 *    action id, from `VIEW_OWNED` — the disk, `$EDITOR`, a provider. Everything
 *    else is dispatched into `ACTIONS`, which is pure.
 * 3. **A model run never blocks a key.** `startRun` is fired and not awaited,
 *    so scrolling and selecting keep working while an answer streams in (AC5).
 *
 * The renderer can be injected, which is how the tests drive a real frame
 * through opentui's headless test renderer instead of a TTY.
 */

import { TextRenderable, createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core";
import {
  createProviders,
  loadConfig,
  ProviderConfigError,
  selectionText,
  thousands,
  type Providers,
  type Span,
} from "@openthink/pablo-core";
import { cutEdit, lineOf, manualEdit, moveEdit, proposalEdit, writeDocument, type Edit } from "./apply";
import { detectWork, runBrief, type DirectoryProbe, type RunBriefOptions, type Work } from "./brief";
import { briefLines, fieldLines, helpLines, overlayLines, statusSegments } from "./chrome";
import { openInEditor, type OpenInEditorOptions } from "./editor";
import { backspace, deleteForward, insertInto, moveCaret, toLineEdge } from "./field";
import { createLineCache, layoutWindow, type DisplayLine } from "./layout";
import { BINDINGS, matchBinding, VIEW_OWNED, type Binding, type KeyLike } from "./keymap";
import { frameText, styledLines, styledSegments } from "./render";
import { failureMessage, planSpanEdit, runSpanEdit, type SpanEditPlan } from "./run";
import { loadManuscript, watchManuscript } from "./source";
import {
  ACTIONS,
  IDLE_BRIEF,
  applied,
  applyAction,
  beginMove,
  briefLoaded,
  clearMove,
  closeField,
  initialState,
  openManual,
  openPrompt,
  reloaded,
  resized,
  runFailed,
  runFinished,
  runProgress,
  runStarted,
  runWaiting,
  showOverlay,
  viewportOf,
  withField,
  type Action,
  type BriefPane,
  type ViewState,
} from "./view-state";

/**
 * How the session fetches the work brief (AC1). `false` on `OpenViewOptions`
 * turns it off entirely, which is what a test that is not about the brief wants.
 *
 * There is no `signal` here on purpose: the view owns the cancellation, because
 * the one thing that must always abort the fetch is the view tearing down.
 */
export interface ViewBriefOptions extends Omit<RunBriefOptions, "signal"> {
  /** Skip detection and brief this slug. */
  readonly slug?: string | undefined;
  /** The directory probe detection uses; injected in tests. */
  readonly isDirectory?: DirectoryProbe | undefined;
}

export interface OpenViewOptions {
  /** An existing renderer to draw into. When absent the view creates and owns one. */
  readonly renderer?: CliRenderer;
  /** Re-read the file when it changes on disk (AC4). On by default. */
  readonly watch?: boolean;
  readonly bindings?: readonly Binding[];
  readonly actions?: Readonly<Record<string, Action>>;
  readonly debounceMs?: number;
  /** The work brief, on by default. `false` skips the fetch. */
  readonly brief?: ViewBriefOptions | false;
  /**
   * The configured providers. Absent means "read the author's config on the
   * first run"; a test injects a registry pointed at its own fake endpoint, so
   * no test ever reads the real config or calls the real local writer.
   */
  readonly providers?: Providers;
  /** How `$EDITOR` is found and spawned (AC4). The tests stand a script in for it. */
  readonly editor?: OpenInEditorOptions;
  /**
   * Extra context spliced into the pack after the style rules.
   *
   * The work brief goes in here by default, read at run time so a brief that
   * lands after the view does is still in the next prompt (AGT-1207 AC2).
   * Overriding it replaces the brief rather than adding to it, which is what a
   * test that wants a known context wants.
   */
  readonly extraContext?: () => string | undefined;
  /** Floor on the pack-sized request timeout; see `PlanOptions.timeoutFloorMs`. */
  readonly timeoutFloorMs?: number;
}

export interface ViewHandle {
  /** The current state. Read-only; actions are the only way to change it. */
  state(): ViewState;
  /** The rows currently on screen. */
  lines(): readonly DisplayLine[];
  /** The plain text of the current frame. */
  frame(): string;
  /** Dispatch a key press without a terminal. */
  press(key: KeyLike): void;
  /** Re-read the file now. */
  reload(): void;
  /** The work the file belongs to, if it is in a writing vault. */
  work(): Work | undefined;
  /**
   * The cached brief, or `undefined` while it is loading, missing, or failed.
   *
   * **This is the seam the `prompt` verb reads.** The context pack puts the
   * brief in after the style rules and before the work's own facts, so a verb
   * that assembles a pack calls this and passes the string through as one more
   * context slice — it is prose about the work, exactly like the other slices,
   * and it is never sent as an instruction. Nothing here mutates the pack or
   * the manuscript; the brief is read-only for the whole session.
   */
  briefText(): string | undefined;
  /** Resolves once the brief attempt has settled, however it settled. For tests. */
  readonly briefSettled: Promise<void>;
  /** Resolves when no model run is in flight — the tests await it, the app does not. */
  idle(): Promise<void>;
  stop(): void;
  /** Resolves once the view has torn everything down. */
  readonly closed: Promise<void>;
}

/** C0 controls and DEL: a keystroke that types a character is never one of these. */
const CONTROL_BYTE = /[\u0000-\u001f\u007f]/;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether the text under a span stopped being the text a run was planned against. */
function spanMoved(state: ViewState, span: Span, original: string): boolean {
  return span.end > state.doc.text.length || selectionText(state.doc, span) !== original;
}

export async function openView(path: string, options: OpenViewOptions = {}): Promise<ViewHandle> {
  const bindings = options.bindings ?? BINDINGS;
  const actions = options.actions ?? ACTIONS;

  // Ctrl+C is a binding like any other, so the view tears itself down through
  // the same path a `q` takes rather than being killed mid-frame.
  const renderer =
    options.renderer ?? (await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 }));
  const ownsRenderer = options.renderer === undefined;

  // Declared before `draw`, which is the first thing that reads it: everything
  // asynchronous in this file checks it before touching the renderer.
  let stopped = false;

  const manuscript = loadManuscript(path);
  const cache = createLineCache();

  // Detection is a path question and costs one `stat` per ancestor, so it
  // happens before the first frame; *fetching* the brief does not, and is
  // started after the view is already on screen.
  const briefOptions = options.brief === false ? undefined : (options.brief ?? {});
  const work = briefOptions === undefined ? undefined : detectWork(path, briefOptions.isDirectory);
  const slug = briefOptions === undefined ? undefined : (briefOptions.slug ?? work?.slug);
  const openingBrief: BriefPane =
    slug === undefined ? IDLE_BRIEF : { ...IDLE_BRIEF, status: "loading", slug };

  let state = initialState(
    manuscript,
    { width: renderer.width, height: Math.max(1, renderer.height - 1) },
    openingBrief,
  );
  let lines: DisplayLine[] = [];

  const body = new TextRenderable(renderer, {
    content: "",
    width: "100%",
    height: Math.max(1, renderer.height - 1),
  });
  const status = new TextRenderable(renderer, { content: "", width: "100%", height: 1 });
  renderer.root.add(body);
  renderer.root.add(status);

  const draw = (): void => {
    // A run outlives a `stop()` by the time it takes the request to unwind, and
    // drawing into a destroyed renderer throws from inside opentui.
    if (stopped) return;

    if (state.brief.open) {
      // The brief keeps its own offset because it outlives the pages that do
      // not: it is fetched once and read many times.
      const rows = briefLines(state.brief, state.width);
      const offset = Math.min(state.brief.offset, Math.max(0, rows.length - state.height));
      if (offset !== state.brief.offset) state = { ...state, brief: { ...state.brief, offset } };
      lines = rows.slice(offset, offset + state.height);
      body.content = styledLines(lines);
      status.content = styledSegments(statusSegments(state));
      renderer.requestRender();
      return;
    }

    const overlay = state.overlay;
    if (state.help || overlay !== undefined) {
      const page = state.help || overlay === undefined ? helpLines(bindings) : overlayLines(overlay);
      const offset = Math.min(state.helpOffset, Math.max(0, page.length - state.height));
      if (offset !== state.helpOffset) state = { ...state, helpOffset: offset };
      lines = page.slice(offset, offset + state.height);
    } else {
      // The field takes the bottom of the manuscript pane, never more than half
      // of it: a long manual edit scrolls inside its own box rather than hiding
      // the passage it is replacing.
      const panel =
        state.field === undefined
          ? []
          : trimPanel(fieldLines(state.field, state.width), Math.max(3, Math.floor(state.height / 2)));
      const prose = layoutWindow(state.model, viewportOf(state), cache).slice(0, state.height - panel.length);
      lines = [...prose, ...panel];
    }
    body.content = styledLines(lines);
    status.content = styledSegments(statusSegments(state));
    renderer.requestRender();
  };

  const reload = (message?: string): void => {
    try {
      state = reloaded(state, loadManuscript(path), cache, message);
    } catch (error) {
      state = { ...state, message: `could not re-read the file: ${describe(error)}` };
    }
    draw();
  };

  /**
   * The app applying an edit: write, re-read, re-render, and put the selection
   * on what was written. Every offset the caller held is invalid after this,
   * which is why nothing is returned.
   */
  const apply = (edit: Edit, message: string): void => {
    if (!edit.ok) {
      state = { ...state, message: edit.reason };
      draw();
      return;
    }
    try {
      writeDocument(edit.doc);
    } catch (error) {
      state = { ...state, message: `could not write the file: ${describe(error)}` };
      draw();
      return;
    }
    try {
      state = applied(state, loadManuscript(path), edit.span, message, cache);
    } catch (error) {
      state = { ...state, message: `could not re-read the file: ${describe(error)}` };
    }
    draw();
  };

  // ---------------------------------------------------------------- providers

  let providers: Providers | undefined = options.providers;
  const providersOrThrow = (): Providers => {
    if (providers === undefined) providers = createProviders(loadConfig());
    return providers;
  };

  /**
   * The prose spliced into the pack after the style rules. The work brief by
   * default — it is prose about the work, exactly like the other slices, and it
   * is never sent as an instruction — replaced wholesale when a caller supplies
   * its own.
   */
  const extraContext = (): string | undefined =>
    options.extraContext === undefined
      ? state.brief.status === "ready"
        ? state.brief.text
        : undefined
      : options.extraContext();

  const plan = (instruction: string, span: Span): SpanEditPlan =>
    planSpanEdit({
      providers: providersOrThrow(),
      doc: state.doc,
      span,
      instruction,
      // Read *now*, not at open: the brief arrives from a child process some
      // seconds in, and a prompt run after it lands has to see it (AGT-1207
      // AC2). `briefText()` is `undefined` until then, and the pack simply has
      // one slice fewer.
      extraContext: extraContext(),
      timeoutFloorMs: options.timeoutFloorMs,
    });

  // ---------------------------------------------------------------- the run

  let inFlight: Promise<void> | undefined;
  let lastAsk: { instruction: string; span: Span } | undefined;
  const aborter = new AbortController();
  let ticker: ReturnType<typeof setInterval> | undefined;

  /**
   * AC1 and AC5. Not awaited by its caller: the key that started it returns
   * immediately, the render loop keeps drawing, and every state change the run
   * makes arrives through the same `draw()` a key press would use.
   */
  const startRun = (instruction: string, span: Span): void => {
    if (inFlight !== undefined) {
      state = { ...state, message: "a run is already in flight; wait for it or press esc" };
      draw();
      return;
    }

    let prepared: SpanEditPlan;
    try {
      prepared = plan(instruction, span);
    } catch (error) {
      state = { ...state, message: configMessage(error) };
      draw();
      return;
    }

    lastAsk = { instruction, span };
    // What the model was shown. If the file changes under the run — the author
    // in `$EDITOR`, a git checkout — these offsets no longer address that text,
    // and writing a mark over them would corrupt the manuscript.
    const original = selectionText(state.doc, span);
    state = runStarted(state, {
      instruction,
      providerId: prepared.providerId,
      summary: prepared.preview.summary,
      size: `${thousands(prepared.pack.totalTokens)} tokens sent`,
    });
    if (prepared.notices.length > 0) state = { ...state, message: prepared.notices.join("  ·  ") };
    draw();

    // The elapsed time has to move even before the first token arrives, or a
    // long prefill is indistinguishable from a hang on screen.
    const startedAt = Date.now();
    ticker = setInterval(() => {
      if (stopped) return;
      state = runWaiting(state, Date.now() - startedAt);
      draw();
    }, 500);
    ticker.unref?.();

    inFlight = (async () => {
      try {
        const outcome = await runSpanEdit(prepared, providersOrThrow(), {
          signal: aborter.signal,
          onProgress: (progress) => {
            if (stopped) return;
            state = runProgress(state, progress);
            draw();
          },
        });
        if (stopped || !state.running) return;
        state = runFinished(state, outcome.receipt);
        if (spanMoved(state, span, original)) {
          state = { ...state, message: "the file changed while the model worked; nothing was written (R retries)" };
          draw();
          return;
        }
        apply(proposalEdit(state.doc, span, outcome.answer), "");
      } catch (error) {
        if (stopped) return;
        state = runFailed(state, failureMessage(error, prepared.providerId));
        draw();
      } finally {
        if (ticker !== undefined) clearInterval(ticker);
        ticker = undefined;
        inFlight = undefined;
      }
    })();
  };

  /** AC6: the same plan, shown instead of sent. */
  const dryRun = (): void => {
    const instruction = state.run?.instruction ?? lastAsk?.instruction ?? "(no instruction yet)";
    try {
      const prepared = plan(instruction, state.selection.span);
      state = showOverlay(state, {
        title: `dry run — nothing was sent · would go to "${prepared.providerId}"`,
        lines: prepared.preview.text.split("\n"),
      });
    } catch (error) {
      state = { ...state, message: configMessage(error) };
    }
    draw();
  };

  // ---------------------------------------------------------------- $EDITOR

  /**
   * AC4. The renderer is suspended so the child owns the terminal, and resumed
   * in a `finally` so a crashing editor cannot leave pablo drawing into a
   * terminal it no longer controls. The file is re-read on return, which is the
   * same path an external write already takes.
   */
  const handOff = async (): Promise<void> => {
    const line = lineOf(state.doc.text, state.selection.span.start);
    renderer.suspend();
    try {
      const run = await openInEditor(path, line, options.editor);
      reload(run.exitCode === 0 ? "back from $EDITOR" : `$EDITOR exited ${run.exitCode}`);
    } catch (error) {
      state = { ...state, message: describe(error) };
    } finally {
      renderer.resume();
      draw();
    }
  };

  // ---------------------------------------------------------------- keys

  /** A field is a mode: while one is open the keys go into it, not into the map. */
  const typeInto = (key: KeyLike): void => {
    const field = state.field;
    if (field === undefined) return;
    const name = key.name ?? "";
    const sequence = key.sequence ?? "";

    if (name === "escape") {
      state = closeField(state, "cancelled");
    } else if (name === "return" || name === "enter") {
      if (field.kind === "prompt") {
        const instruction = field.value.trim();
        state = closeField(state);
        if (instruction === "") {
          state = { ...state, message: "nothing to prompt with" };
        } else {
          startRun(instruction, state.selection.span);
          return;
        }
      } else {
        state = withField(state, insertInto(field, "\n"));
      }
    } else if (key.ctrl === true && name === "s") {
      const value = field.value;
      state = closeField(state);
      apply(manualEdit(state.doc, state.selection.span, value), "edited by hand");
      return;
    } else if (name === "backspace") {
      state = withField(state, backspace(field));
    } else if (name === "delete") {
      state = withField(state, deleteForward(field));
    } else if (name === "left") {
      state = withField(state, moveCaret(field, -1));
    } else if (name === "right") {
      state = withField(state, moveCaret(field, 1));
    } else if (name === "home") {
      state = withField(state, toLineEdge(field, "start"));
    } else if (name === "end") {
      state = withField(state, toLineEdge(field, "end"));
    } else if (key.ctrl === true && name === "c") {
      // A field is modal, so ctrl+c leaves the field rather than the app: the
      // text just typed is the thing most easily lost, and `esc` then `q` quits.
      state = closeField(state, "cancelled");
    } else if (key.ctrl !== true && key.meta !== true && sequence !== "" && !CONTROL_BYTE.test(sequence)) {
      // Anything that produced visible characters is typing, a space and a
      // hyphen included, which is most of what an instruction is made of.
      state = withField(state, insertInto(field, sequence));
    } else {
      return;
    }
    draw();
  };

  let settle: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    settle = resolve;
  });

  // The brief runs in a child process, so quitting has to kill it: a `think`
  // still talking to its daemon after the view is gone is a leaked process.
  const briefAbort = new AbortController();
  let settleBrief: () => void = () => {};
  const briefSettled = new Promise<void>((resolve) => {
    settleBrief = resolve;
  });

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    state = { ...state, running: false };
    renderer.keyInput.off("keypress", onKey);
    renderer.off("resize", onResize);
    unwatch?.();
    if (ticker !== undefined) clearInterval(ticker);
    ticker = undefined;
    // Neither a model request nor a `think` child outlives the view unless it
    // is told not to: aborting both here is what keeps `pablo` from holding a
    // socket or a process open after the author quits.
    aborter.abort();
    briefAbort.abort();
    if (ownsRenderer) renderer.destroy();
    settle();
  };

  const press = (key: KeyLike): void => {
    if (stopped) return;
    if (state.field !== undefined) {
      typeInto(key);
      return;
    }

    const binding = matchBinding(key, bindings);
    if (binding === undefined) return;

    if (VIEW_OWNED.has(binding.action)) {
      runViewOwned(binding.action);
      return;
    }

    state = applyAction(state, binding.action, cache, actions);
    if (!state.running) {
      stop();
      return;
    }
    draw();
  };

  /** The verbs that reach the disk, `$EDITOR` or a provider. See `VIEW_OWNED`. */
  function runViewOwned(action: string): void {
    switch (action) {
      case "reload":
        reload();
        return;
      case "prompt":
        state = openPrompt(state);
        draw();
        return;
      case "manualEdit":
        state = openManual(state);
        draw();
        return;
      case "cut":
        apply(cutEdit(state.doc, state.selection.span), "cut");
        return;
      case "move": {
        const pending = state.pendingMove;
        if (pending === undefined) {
          state = beginMove(state);
          draw();
          return;
        }
        state = clearMove(state);
        apply(moveEdit(state.doc, pending.span, state.selection.span.start, pending.asBlock), "moved");
        return;
      }
      case "openEditor":
        void handOff();
        return;
      case "dryRun":
        dryRun();
        return;
      case "retry": {
        if (lastAsk === undefined) {
          state = { ...state, message: "nothing to retry yet" };
          draw();
          return;
        }
        startRun(lastAsk.instruction, lastAsk.span);
        return;
      }
      default:
        return;
    }
  }

  function onKey(key: KeyEvent): void {
    if (key.eventType === "release") return;
    press(key);
  }

  function onResize(): void {
    if (stopped) return;
    state = resized(state, { width: renderer.width, height: Math.max(1, renderer.height - 1) });
    body.height = state.height;
    draw();
  }

  renderer.keyInput.on("keypress", onKey);
  renderer.on("resize", onResize);

  const unwatch =
    options.watch === false
      ? undefined
      : watchManuscript(
          path,
          (next) => {
            if (stopped) return;
            state = reloaded(state, next, cache);
            draw();
          },
          {
            initialText: manuscript.doc.text,
            debounceMs: options.debounceMs,
            onError: (error) => {
              if (stopped) return;
              state = { ...state, message: `watch: ${describe(error)}` };
              draw();
            },
          },
        );

  draw();

  // AC1/AC3: one fetch per session, started after the first frame, never
  // awaited. The view is already usable; the brief lands in a later frame or
  // it does not land at all, and either way nothing blocks on it.
  if (slug === undefined || briefOptions === undefined) {
    settleBrief();
  } else {
    void runBrief(slug, {
      signal: briefAbort.signal,
      timeoutMs: briefOptions.timeoutMs,
      path: briefOptions.path,
      spawn: briefOptions.spawn,
      resolve: briefOptions.resolve,
    })
      .then((outcome) => {
        if (stopped) return;
        state = briefLoaded(state, outcome);
        draw();
      })
      .catch(() => {
        // `runBrief` reports failure in its outcome rather than by throwing;
        // this is only here so an unexpected throw cannot become an unhandled
        // rejection that takes the session down.
        if (stopped) return;
        state = briefLoaded(state, { status: "unavailable" });
        draw();
      })
      .finally(settleBrief);
  }

  return {
    state: () => state,
    lines: () => lines,
    frame: () => frameText(lines),
    press,
    reload: () => reload(),
    idle: async () => {
      await inFlight;
    },
    work: () => work,
    briefText: () => (state.brief.status === "ready" ? state.brief.text : undefined),
    briefSettled,
    stop,
    closed,
  };
}

/** A config problem is the author's to fix, so it is shown as itself, not as a stack. */
function configMessage(error: unknown): string {
  return error instanceof ProviderConfigError ? error.message : `could not build the pack: ${describe(error)}`;
}

/** Keep the head and the hint row of an over-tall field. */
function trimPanel(panel: readonly DisplayLine[], limit: number): DisplayLine[] {
  if (panel.length <= limit) return [...panel];
  return [...panel.slice(0, limit - 1), ...panel.slice(-1)];
}

/** Open the view and resolve when the author quits. The CLI's whole job. */
export async function runView(path: string): Promise<void> {
  const handle = await openView(path);

  // A signal must still restore the terminal: `stop()` destroys the renderer,
  // which is what takes the terminal out of raw mode and puts the cursor back.
  const stop = (): void => handle.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);

  try {
    await handle.closed;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("SIGHUP", stop);
  }
}
