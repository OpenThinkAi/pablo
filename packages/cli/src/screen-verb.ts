// The `o` keys on the screen (AGT-2179, D-3): each runs the CLI verb of that name. The verb runs as a child of this same
// CLI (argv, no shell) in the work's directory and its output comes back as lines for the content area. The tui cannot
// import this package, so cli.ts passes the function in through runScreen's options (like `screenVoicer`).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export type ScreenVerbResult = { readonly ok: true; readonly lines: readonly string[] } | { readonly ok: false; readonly message: string };
export type ScreenVerb = (argv: readonly string[]) => Promise<ScreenVerbResult>;

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

/** `pablo <argv>` in `dir`, with `--project <slug>` added for the verbs that take one. A non-zero exit is the verb's refusal, said as it said it. */
export function screenVerb(dir: string, slug: string | undefined, run: readonly string[] = [process.execPath, CLI]): ScreenVerb {
  return (argv) => new Promise((resolve) => {
    const takesProject = slug !== undefined && argv[0] !== "config";
    const [bin, ...head] = run;
    const child = spawn(bin!, [...head, ...argv, ...(takesProject ? ["--project", slug] : [])], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("error", (e) => resolve({ ok: false, message: e.message }));
    child.on("close", (code) => {
      const lines = (code === 0 ? out || err : err || out).trim().split("\n");
      resolve(code === 0 ? { ok: true, lines } : { ok: false, message: lines.join("\n") });
    });
  });
}
