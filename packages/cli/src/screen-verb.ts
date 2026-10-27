// The `o` keys on the screen (AGT-2179, D-3): each runs the CLI verb of that name. The verb runs as a child of this same
// CLI (argv, no shell) in the work's directory and its output comes back as lines for the content area. The tui cannot
// import this package, so cli.ts passes the function in through runScreen's options (like `screenVoicer`).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { VerbResult, VerbRunner } from "@openthink/pablo-tui"; // types only: the tui stays lazy at runtime

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

/** `pablo <argv>` in `dir`, with `--project <slug>` added for the verbs that take one. A non-zero exit is the verb's refusal, said as it said it. */
export function screenVerb(dir: string, slug: string | undefined, run: readonly string[] = [process.execPath, CLI]): VerbRunner {
  return (argv) => new Promise((resolve) => {
    const takesProject = slug !== undefined && argv[0] !== "config";
    const [bin, ...head] = run; // `run` is never empty: it defaults to the running binary and the CLI file
    const child = spawn(bin!, [...head, ...argv, ...(takesProject ? ["--project", slug] : [])], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("error", () => resolve({ ok: false, message: `pablo ${argv.join(" ")} could not be started.` }));
    child.on("close", (code) => {
      const text = (code === 0 ? out || err : err || out).trim();
      if (code === 0) return resolve({ ok: true, lines: text.split("\n") });
      resolve({ ok: false, message: text || `pablo ${argv.join(" ")} stopped (exit ${code}) without saying why.` });
    });
  });
}
