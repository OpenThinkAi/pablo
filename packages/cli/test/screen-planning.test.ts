import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { screenPlanner } from "../src/screen-planning";

/** `r ...` on the screen (AGT-2178) against a temp copy of the fixture vault: input is checked before anything is written. */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pablo-screen-planning-"));
  roots.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  return { vault, project: join(vault, "novels", "ice-house"), env: { PABLO_VAULT: vault } as NodeJS.ProcessEnv };
}

test("a line that is missing its parts is refused with what to type; nothing runs", async () => {
  const { vault, project, env } = setup();
  const plan = screenPlanner(vault, project, env);
  for (const [id, line] of [["plan.save", "premise"], ["research.save", "Only a title"], ["research.waive", "3"], ["research.link", "x"], ["fact.record", "invented continuity"]] as const) {
    const r = await plan(id, line);
    expect(r.ok, id).toBe(false);
  }
});

test("save refuses a file outside the vault; an unknown id is refused", async () => {
  const { vault, project, env } = setup();
  const plan = screenPlanner(vault, project, env);
  const r = await plan("plan.save", "premise /etc/hosts");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.message).toContain("inside the vault");
  expect((await plan("nope", "")).ok).toBe(false);
});

test("research waive on a work with no checklist is refused by the verb, not thrown", async () => {
  const { vault, project, env } = setup();
  const r = await screenPlanner(vault, project, env)("research.waive", "1 No sources.");
  expect(r.ok).toBe(false);
});
