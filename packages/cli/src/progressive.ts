/**
 * The progressive render's two queues (AGT-1697, pm project `pablo-casting`, "On demand: speed and the
 * progressive render"): the writer (the LLM endpoint) and the engine (the MLX GPU) are different devices,
 * so episode N+1 is written while episode N performs. Each queue is serial (pablo's rule: one request at a
 * time to a local endpoint, and only the engine and the gates compete for the GPU), and the engine takes an
 * episode only once its script is written.
 *
 * `runProgressive` is device-agnostic: `write` and `perform` are whatever the caller runs on each queue.
 * `pablo perform --stream --all` runs the engine queue alone over scripts already written (`write`
 * absent); the story pipeline (AGT-1700) supplies `write` as well. A step that fails stops both queues: the
 * writer starts nothing new, the engine performs nothing it has not started, and the report says where the
 * run stopped and why. Nothing is retried here; every step is resumable on its own (`write` on its branch,
 * `perform` from its stored takes).
 */

export interface StepOutcome {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly body: unknown;
}

export interface ProgressiveSteps {
  /** The units (episodes), in the order they are written and performed. */
  readonly units: readonly number[];
  /** Writes one unit's script. Absent when every script already exists. */
  readonly write?: (unit: number) => Promise<StepOutcome>;
  /** Performs one unit (and publishes it as it finishes). */
  readonly perform: (unit: number) => Promise<StepOutcome>;
  /** Milliseconds; the run's timings are measured from its first call. Default `Date.now`. */
  readonly now?: () => number;
}

/** When a step ran, in ms from the start of the run. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

export interface UnitReport {
  readonly unit: number;
  readonly written?: Span & { readonly outcome: StepOutcome };
  readonly performed?: Span & { readonly outcome: StepOutcome };
}

export interface ProgressiveReport {
  readonly ok: boolean;
  /** 0, or the failing step's exit code. */
  readonly exitCode: number;
  readonly units: readonly UnitReport[];
  /** The unit and queue the run stopped at, when a step failed. */
  readonly stopped?: { readonly unit: number; readonly queue: "writer" | "engine"; readonly outcome: StepOutcome };
}

export async function runProgressive(steps: ProgressiveSteps): Promise<ProgressiveReport> {
  const clock = steps.now ?? Date.now;
  const origin = clock();
  const at = (): number => clock() - origin;
  const reports = new Map<number, { written?: UnitReport["written"]; performed?: UnitReport["performed"] }>(steps.units.map((u) => [u, {}]));
  // Held in an object: both queues set it from their own async steps.
  const run: { stopped?: ProgressiveReport["stopped"] } = {};

  const timed = async (run: () => Promise<StepOutcome>): Promise<Span & { readonly outcome: StepOutcome }> => {
    const start = at();
    let outcome: StepOutcome;
    try {
      outcome = await run();
    } catch (error) {
      outcome = { ok: false, exitCode: 1, body: { ok: false, code: 1, message: (error as Error).message } };
    }
    return { start, end: at(), outcome };
  };

  // The writer queue: one script after another, never waiting for the engine; it stops starting new ones
  // once anything has failed.
  const written: Promise<boolean>[] = [];
  let writer: Promise<boolean> = Promise.resolve(true);
  for (const unit of steps.units) {
    const write = steps.write;
    writer = writer.then(async (ready) => {
      if (!ready || run.stopped !== undefined) return false;
      if (write === undefined) return true;
      const step = await timed(() => write(unit));
      (reports.get(unit) as { written?: UnitReport["written"] }).written = step;
      if (!step.outcome.ok && run.stopped === undefined) run.stopped = { unit, queue: "writer", outcome: step.outcome };
      return step.outcome.ok;
    });
    written.push(writer);
  }

  // The engine queue: each unit once its script is written, one at a time, in order.
  for (const [k, unit] of steps.units.entries()) {
    const ready = await (written[k] as Promise<boolean>);
    if (!ready || run.stopped !== undefined) break;
    const step = await timed(() => steps.perform(unit));
    (reports.get(unit) as { performed?: UnitReport["performed"] }).performed = step;
    if (!step.outcome.ok) {
      run.stopped = { unit, queue: "engine", outcome: step.outcome };
      break;
    }
  }
  await writer; // a write already started finishes (it is on its own branch); none starts after a stop

  const units: UnitReport[] = steps.units.map((unit) => ({ unit, ...reports.get(unit) }));
  return run.stopped === undefined ? { ok: true, exitCode: 0, units } : { ok: false, exitCode: run.stopped.outcome.exitCode || 1, units, stopped: run.stopped };
}
