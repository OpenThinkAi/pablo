import { expect, test } from "bun:test";
import { DEFAULT_ACTIONS } from "../src/keys";
import { VERB_ROUTES, verbArgs } from "../src/verb-routes";

test("every routed verb is a key action, and every `o` action is routed", () => {
  const ids = new Set(DEFAULT_ACTIONS.map((a) => a.id));
  for (const id of Object.keys(VERB_ROUTES)) expect(ids.has(id), id).toBe(true);
  for (const a of DEFAULT_ACTIONS.filter((a) => a.prefix === "o")) expect(a.id in VERB_ROUTES, a.id).toBe(true);
});

test("verbArgs builds the CLI argv", () => {
  expect(verbArgs("output.add", ["essay"])).toEqual({ ok: true, argv: ["output", "add", "essay"] });
  expect(verbArgs("config.show")).toEqual({ ok: true, argv: ["config", "show"] });
  expect(verbArgs("nope").ok).toBe(false);
});

test("config set takes key references only and never echoes a value", () => {
  expect(verbArgs("config.set", ["providers.a.key", "env:A_KEY"]).ok).toBe(true);
  expect(verbArgs("config.set", ["providers.a.key", "keychain:pablo/a"]).ok).toBe(true);
  expect(verbArgs("config.set", ["providers.a.model", "gemma"]).ok).toBe(true);
  const bad = verbArgs("config.set", ["providers.a.key", "sk-secret-123"]);
  expect(bad.ok).toBe(false);
  expect(JSON.stringify(bad)).not.toContain("sk-secret-123");
});
