/**
 * The performed outputs (AGT-2158, pm project `pablo-platform`, D-7, D-19):
 * `radio` and `narrated` are the two outputs `cast`, `perform`, `mix`, `fix`
 * and `mixer` work on. Each keeps its scripts and its own casting state
 * (`cast.json`, `flags.json`, `renders/epNN/`, `takes/`) under its own
 * directory, so narrated unit 1 and radio episode 1 never share a binding,
 * a flag or a manifest:
 *
 *     outputs/radio/episodes/      outputs/radio/casting/
 *     outputs/narrated/readings/   outputs/narrated/casting/
 *
 * The Python side (`packages/casting/.../outputs.py`) reads which one a
 * command is on from `PABLO_CASTING_OUTPUT` in its environment, which
 * `audioEnv` sets, so every runner call (the verbs, the mixer's hosts) reaches
 * the right output without a flag of its own.
 *
 * A leaf module, like the types' `units.ts`: no imports from the rest of the cli.
 */

import { join } from "node:path";

/** The outputs that are performed, in the order a refusal lists them. */
export const AUDIO_OUTPUTS = ["radio", "narrated"] as const;
export type AudioOutput = (typeof AUDIO_OUTPUTS)[number];

export function isAudioOutput(value: string): value is AudioOutput {
  return (AUDIO_OUTPUTS as readonly string[]).includes(value);
}

/** The environment variable the Python side reads the output from (`outputs.OUTPUT_ENV`). */
export const CASTING_OUTPUT_ENV = "PABLO_CASTING_OUTPUT";

/** `<work>/outputs/<output>/casting`, absolute. */
export function audioCastingDir(work: string, output: AudioOutput = "radio"): string {
  return join(work, "outputs", output, "casting");
}

/** `env` with the output the Python side should work on. Radio is its default: radio clears a stray setting. */
export function audioEnv<E extends Record<string, string | undefined>>(env: E, output: AudioOutput): E {
  if (output !== "radio") return { ...env, [CASTING_OUTPUT_ENV]: output };
  if (env[CASTING_OUTPUT_ENV] === undefined) return env;
  const { [CASTING_OUTPUT_ENV]: _stray, ...rest } = env;
  return rest as E;
}

/** What a unit of the output is called in a message. */
export function unitNoun(output: AudioOutput): string {
  return output === "radio" ? "episode" : "unit";
}
