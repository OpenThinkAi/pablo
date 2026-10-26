import { expect, test } from "bun:test";
import { ProviderConfigError, envVariableFor, keySourceFor, resolveKey } from "../src/index";

test("a provider's key comes from <PROVIDER>_API_KEY by convention", () => {
  expect(envVariableFor("anthropic")).toBe("ANTHROPIC_API_KEY");
  expect(envVariableFor("openai")).toBe("OPENAI_API_KEY");
  expect(envVariableFor("my-proxy")).toBe("MY_PROXY_API_KEY");

  expect(resolveKey(keySourceFor("anthropic"), { env: { ANTHROPIC_API_KEY: "from-env" } })).toBe("from-env");
  expect(resolveKey(keySourceFor("anthropic"), { env: {} })).toBeUndefined();
});

test("a keychain reference reads service and account", () => {
  expect(keySourceFor("anthropic", "keychain:ANTHROPIC_API_KEY_PERSONAL/mattpardini")).toEqual({
    from: "keychain",
    service: "ANTHROPIC_API_KEY_PERSONAL",
    account: "mattpardini",
  });
  expect(keySourceFor("openai", "keychain:OPENAI_API_KEY")).toEqual({
    from: "keychain",
    service: "OPENAI_API_KEY",
    account: undefined,
  });
});

test("a keychain reference resolves through the security lookup, which is never given a shell", () => {
  const asked: [string, string | undefined][] = [];
  const key = resolveKey(keySourceFor("anthropic", "keychain:ANTHROPIC_API_KEY_PERSONAL/mattpardini"), {
    keychain: (service, account) => {
      asked.push([service, account]);
      return "from-keychain";
    },
  });

  expect(key).toBe("from-keychain");
  expect(asked).toEqual([["ANTHROPIC_API_KEY_PERSONAL", "mattpardini"]]);
});

test("a literal key is rejected with the two forms that are allowed", () => {
  expect(() => keySourceFor("openai", "sk-notarealkey")).toThrow(ProviderConfigError);
  expect(() => keySourceFor("openai", "sk-notarealkey")).toThrow(/OPENAI_API_KEY environment variable/);
  expect(() => keySourceFor("openai", "sk-notarealkey")).toThrow(/keychain:<service>\[\/<account>\]/);
});

test("a malformed keychain reference is rejected", () => {
  expect(() => keySourceFor("openai", "keychain:")).toThrow(ProviderConfigError);
  expect(() => keySourceFor("openai", "keychain:SERVICE/")).toThrow(ProviderConfigError);
});

test("an env: reference names the variable the key is read from (AGT-2129)", () => {
  const source = keySourceFor("anthropic", "env:WORK_ANTHROPIC_KEY");
  expect(source).toEqual({ from: "env", variable: "WORK_ANTHROPIC_KEY" });
  expect(resolveKey(source, { env: { WORK_ANTHROPIC_KEY: "from-env", ANTHROPIC_API_KEY: "not-this" } })).toBe("from-env");
  expect(() => keySourceFor("anthropic", "env:")).toThrow(ProviderConfigError);
  expect(() => keySourceFor("anthropic", "env:1BAD")).toThrow(ProviderConfigError);
});
