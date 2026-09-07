import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findChromium, openEditor } from "../src/edit";

/**
 * The one real mount the ticket asks for (AC6): a genuine `openEditor()` call
 * against `views/editor.tsx` through the real `ui-leaf` binary, on a temp
 * copy of the synthetic fixture vault — never `~/writing`. `UI_LEAF_NO_OPEN=1`
 * so no browser window actually opens; the server still comes up and answers
 * `/mutate` over plain HTTP (the same contract a browser tab uses), which is
 * how `refresh` is round-tripped through the host with no browser at all.
 *
 * Self-skips, with a note, when either precondition is missing rather than
 * failing: no `ui-leaf-bin` native binary (e.g. a fresh checkout that hasn't
 * run `bun install`, or an offline postinstall), or no Chromium-family
 * browser (the same probe `openEditor` itself refuses on, AC4) — this repo's
 * CI/dev machines vary on both.
 */

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));

const cleanupDirs: string[] = [];

function tempVault(): { chapterPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "pablo-edit-mount-test-"));
  cleanupDirs.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  return { chapterPath: join(vault, "novels", "ice-house", "chapters", "01-the-last-full-cut.md") };
}

/** Where `spawnUiLeaf`'s own default resolution finds the binary — same module, same path. */
function resolveUiLeafBinary(): string | undefined {
  try {
    const entry = Bun.resolveSync("@openthink/ui-leaf", import.meta.dir);
    const pkgRoot = resolve(dirname(entry), "..");
    const bin = join(pkgRoot, "bin", process.platform === "win32" ? "ui-leaf-bin.exe" : "ui-leaf-bin");
    return existsSync(bin) ? bin : undefined;
  } catch {
    return undefined;
  }
}

function psCommandLines(): string[] {
  const result = Bun.spawnSync(["ps", "-A", "-o", "command="]);
  return result.stdout.toString().split("\n");
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * The public `view.url` ui-leaf's wrapper hands back is deliberately
 * fragment-free (its own `server.ts`: "The public `url` returned to
 * consumers stays fragment-free") — the auth-tokened URL a browser would
 * open only ever reaches a caller as a stderr notice, printed because
 * `UI_LEAF_NO_OPEN` suppressed the real launch. `openEditor` always passes
 * `silent: true` to `mount()` in production (AC2); this test asks for
 * `silent: false` (an injectable-only override, `OpenEditorDeps.silent`) so
 * that notice reaches this process's own stderr, where it's captured here to
 * recover the token `/mutate` requires — no other public surface exposes it.
 */
async function captureTokenedUrl(fn: () => Promise<void>): Promise<string> {
  const originalWrite = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    return (originalWrite as unknown as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;

  try {
    await fn();
    const found = await waitUntil(() => /https?:\/\/[^\s]+#token=[0-9a-f]+/.test(captured), 5000);
    if (!found) throw new Error(`no tokened URL appeared on stderr; captured:\n${captured}`);
    return /https?:\/\/[^\s]+#token=[0-9a-f]+/.exec(captured)![0];
  } finally {
    process.stderr.write = originalWrite;
  }
}

const uiLeafBinary = resolveUiLeafBinary();
const chromium = findChromium();
const CAN_RUN = uiLeafBinary !== undefined && chromium !== undefined;

/**
 * Whether THIS repo's own `ui-leaf-bin` (resolved to its full, package-scoped
 * path) shows up in `ps`. A bare `"ui-leaf-bin"` substring would also match
 * an unrelated ui-leaf-hosting process elsewhere on the machine (e.g.
 * another project's own daemon) — this checks the exact binary `openEditor`
 * here would spawn, not the name alone.
 */
function ourUiLeafRunning(): boolean {
  if (uiLeafBinary === undefined) return false;
  return psCommandLines().some((line) => line.includes(uiLeafBinary));
}

if (!CAN_RUN) {
  console.log(
    `edit-mount.test.ts: skipping the real mount() — ${
      uiLeafBinary === undefined ? "no ui-leaf native binary found (run bun install)" : "no Chromium-family browser found"
    }`,
  );
}

test.skipIf(!CAN_RUN)(
  "openEditor mounts editor.tsx for real, round-trips refresh through the host, and leaves no process behind",
  async () => {
    const { chapterPath } = tempVault();
    const stateHome = mkdtempSync(join(tmpdir(), "pablo-edit-mount-state-"));
    cleanupDirs.push(stateHome);

    const previousNoOpen = process.env["UI_LEAF_NO_OPEN"];
    process.env["UI_LEAF_NO_OPEN"] = "1";

    // Sanity: nothing of ours is running yet.
    expect(ourUiLeafRunning()).toBe(false);

    let opened: Awaited<ReturnType<typeof openEditor>> | undefined;
    const tokenedUrl = await captureTokenedUrl(async () => {
      opened = await openEditor({
        path: chapterPath,
        deps: { env: { ...process.env, XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: stateHome }, silent: false },
      });
    });
    if (opened === undefined) throw new Error("openEditor never assigned opened");

    try {
      expect(typeof opened.url).toBe("string");
      expect(opened.url.startsWith("http://") || opened.url.startsWith("https://")).toBe(true);

      const parsed = new URL(tokenedUrl);
      const token = new URLSearchParams(parsed.hash.replace(/^#/, "")).get("token");
      expect(token).toBeTruthy();

      const res = await fetch(`${parsed.origin}/mutate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-UI-Leaf-Token": token as string },
        body: JSON.stringify({ name: "refresh", args: {} }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { text: string; title: string; words: number };
      expect(typeof data.text).toBe("string");
      expect(data.text.length).toBeGreaterThan(0);
      expect(data.title.length).toBeGreaterThan(0);
    } finally {
      opened.close();
      await opened.closed;
      if (previousNoOpen === undefined) delete process.env["UI_LEAF_NO_OPEN"];
      else process.env["UI_LEAF_NO_OPEN"] = previousNoOpen;
    }

    const clean = await waitUntil(() => !ourUiLeafRunning(), 5000);
    expect(clean).toBe(true);

    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);
