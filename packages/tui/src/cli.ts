#!/usr/bin/env bun
import { existsSync, statSync } from "node:fs";
import { USAGE } from "./usage";

export type Invocation =
  | { readonly kind: "usage" }
  | { readonly kind: "open"; readonly path: string }
  | { readonly kind: "error"; readonly message: string };

/**
 * `pablo` prints usage; `pablo <file.md>` opens the manuscript view. There is
 * no third form yet, and an unreadable path is an error rather than an empty
 * view — the file is the product, so failing to find it is worth saying.
 */
export function parseArgs(argv: readonly string[]): Invocation {
  const args = argv.filter((arg) => arg.length > 0);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) return { kind: "usage" };
  if (args.length > 1) return { kind: "error", message: `pablo: expected one file, got ${args.length}` };

  const path = args[0] ?? "";
  if (path.startsWith("-")) return { kind: "error", message: `pablo: unknown option ${path}` };
  if (!existsSync(path)) return { kind: "error", message: `pablo: no such file: ${path}` };
  if (statSync(path).isDirectory()) return { kind: "error", message: `pablo: ${path} is a directory` };
  return { kind: "open", path };
}

async function main(argv: readonly string[]): Promise<number> {
  const invocation = parseArgs(argv);

  if (invocation.kind === "usage") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (invocation.kind === "error") {
    process.stderr.write(`${invocation.message}\n`);
    return 2;
  }
  if (process.stdout.isTTY !== true) {
    process.stderr.write("pablo: the manuscript view needs a terminal; stdout is not a tty\n");
    return 1;
  }

  // Imported lazily so `pablo` with no arguments never loads the renderer.
  const { runView } = await import("./view");
  await runView(invocation.path);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
