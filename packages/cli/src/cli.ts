#!/usr/bin/env bun
/**
 * `pablo` — the CLI that writes: the manager for writing projects, driven by
 * whatever agent you like (Claude Code, Codex, pi). See
 * `~/saltline-digital-vault/projects/ai-terminal/README.md` for the design.
 *
 * This is the P0 skeleton: argument parsing, `--help`, and `--project`
 * resolution are real; every verb body is a stub. Exit codes are the
 * contract every later ticket builds on: 0 ok, 2 refused (a framework
 * precondition — an unresolvable `--project`, or later an unmet stage
 * precondition), 1 error (including "not implemented yet").
 */

import { parseArgs } from "node:util";
import { resolveProjectFromCwd } from "./project";
import type { Refusal } from "./project";

/** Verbs P0 ships: the manager for novels (see the design doc's build order). */
const P0_VERBS = ["init", "resume", "status", "write", "save", "check", "dry-run", "mcp"] as const;

/** Verbs planned for P1/P2 — listed in `--help` as later, not yet wired up. */
const LATER_VERBS = ["revise", "voice", "edit", "share", "notes", "publish"] as const;

const ALL_VERBS: readonly string[] = [...P0_VERBS, ...LATER_VERBS];

export const EXIT_OK = 0;
export const EXIT_REFUSED = 2;
export const EXIT_ERROR = 1;

function helpText(): string {
  return [
    "pablo — the CLI that writes: the manager for writing projects (novels, stories, essays)",
    "",
    "Usage: pablo <verb> [--project <slug>] [--json] [options]",
    "",
    "Verbs:",
    ...P0_VERBS.map((verb) => `  ${verb}`),
    "",
    "Later (not yet implemented):",
    ...LATER_VERBS.map((verb) => `  ${verb}`),
    "",
    "Every verb accepts --project <slug> and --json.",
    "--project resolves to <vault>/<kind>/<slug> (kind: novels, stories, essays).",
    "The vault is $PABLO_VAULT if set, else the nearest ancestor of the current",
    "directory holding a style/ directory.",
    "",
    "Exit codes: 0 ok, 2 refused (a framework precondition), 1 error.",
  ].join("\n");
}

interface ParsedArgs {
  readonly verb: string | undefined;
  readonly project: string | undefined;
  readonly json: boolean;
  readonly help: boolean;
}

export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  const { values, positionals } = parseArgs({
    args: argv as string[],
    allowPositionals: true,
    strict: false,
    options: {
      project: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  return {
    verb: positionals[0],
    project: typeof values["project"] === "string" ? values["project"] : undefined,
    json: values["json"] === true,
    help: values["help"] === true,
  };
}

interface Result {
  readonly ok: boolean;
  readonly code: number;
  readonly message: string;
  readonly tried?: readonly string[];
}

function emit(result: Result, json: boolean): void {
  if (json) {
    const body: Record<string, unknown> = { ok: result.ok, code: result.code, message: result.message };
    if (result.tried) body["tried"] = result.tried;
    console.log(JSON.stringify(body));
    return;
  }
  if (result.ok) console.log(result.message);
  else console.error(result.message);
}

function refusalResult(refusal: Refusal): Result {
  return { ok: false, code: refusal.code, message: refusal.message, tried: refusal.tried };
}

/** Runs the CLI for `argv` (already stripped of `bun`/script name) and returns the process exit code. */
export function main(argv: readonly string[], cwd: string = process.cwd()): number {
  const args = parseCliArgs(argv);

  if (args.help || args.verb === undefined) {
    console.log(helpText());
    return EXIT_OK;
  }

  if (!ALL_VERBS.includes(args.verb)) {
    const message = `pablo: unknown verb "${args.verb}" — run "pablo --help" for the list`;
    emit({ ok: false, code: EXIT_ERROR, message }, args.json);
    return EXIT_ERROR;
  }

  if (args.project !== undefined) {
    const resolved = resolveProjectFromCwd(cwd, args.project);
    if (!resolved.ok) {
      emit(refusalResult(resolved), args.json);
      return resolved.code;
    }
  }

  const message = `pablo: "${args.verb}" not implemented yet`;
  emit({ ok: false, code: EXIT_ERROR, message }, args.json);
  return EXIT_ERROR;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
