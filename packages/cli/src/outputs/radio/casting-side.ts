/**
 * The radio output's view of the Python side (AGT-1686): `ensure()` for
 * `pablo story --output radio` (AGT-1690) and the `casting` line `status
 * --for "radio N"` reports. Both only *look*: they read the venv's stamp and
 * whether `uv` is on PATH, and never run `uv`, Python or a model. The first
 * casting verb provisions the side lazily, as it always has (`casting.ts`).
 *
 * The machine comes through `radioMachine`, so `bun test` swaps in a fake
 * `CastingDeps` and an environment and never depends on the host's `uv` or
 * venv. Production code never assigns it.
 */

import { castingState, realCastingDeps, UV_INSTALL } from "../../radio";
import type { CastingDeps } from "../../radio";
import type { EnsureOutcome } from "../types";

type Env = Record<string, string | undefined>;

/** The machine the radio output looks at. Tests assign `deps`/`env`; production leaves them. */
export const radioMachine: { deps: (env: Env) => CastingDeps; env: () => Env } = {
  deps: realCastingDeps,
  env: () => process.env,
};

/** The casting side on this machine, as reported. */
export interface CastingReadiness {
  /** `provisioned`, `not provisioned` (or `stale`: the lock or an extra changed) — provisioned lazily by the first casting verb — or `unavailable`. */
  readonly state: "provisioned" | "not provisioned" | "stale" | "unavailable";
  /** Set when the side cannot be provisioned here: what to install. */
  readonly missing?: readonly string[];
  readonly note: string;
}

/** Reads the casting side's state. Never runs anything. */
export function castingReadiness(env: Env = radioMachine.env(), deps: CastingDeps = radioMachine.deps(env)): CastingReadiness {
  const layout = deps.layout;
  if (layout === undefined) {
    return { state: "unavailable", missing: ["the casting sources (packages/casting)"], note: "the casting sources (packages/casting) are missing from this install" };
  }
  const state = castingState(layout);
  if (state === "provisioned") return { state, note: "the casting side is provisioned" };
  if (deps.which("uv", env) === undefined) {
    return {
      state: "unavailable",
      missing: [`uv (${UV_INSTALL})`],
      note: `the casting side is ${state} and needs uv, which is not on PATH (${UV_INSTALL})`,
    };
  }
  return { state, note: `the casting side is ${state}; the first casting verb provisions it (uv sync --frozen)` };
}

/**
 * `OUTPUTS.radio.ensure`: the radio output can run here when its Python side
 * is provisioned, or can be (its sources are present and `uv` is on PATH).
 * Never provisions: that waits for the first casting verb, so asking for a
 * radio output costs nothing until a voice is needed.
 */
export function ensureRadio(): EnsureOutcome {
  const ready = castingReadiness();
  if (ready.state !== "unavailable") return { ok: true };
  return { ok: false, message: ready.note, ...(ready.missing !== undefined ? { missing: ready.missing } : {}) };
}
