/**
 * Which credential a harness session runs on (AGT-1552): Matt's Claude
 * subscription by default, an Anthropic key in pablo's config overriding it.
 *
 * The choice is the planner's (`claudeCredential` in core, AGT-1548), so the two
 * never disagree. The environment handling is `claude -p`'s too: the Agent SDK
 * starts the same Claude Code process, and `subscriptionEnv` removes every
 * variable that would outrank the `/login` session (an `ANTHROPIC_API_KEY`
 * left in the shell must not silently bill the API). On the key route the
 * resolved key is put back as `ANTHROPIC_API_KEY`, which Claude Code prefers
 * over the login. The key goes into the child's environment and nowhere else.
 */

import { claudeCredential, subscriptionEnv } from "@openthink/pablo-core";
import type { KeyLookup, PabloConfig } from "@openthink/pablo-core";
import { VERSION } from "../version";

export type HarnessRoute = "subscription" | "api-key";

export interface HarnessAuth {
  readonly route: HarnessRoute;
  /** The Claude Code process's whole environment (the SDK's `env` replaces, it does not merge). */
  readonly env: Record<string, string | undefined>;
  /** The configured provider's model on the key route; absent means the login's default. */
  readonly model?: string;
}

/** Identifies pablo in the User-Agent the SDK sends; the version comes from package.json. */
export const CLIENT_APP = `pablo/${VERSION}`;

export function harnessAuth(
  config: PabloConfig,
  base: Record<string, string | undefined>,
  keys?: Partial<KeyLookup>,
): HarnessAuth {
  const credential = claudeCredential(config, keys);
  const env = { ...subscriptionEnv(base), CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP };
  if (credential.route === "subscription") return { route: "subscription", env };
  return {
    route: "api-key",
    env: { ...env, ANTHROPIC_API_KEY: credential.key },
    model: credential.provider.model,
  };
}
