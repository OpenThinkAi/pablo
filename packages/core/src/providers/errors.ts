/**
 * Typed failures for the provider layer. Every message addresses the author,
 * names the endpoint, and says what to do next; none of them carry a key, a
 * request body, or anything else that would leak a secret into a log.
 */

/** A config file, env var, or Keychain lookup that cannot produce a usable provider. */
export class ProviderConfigError extends Error {
  override readonly name: string = "ProviderConfigError";
}

/**
 * A verb needed a model and the config names none (AGT-2131, D-13). pablo has
 * no built-in endpoint or model id, so a fresh install refuses here, pointing
 * at `pablo config` and the starter file, before any request is made.
 */
export class NoModelConfiguredError extends ProviderConfigError {
  override readonly name = "NoModelConfiguredError";

  constructor(intent?: string) {
    super(
      `pablo: no model is configured${intent === undefined ? "" : ` for "${intent}"`} — pablo ships with no default endpoint or model. ` +
        `Run \`pablo init --config\` to write a starter config, then edit it with \`pablo config set\` ` +
        `(\`pablo config show\` prints what is set; see docs/configuration.md).`,
    );
  }
}

/**
 * The endpoint sent nothing for `timeoutMs`. The renderer shows this and
 * offers a retry: the request is unchanged and adapters are pure functions of
 * it, so retrying is the same one-line call that produced the error.
 */
export class EndpointHung extends Error {
  override readonly name = "EndpointHung";

  constructor(
    readonly endpoint: string,
    readonly elapsedMs: number,
    readonly timeoutMs: number,
  ) {
    super(
      `pablo: the model at ${endpoint} sent nothing for ${Math.round(timeoutMs / 1000)}s ` +
        `(${Math.round(elapsedMs / 1000)}s in total) — is the server running? Retry, or point at another provider.`,
    );
  }
}

/** The endpoint answered, but not with a completion pablo can use. */
export class ProviderResponseError extends Error {
  override readonly name: string = "ProviderResponseError";

  constructor(
    readonly endpoint: string,
    readonly detail: string,
    readonly status?: number,
  ) {
    super(
      status === undefined
        ? `pablo: the model at ${endpoint} returned ${detail}`
        : `pablo: the model at ${endpoint} returned HTTP ${status}: ${detail}`,
    );
  }
}

/**
 * The endpoint could not be reached at all: the connection was refused, the
 * host did not resolve, or the network failed before a response arrived. A
 * subclass of `ProviderResponseError`, so every caller that already turns a
 * bad response into a refusal does the same here instead of crashing. For a
 * local provider the message also names the usual cause on a new setup: no
 * local model, with the writing intents still routed to it.
 */
export class EndpointUnreachable extends ProviderResponseError {
  override readonly name = "EndpointUnreachable";
  constructor(endpoint: string, cause: string, local: boolean) {
    super(endpoint, cause);
    this.message =
      `pablo: could not reach the model at ${endpoint} (${cause}) — is the server running? ` +
      (local
        ? `If you have no local model, route the writing intents to another provider with "intents" in the config (\`pablo config show\`, docs/configuration.md).`
        : `Check the endpoint and your network, or point at another provider.`);
  }
}

/**
 * The endpoint answered a forced tool call with no tool call at all. It keeps
 * the raw `finish_reason` and the answer it did give, so a caller can fall back
 * to plain text and a failure report can say what the server actually sent
 * (AGT-1271: Gemma behind mlx_lm answered `extract_facts` with nothing).
 */
export class NoToolCallError extends ProviderResponseError {
  override readonly name = "NoToolCallError";

  constructor(
    endpoint: string,
    readonly tool: string,
    readonly finishReason: string,
    /** The first 200 characters of the assistant's content, or "" when it sent none. */
    readonly answer: string,
  ) {
    super(endpoint, `no ${tool} tool call (finish_reason: ${finishReason}) — it answered with ${answer === "" ? "nothing" : answer}`);
  }
}

/**
 * A `chat()` turn offered tools to a provider whose config says `"tools": false`
 * (AGT-2117, D-12). Refused before any request is sent, so a server with no
 * tool support never sees a schema it would silently ignore.
 */
export class ToolsDisabledError extends ProviderConfigError {
  override readonly name = "ToolsDisabledError";

  constructor(readonly providerId: string) {
    super(
      `pablo: provider "${providerId}" is configured with "tools": false, so it cannot take a chat turn that offers tools — ` +
        `remove "tools": false from its config if the server supports tool calls, or route this intent to a provider that does.`,
    );
  }
}

/**
 * A `claude-code` provider (AGT-2281) whose `claude` executable is not there:
 * not on PATH, or not at the configured `binary` path. Refused before anything
 * is started.
 */
export class ClaudeCodeMissingError extends ProviderConfigError {
  override readonly name = "ClaudeCodeMissingError";

  constructor(
    readonly binary: string,
    readonly providerId?: string,
  ) {
    const field = providerId === undefined ? '"binary"' : `\`pablo config set providers.${providerId}.binary <path>\``;
    super(
      `pablo: cannot find \`${binary}\` (Claude Code) to run \`claude -p\`. Install Claude Code (https://claude.com/claude-code) ` +
        `and log in once (\`claude auth login\`), or point ${field} at the claude executable.`,
    );
  }
}

/**
 * `claude -p` answered that the Claude login is missing, expired or rejected
 * (AGT-2281). The fix is the author's: `claude auth login` (on Claude Code
 * 2.1.x the login is the `auth login` subcommand, not a bare `claude login`).
 */
export class ClaudeCodeSignedOutError extends ProviderConfigError {
  override readonly name = "ClaudeCodeSignedOutError";

  constructor(
    readonly providerId: string,
    /** What claude said, one line, never a credential. */
    readonly detail: string,
  ) {
    super(
      `pablo: provider "${providerId}" runs \`claude -p\` on your Claude login, and it is not signed in (claude said: ${detail}). ` +
        `Log in with \`claude auth login\` (Claude Code's login command; \`/login\` inside \`claude\` does the same), then run \`pablo config test\`.`,
    );
  }
}
