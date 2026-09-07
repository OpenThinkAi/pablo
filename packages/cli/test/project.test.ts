import { expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findVault, resolveProject, resolveProjectFromCwd } from "../src/project";

/**
 * The fixture vault under `fixtures/vault` is a copy of `packages/core`'s
 * synthetic fixture: the real writing-vault layout, entirely invented
 * content. Never point these tests at `~/writing`.
 */
const VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NESTED_CWD = join(VAULT, "novels", "ice-house", "chapters");

test("findVault walks up from a nested cwd to the ancestor holding style/", () => {
  const result = findVault(NESTED_CWD, {});

  expect(result.ok).toBe(true);
  if (result.ok) expect(result.path).toBe(VAULT);
});

test("PABLO_VAULT overrides the walk-up search", () => {
  const result = findVault("/tmp/somewhere/unrelated", { PABLO_VAULT: VAULT });

  expect(result.ok).toBe(true);
  if (result.ok) expect(result.path).toBe(VAULT);
});

test("PABLO_VAULT pointing at a directory with no style/ is a refusal naming the path it checked", () => {
  const result = findVault("/tmp/somewhere/unrelated", { PABLO_VAULT: "/tmp/not-a-vault" });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(2);
    expect(result.tried).toEqual(["/tmp/not-a-vault/style"]);
    expect(result.message).toContain("/tmp/not-a-vault/style");
  }
});

test("findVault with no marker anywhere above cwd is a refusal listing every path it tried", () => {
  const result = findVault("/", {});

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(2);
    expect(result.tried.length).toBeGreaterThan(0);
    expect(result.tried).toContain("/style");
  }
});

test("resolveProject finds an existing project under novels/", () => {
  const result = resolveProject(VAULT, "ice-house");

  expect(result).toEqual({
    ok: true,
    path: join(VAULT, "novels", "ice-house"),
    kind: "novels",
    slug: "ice-house",
  });
});

test("resolveProject on an unknown slug is a code-2 refusal naming every kind it tried", () => {
  const result = resolveProject(VAULT, "nope");

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(2);
    expect(result.tried).toEqual([
      join(VAULT, "novels", "nope"),
      join(VAULT, "stories", "nope"),
      join(VAULT, "essays", "nope"),
    ]);
    expect(result.message).toContain("nope");
  }
});

test("resolveProjectFromCwd composes vault lookup and project resolution", () => {
  const found = resolveProjectFromCwd(NESTED_CWD, "ice-house", {});
  expect(found.ok).toBe(true);

  const missing = resolveProjectFromCwd(NESTED_CWD, "nope", {});
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.code).toBe(2);
});
