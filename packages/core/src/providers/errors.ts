/**
 * Typed failures for the provider layer. Every message addresses the author,
 * names the endpoint, and says what to do next; none of them carry a key, a
 * request body, or anything else that would leak a secret into a log.
 */

/** A config file, env var, or Keychain lookup that cannot produce a usable provider. */
export class ProviderConfigError extends Error {
  override readonly name = "ProviderConfigError";
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
  override readonly name = "ProviderResponseError";

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
