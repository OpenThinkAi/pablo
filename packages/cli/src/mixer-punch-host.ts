/**
 * The mixer's punch list (AGT-2155, D-19): the line actions `pablo review` and the CLI had, in the mixer window.
 * Every mutation calls what the CLI calls, so the window can do nothing the CLI cannot:
 *
 *  - `listFlags({episode})` — the open flags, human and auto, as the review player lists them (`episodeFlags`);
 *  - `flag({episode, line, reason?, time?})` / `unflag({episode, line?, id?})` — the review player's own `flag` and
 *    `unflag` (`createReviewHost`), so a flag written here is byte-for-byte the format `pablo review` writes;
 *  - `retake({episode, line, reason?})` — flags the line with `reason` first when one is given (the reason is what
 *    `fix` bumps: `wrong voice` colder, `flat` hotter, `rushed` slower), then `pablo fix --line` (`runFix`): only
 *    that line's open flags are applied, and the version is remixed, so a mix saved in the mixer is rebased onto
 *    the new take (`mix.rebase`, AGT-2153);
 *  - `lineTakes({episode, line})` — `pablo takes line`: every take the line has had, to compare (the view plays
 *    each through `clipAudio`);
 *  - `chooseTake({episode, line, take})` — `pablo takes choose`: the next manifest version with that take back on
 *    the line, remixed like a fix, so the chosen take lands in the mix through the same rebase.
 *
 * A failure is a thrown plain-words `Error` in the Python side's own words; ui-leaf hands it to the view.
 */

import type { ChosenTakePayload, FlagsPayload, LineTakesPayload, RetakePayload } from "../views/mixer-protocol";
import { runTakes } from "./casting";
import type { CastingDeps } from "./casting";
import { runFix } from "./casting-verbs";
import { createReviewHost, episodeFlags } from "./review-host";

type Env = Record<string, string | undefined>;

export interface PunchHost {
  listFlags(args: unknown): FlagsPayload;
  flag(args: unknown): FlagsPayload;
  unflag(args: unknown): FlagsPayload;
  retake(args: unknown): Promise<RetakePayload>;
  lineTakes(args: unknown): Promise<LineTakesPayload>;
  chooseTake(args: unknown): Promise<ChosenTakePayload>;
}

export interface PunchHostOptions {
  readonly work: string;
  readonly title: string;
  readonly vault?: string;
  readonly library?: string;
  readonly env: Env;
  readonly casting: CastingDeps;
  readonly stderr?: { write(text: string): unknown };
  readonly now?: () => Date;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const KEY = /^[0-9a-f]{64}$/;

function episodeArg(args: unknown): number {
  const value = isRecord(args) ? args["episode"] : undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error("episode must be a whole number of 1 or more");
  return value;
}

function lineArg(args: unknown): number {
  const value = isRecord(args) ? args["line"] : undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("line must be a whole number of 0 or more");
  return value;
}

/** The body of a casting run, or its own words thrown. */
function bodyOf(result: { body: unknown; exitCode: number }, what: string): Record<string, unknown> {
  const body = isRecord(result.body) ? result.body : {};
  if (result.exitCode !== 0 || body["ok"] === false) throw new Error(typeof body["message"] === "string" ? body["message"] : `${what} failed (exit ${result.exitCode})`);
  return body;
}

export function createPunchHost(options: PunchHostOptions): PunchHost {
  const { work } = options;
  const ctx = { env: options.env, stderr: options.stderr ?? { write: () => undefined } };
  const review = createReviewHost({ work, title: options.title, ...(options.now === undefined ? {} : { now: options.now }) });
  const where = { ...(options.vault === undefined ? {} : { vault: options.vault }), ...(options.library === undefined ? {} : { library: options.library }) };

  async function takesOf(episode: number, line: number): Promise<LineTakesPayload> {
    const body = bodyOf(await runTakes({ sub: "line", key: undefined, yes: false, episode, line }, ctx, options.casting, work), "takes line");
    return {
      episode,
      line,
      speaker: String(body["speaker"] ?? ""),
      text: String(body["text"] ?? ""),
      version: body["version"] as number,
      current: String(body["current"] ?? ""),
      takes: Array.isArray(body["takes"]) ? (body["takes"] as LineTakesPayload["takes"]) : [],
    };
  }

  return {
    listFlags(args) {
      const episode = episodeArg(args);
      return { episode, flags: episodeFlags(work, episode) };
    },

    flag(args) {
      const episode = episodeArg(args);
      lineArg(args);
      review.flag(args);
      return { episode, flags: episodeFlags(work, episode) };
    },

    unflag(args) {
      const episode = episodeArg(args);
      review.unflag(args);
      return { episode, flags: episodeFlags(work, episode) };
    },

    async retake(args) {
      const episode = episodeArg(args);
      const line = lineArg(args);
      const reason = isRecord(args) ? args["reason"] : undefined;
      if (reason !== undefined) review.flag({ episode, line, reason });
      if (!episodeFlags(work, episode).some((f) => f.line === line)) {
        throw new Error(`line ${line} of episode ${episode} has no open flag: flag it with a reason first (the reason is what the re-take changes)`);
      }
      const body = bodyOf(await runFix({ work, episode, line, ...where, env: options.env, stderr: ctx.stderr, casting: options.casting }), "the re-take");
      return {
        episode,
        line,
        version: body["version"] as number,
        fromVersion: body["fromVersion"] as number,
        changedLines: Array.isArray(body["changedLines"]) ? (body["changedLines"] as number[]) : [],
        mixed: body["mixed"] === true,
        message: typeof body["message"] === "string" ? body["message"] : "",
        flags: episodeFlags(work, episode),
        takes: await takesOf(episode, line),
      };
    },

    async lineTakes(args) {
      return takesOf(episodeArg(args), lineArg(args));
    },

    async chooseTake(args) {
      const episode = episodeArg(args);
      const line = lineArg(args);
      const take = isRecord(args) ? args["take"] : undefined;
      if (typeof take !== "string" || !KEY.test(take)) throw new Error("take must be a 64-character hex take key");
      const body = bodyOf(await runTakes({ sub: "choose", key: take, yes: false, episode, line, ...where }, ctx, options.casting, work), "choosing the take");
      return {
        episode,
        line,
        take,
        version: body["version"] as number,
        mixed: body["mixed"] === true,
        message: typeof body["message"] === "string" ? body["message"] : "",
        takes: await takesOf(episode, line),
      };
    },
  };
}
