/**
 * `pablo edit` (AGT-1258): mounts the ui-leaf editor window over a piece or a
 * project file. Wires a real `EditHost` (AGT-1269's `edit-host.ts`) to
 * `views/editor.tsx` through `@openthink/ui-leaf`'s `mount()`. See
 * `~/saltline-digital-vault/projects/ai-terminal/review-tray.md`, "The
 * editor" — this ticket is the window, the Chromium probe, and the stub
 * view only; AGT-1270 replaces the view with the full paper-sheet editor.
 *
 * `openEditor` is the one function both this file's CLI wrapper (`runEdit`)
 * and `verbs.ts`'s MCP tool (`runEditVerb`) call, and the one AGT-1259's tray
 * daemon calls directly with a piece's own path — no argv, no `--project`.
 * It derives the vault/project a file lives under purely from the file's own
 * path (`deriveEditContext`), so a caller with nothing but a resolved path
 * (a piece record, a daemon click) never needs a working directory at all.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { mount } from "@openthink/ui-leaf";
import type { MutationHandler } from "@openthink/ui-leaf";
import { checkFile, loadCheckRules } from "./check";
import type { CheckRules } from "./check";
import { createEditHost, EditHostError } from "./edit-host";
import type { EditHostDeps } from "./edit-host";
import { gitCommit as gitCommitPaths } from "./init";
import { readMarker } from "./marker";
import { stateReviewPath } from "./paths";
import { findVault, resolveProjectFromCwd } from "./project";
import type { Refusal } from "./project";
import { readEvents, record } from "./review";
import type { PieceRecord } from "./review";
import { reviseCore } from "./revise";
import type { ReviseCoreContext, ReviseSendBody } from "./revise";

// ---------------------------------------------------------------------------
// The Chromium probe (AC4) — the same macOS bundle paths and executable-bit
// check insieme's `src/ui-leaf.ts` uses, so a browser ui-leaf's own `shell:
// "app"` mode would find is exactly the browser this refuses on. Kept as a
// pure, injectable function (`existsExecutable`) so `edit.test.ts` can drive
// every combination without touching the real filesystem.
// ---------------------------------------------------------------------------

export const CHROMIUM_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
] as const;

/** Executable-by-anyone, matching ui-leaf's own probe — existence alone would accept a half-deleted app bundle. */
export function defaultExistsExecutable(path: string): boolean {
  try {
    return (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** The first Chromium-family browser found, or `undefined`. */
export function findChromium(
  existsExecutable: (path: string) => boolean = defaultExistsExecutable,
  paths: readonly string[] = CHROMIUM_PATHS,
): string | undefined {
  for (const candidate of paths) {
    if (existsExecutable(candidate)) return candidate;
  }
  return undefined;
}

export const NO_CHROMIUM_MESSAGE =
  "pablo: no Chromium-family browser found — the editor needs one of Google Chrome, Microsoft Edge, or Brave Browser installed";

/** Thrown by `openEditor` before any mount happens — `code` is the CLI/MCP exit-code contract (0 ok, 2 refused, 1 error). */
export class EditError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "EditError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Resolving what to open — `--piece <id>` or `--project <slug> --file F`.
// ---------------------------------------------------------------------------

export interface EditTargetArgs {
  readonly project: string | undefined;
  readonly file: string | undefined;
  readonly piece: string | undefined;
}

export interface EditTargetContext {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
}

export interface EditTarget {
  readonly ok: true;
  readonly path: string;
  readonly piece?: PieceRecord;
}

export type EditTargetResult = EditTarget | Refusal;

function refusal(message: string): Refusal {
  return { ok: false, code: 2, message, tried: [] };
}

/**
 * `--piece <id>` resolves through the review queue (`review.ts`'s `record`);
 * `--project <slug> --file F` resolves and bounds `file` inside the project,
 * exactly like `revise`'s own `file` bound (AC3: an unknown piece or a file
 * outside the project both refuse, exit 2). Never resolves a vault/project
 * for the `--piece` path — `openEditor`'s `deriveEditContext` does that from
 * the piece's own `path`, so this function alone is enough for both the CLI
 * and `verbs.ts`'s MCP tool.
 */
export function resolveEditTarget(args: EditTargetArgs, ctx: EditTargetContext): EditTargetResult {
  if (args.piece !== undefined) {
    const events = readEvents(stateReviewPath(ctx.env));
    const found = record(events, args.piece);
    if (found === undefined) {
      return refusal(`pablo: edit: unknown piece "${args.piece}"`);
    }
    return { ok: true, path: resolve(found.piece.path), piece: found.piece };
  }

  if (args.project === undefined || args.file === undefined) {
    return refusal("pablo: edit requires --piece <id>, or --project <slug> --file <path>");
  }

  const resolvedProject = resolveProjectFromCwd(ctx.cwd, args.project, ctx.env);
  if (!resolvedProject.ok) return resolvedProject;

  const marker = readMarker(resolvedProject.path);
  if (!marker.ok) return marker;

  const abs = isAbsolute(args.file) ? resolve(args.file) : resolve(resolvedProject.path, args.file);
  const rel = relative(resolvedProject.path, abs);
  if (rel === "" || rel === ".." || rel.startsWith("..") || isAbsolute(rel)) {
    return refusal(`pablo: edit --file ${args.file} resolves outside the project (${resolvedProject.path})`);
  }
  if (!existsSync(abs)) {
    return refusal(`pablo: edit --file ${args.file} does not exist (${abs})`);
  }

  return { ok: true, path: abs, piece: undefined };
}

// ---------------------------------------------------------------------------
// Building the real EditHost.
// ---------------------------------------------------------------------------

function countWords(body: string): number {
  return body.split(/\s+/).filter((word) => word !== "").length;
}

/** The nearest ancestor of `fileDir` holding a `pablo.json`, bounded at `vaultRoot` (when known) so this never walks above the vault. */
function findProjectPath(fileDir: string, vaultRoot: string | undefined): string | undefined {
  let dir = fileDir;
  for (;;) {
    if (existsSync(join(dir, "pablo.json"))) return dir;
    if (vaultRoot !== undefined && resolve(dir) === resolve(vaultRoot)) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface EditContext {
  readonly vaultRoot: string | undefined;
  readonly projectPath: string | undefined;
}

/**
 * Derives the vault/project a file lives under purely from its own path — no
 * `--project`, no cwd needed. This is what lets `openEditor` take nothing but
 * `{path, piece?}` (AC5): both `pablo edit`'s own CLI/MCP resolution and
 * AGT-1259's daemon (which only ever has a queued piece's `path` in hand) get
 * the same revise/check context for free. Either field is `undefined` for a
 * file with no vault or no `pablo.json` above it (a global `prose` piece) —
 * `check`/`revise` degrade gracefully rather than failing to resolve.
 */
export function deriveEditContext(path: string, env: Record<string, string | undefined>): EditContext {
  const dir = dirname(path);
  const vault = findVault(dir, env);
  const vaultRoot = vault.ok ? vault.path : undefined;
  return { vaultRoot, projectPath: findProjectPath(dir, vaultRoot) };
}

async function realRevise(
  input: { path: string; start: number; end: number; instruction: string },
  ectx: EditContext,
  env: Record<string, string | undefined>,
): Promise<{ candidate: string; receipt: unknown }> {
  if (ectx.vaultRoot === undefined || ectx.projectPath === undefined) {
    throw new EditHostError("no-project", `pablo: revise needs a pablo project — none was found above ${input.path}`);
  }

  const reviseCtx: ReviseCoreContext = { vaultRoot: ectx.vaultRoot, projectPath: ectx.projectPath, env };
  const outcome = await reviseCore(
    {
      file: input.path,
      passage: undefined,
      start: input.start,
      end: input.end,
      instruction: input.instruction,
      dryRun: false,
    },
    reviseCtx,
  );

  if (!outcome.body.ok) {
    throw new EditHostError("revise-failed", outcome.body.message);
  }
  const body = outcome.body as ReviseSendBody;
  return { candidate: body.candidate, receipt: body.receipt };
}

function buildEditHostDeps(path: string, piece: PieceRecord | undefined, env: Record<string, string | undefined>): EditHostDeps {
  const ectx = deriveEditContext(path, env);
  const rules: CheckRules = ectx.vaultRoot !== undefined ? loadCheckRules(ectx.vaultRoot) : { stockNames: [], flaggedLines: [] };

  return {
    path,
    piece,
    queuePath: stateReviewPath(env),
    readFile: (p) => readFileSync(p, "utf8"),
    writeFile: (p, text) => writeFileSync(p, text, "utf8"),
    gitCommit: (dir, paths, message) => {
      const result = gitCommitPaths(dir, message, paths);
      return result.committed ? { ok: true } : { ok: false, detail: result.notice };
    },
    revise: (input) => realRevise(input, ectx, env),
    check: (body) => checkFile(body, path, rules),
    countWords,
    now: () => new Date(),
  };
}

// ---------------------------------------------------------------------------
// openEditor — the shared mount, AC2/AC5.
// ---------------------------------------------------------------------------

const VIEWS_ROOT = resolve(import.meta.dir, "..", "views");
/** After `disconnected` with no `reconnected`, close the window (AC3). */
const DISCONNECT_CLOSE_DELAY_MS = 5000;

export interface OpenEditorDeps {
  readonly env: Record<string, string | undefined>;
  readonly existsExecutable: (path: string) => boolean;
  /**
   * Forwarded to `mount()`'s own `silent` option — production always gets the
   * default `true` (AC2). The one caller that overrides it is
   * `edit-mount.test.ts`: with `UI_LEAF_NO_OPEN` set, ui-leaf's only channel
   * for the auth-tokened URL is a stderr notice (the served page and the
   * public `url` are deliberately fragment-free — see ui-leaf's README's
   * "Remote / SSH sessions" section), which `silent: true` discards.
   */
  readonly silent: boolean;
}

export interface OpenEditorOptions {
  /** Absolute (or cwd-relative) path to the file being edited. */
  readonly path: string;
  /** The queue record, when this file is a queued piece. */
  readonly piece?: PieceRecord;
  readonly signal?: AbortSignal;
  /** Injectable for tests — never required in production. */
  readonly deps?: Partial<OpenEditorDeps>;
}

export interface OpenEditorResult {
  readonly url: string;
  readonly closed: Promise<void>;
  close(): void;
}

/**
 * Mounts `views/editor.tsx` on `opts.path` and returns ui-leaf's handle,
 * reshaped to AC5's contract. Refuses (throws `EditError`, code 2) before
 * ever calling `mount()` when no Chromium-family browser is installed (AC4) —
 * `shell: "app"` would otherwise silently fall back to a plain tab.
 */
export async function openEditor(opts: OpenEditorOptions): Promise<OpenEditorResult> {
  const env = opts.deps?.env ?? process.env;
  const existsExecutable = opts.deps?.existsExecutable ?? defaultExistsExecutable;
  const silent = opts.deps?.silent ?? true;

  if (findChromium(existsExecutable) === undefined) {
    throw new EditError(2, NO_CHROMIUM_MESSAGE);
  }

  // ui-leaf reads this from its own inherited environment (there is no `env`
  // mount option) and, on its own initiative, suppresses the launch under an
  // SSH session — wrong here, since the daemon hosting this window may well
  // be started from an ssh session on a Mac with a screen. Only defaulted, so
  // an explicit UI_LEAF_NO_OPEN (e.g. "1" in a test) is still honoured.
  if (process.env["UI_LEAF_NO_OPEN"] === undefined) {
    process.env["UI_LEAF_NO_OPEN"] = "0";
  }

  const absPath = resolve(opts.path);
  const hostDeps = buildEditHostDeps(absPath, opts.piece, env);
  const host = createEditHost(hostDeps);

  const mutations: Record<string, MutationHandler> = {
    save: (args) => host.save(args as { text: string }),
    revise: (args) => host.revise(args as { start: number; end: number; instruction: string }),
    approve: () => host.approve(),
    reject: (args) => host.reject(args as { reason?: string }),
    refresh: () => host.refresh(),
  };

  const data = host.data();

  const view = await mount({
    view: "editor",
    viewsRoot: VIEWS_ROOT,
    data,
    title: data.title,
    mutations,
    shell: "app",
    port: 0,
    silent,
    heartbeatTimeoutMs: 70_000,
    signal: opts.signal,
  });

  let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  view.onDisconnect(() => {
    if (disconnectTimer !== undefined) clearTimeout(disconnectTimer);
    disconnectTimer = setTimeout(() => {
      void view.close();
    }, DISCONNECT_CLOSE_DELAY_MS);
  });
  view.onReconnect(() => {
    if (disconnectTimer !== undefined) {
      clearTimeout(disconnectTimer);
      disconnectTimer = undefined;
    }
  });

  const closed = view.closed.then(() => {
    if (disconnectTimer !== undefined) clearTimeout(disconnectTimer);
  });

  return {
    url: view.url,
    closed,
    close: () => {
      void view.close();
    },
  };
}

// ---------------------------------------------------------------------------
// The CLI wrapper — blocks until the window closes (AC3), unlike `verbs.ts`'s
// MCP tool, which returns `{url}` immediately (see that file's `runEditVerb`).
// ---------------------------------------------------------------------------

export interface EditCliArgs {
  readonly project: string | undefined;
  readonly file: string | undefined;
  readonly piece: string | undefined;
  readonly json: boolean;
}

function emitRefusal(code: number, message: string, json: boolean): void {
  if (json) console.log(JSON.stringify({ ok: false, code, message }));
  else console.error(message);
}

/** `pablo edit --project <slug> --file F` or `pablo edit --piece <id>`. Prints the URL (`--json`: `{url}`), holds the process open until the window closes, then exits 0. */
export async function runEdit(args: EditCliArgs, cwd: string, env: Record<string, string | undefined> = process.env): Promise<number> {
  const target = resolveEditTarget({ project: args.project, file: args.file, piece: args.piece }, { cwd, env });
  if (!target.ok) {
    emitRefusal(target.code, target.message, args.json);
    return target.code;
  }

  let opened: OpenEditorResult;
  try {
    opened = await openEditor({ path: target.path, piece: target.piece, deps: { env } });
  } catch (error) {
    if (error instanceof EditError) {
      emitRefusal(error.code, error.message, args.json);
      return error.code;
    }
    throw error;
  }

  if (args.json) console.log(JSON.stringify({ url: opened.url }));
  else console.log(opened.url);

  await opened.closed;
  return 0;
}
