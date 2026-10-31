/**
 * A fake `claude` executable for the `claude-code` provider's tests (AGT-2281):
 * a shell script put first on PATH in a temp directory. It records what it was
 * started with (argv one per line, stdin, cwd, the system prompt file, the
 * environment) into `FAKE_CLAUDE_LOG` and prints `FAKE_CLAUDE_REPLY` (a file
 * holding the JSON `claude -p` would print), exiting `FAKE_CLAUDE_EXIT`. No
 * test ever starts the real `claude`.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = `#!/bin/sh
log="$FAKE_CLAUDE_LOG"
n=$(ls "$log" 2>/dev/null | wc -l | tr -d ' ')
dir="$log/$n"
mkdir -p "$dir"
for a in "$@"; do printf '%s\\n' "$a"; done > "$dir/argv"
cat > "$dir/stdin"
pwd -P > "$dir/cwd"
env > "$dir/env"
prev=""
for a in "$@"; do
  if [ "$prev" = "--system-prompt-file" ]; then cp "$a" "$dir/system"; fi
  prev="$a"
done
cat "$FAKE_CLAUDE_REPLY"
exit "\${FAKE_CLAUDE_EXIT:-0}"
`;

export interface FakeClaudeCall {
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly cwd: string;
  readonly system: string | undefined;
  readonly env: Readonly<Record<string, string>>;
}

export interface FakeClaude {
  /** The directory holding `claude`, to put first on PATH. */
  readonly bin: string;
  /** The environment for the adapter: PATH with the fake first, plus the fake's own variables. */
  readonly env: Record<string, string>;
  /** Sets what the next calls print and exit with. */
  reply(json: unknown, exitCode?: number): void;
  /** Every call so far, in order. */
  calls(): FakeClaudeCall[];
}

/** A successful `claude -p --output-format json` reply, the shape Claude Code 2.1.314 prints. */
export function okReply(result: string, usage: Record<string, number> = { input_tokens: 12, output_tokens: 3 }): Record<string, unknown> {
  return { type: "result", subtype: "success", is_error: false, result, usage, total_cost_usd: 0.01 };
}

export function makeFakeClaude(name = "claude"): FakeClaude {
  const root = mkdtempSync(join(tmpdir(), "pablo-fake-claude-"));
  const bin = join(root, "bin");
  const log = join(root, "log");
  mkdirSync(bin);
  mkdirSync(log);
  const script = join(bin, name);
  writeFileSync(script, SCRIPT);
  chmodSync(script, 0o755);
  const replyFile = join(root, "reply.json");
  writeFileSync(replyFile, JSON.stringify(okReply("ok")));
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`,
    FAKE_CLAUDE_LOG: log,
    FAKE_CLAUDE_REPLY: replyFile,
    FAKE_CLAUDE_EXIT: "0",
  };
  return {
    bin,
    env,
    reply(json, exitCode = 0) {
      writeFileSync(replyFile, typeof json === "string" ? json : JSON.stringify(json));
      env["FAKE_CLAUDE_EXIT"] = String(exitCode);
    },
    calls() {
      const out: FakeClaudeCall[] = [];
      for (let i = 0; existsSync(join(log, String(i))); i += 1) {
        const dir = join(log, String(i));
        const argv = readFileSync(join(dir, "argv"), "utf8").split("\n");
        argv.pop();
        const envLines = readFileSync(join(dir, "env"), "utf8").split("\n");
        const env: Record<string, string> = {};
        for (const line of envLines) {
          const eq = line.indexOf("=");
          if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
        }
        out.push({
          argv,
          stdin: readFileSync(join(dir, "stdin"), "utf8"),
          cwd: readFileSync(join(dir, "cwd"), "utf8").trim(),
          system: existsSync(join(dir, "system")) ? readFileSync(join(dir, "system"), "utf8") : undefined,
          env,
        });
      }
      return out;
    },
  };
}
