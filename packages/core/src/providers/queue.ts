/**
 * One request in flight per local endpoint.
 *
 * On 2026-09-01 mlx_lm.server was sent three prompts at once (37k, 22k and 9k
 * tokens) and its generate thread died with a Metal out-of-memory. Requests to
 * an endpoint marked `local` queue here instead; the gate is held for the whole
 * stream, not just the HTTP round trip.
 */

export class Gate {
  #tail: Promise<void> = Promise.resolve();

  /** Resolves when the caller holds the gate. Call the returned release exactly once. */
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ahead = this.#tail;
    this.#tail = ahead.then(() => held);
    await ahead;
    return release;
  }
}
