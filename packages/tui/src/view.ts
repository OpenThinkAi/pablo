/**
 * The manuscript view: the only place in pablo that owns a renderer, a key
 * listener, and a file watch.
 *
 * It is deliberately thin. Layout, key lookup, and state transitions are pure
 * modules next to this one; this file wires them to opentui and to the
 * filesystem, and owns exactly the things that have to be torn down. Anything
 * that can be decided without a terminal is decided somewhere else.
 *
 * The renderer can be injected, which is how the tests drive a real frame
 * through opentui's headless test renderer instead of a TTY.
 */

import { TextRenderable, createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core";
import { helpLines, statusSegments } from "./chrome";
import { createLineCache, layoutWindow, type DisplayLine } from "./layout";
import { BINDINGS, matchBinding, type Binding, type KeyLike } from "./keymap";
import { frameText, styledLines, styledSegments } from "./render";
import { loadManuscript, watchManuscript } from "./source";
import {
  ACTIONS,
  applyAction,
  initialState,
  reloaded,
  resized,
  viewportOf,
  type Action,
  type ViewState,
} from "./view-state";

export interface OpenViewOptions {
  /** An existing renderer to draw into. When absent the view creates and owns one. */
  readonly renderer?: CliRenderer;
  /** Re-read the file when it changes on disk (AC4). On by default. */
  readonly watch?: boolean;
  readonly bindings?: readonly Binding[];
  readonly actions?: Readonly<Record<string, Action>>;
  readonly debounceMs?: number;
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
  stop(): void;
  /** Resolves once the view has torn everything down. */
  readonly closed: Promise<void>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function openView(path: string, options: OpenViewOptions = {}): Promise<ViewHandle> {
  const bindings = options.bindings ?? BINDINGS;
  const actions = options.actions ?? ACTIONS;

  // Ctrl+C is a binding like any other, so the view tears itself down through
  // the same path a `q` takes rather than being killed mid-frame.
  const renderer =
    options.renderer ?? (await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 }));
  const ownsRenderer = options.renderer === undefined;

  const manuscript = loadManuscript(path);
  const cache = createLineCache();
  let state = initialState(manuscript, { width: renderer.width, height: Math.max(1, renderer.height - 1) });
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
    if (state.help) {
      const help = helpLines(bindings);
      const offset = Math.min(state.helpOffset, Math.max(0, help.length - state.height));
      if (offset !== state.helpOffset) state = { ...state, helpOffset: offset };
      lines = help.slice(offset, offset + state.height);
    } else {
      lines = layoutWindow(state.model, viewportOf(state), cache).slice(0, state.height);
    }
    body.content = styledLines(lines);
    status.content = styledSegments(statusSegments(state));
    renderer.requestRender();
  };

  const reload = (): void => {
    try {
      state = reloaded(state, loadManuscript(path), cache);
    } catch (error) {
      state = { ...state, message: `could not re-read the file: ${describe(error)}` };
    }
    draw();
  };

  let stopped = false;
  let settle: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    renderer.keyInput.off("keypress", onKey);
    renderer.off("resize", onResize);
    unwatch?.();
    if (ownsRenderer) renderer.destroy();
    settle();
  };

  const press = (key: KeyLike): void => {
    if (stopped) return;
    const binding = matchBinding(key, bindings);
    if (binding === undefined) return;

    // `reload` is the one action that reaches outside the state machine, so it
    // is handled here rather than pretending to be pure.
    if (binding.action === "reload") {
      reload();
      return;
    }

    state = applyAction(state, binding.action, cache, actions);
    if (!state.running) {
      stop();
      return;
    }
    draw();
  };

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

  return {
    state: () => state,
    lines: () => lines,
    frame: () => frameText(lines),
    press,
    reload,
    stop,
    closed,
  };
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
