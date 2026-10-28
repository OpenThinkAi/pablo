/**
 * `pablo guide` (AGT-2142, pm project `pablo-platform`, D-16): the
 * step-by-step path from nothing to a finished piece for one track × output,
 * so a cold agent (or author) has a named starting point. Every step is
 * composed from the registries, never written out per pair: the track's core
 * stages (`TRACKS[t].coreStages`) in order, the research stage expanded where
 * the track gates it, then the output's own stages (`OUTPUTS[o].stages`),
 * `check`, and its publish targets. A new track, output or stage that this
 * file has no verb for fails `test/guide.test.ts`, which builds a guide for
 * every registered track × allowed output.
 *
 * Pure over its arguments (the caller passes the writer model's name via `writerModel`). `<slug>`, `<Title>`, `N` and the like
 * are placeholders for the caller to fill.
 */

// The registry first: it must initialise before the output modules it imports (narrated, the core machine) are read.
import { outputDefinition, outputIds, outputsOnTrack } from "./outputs/registry";
import type { CoreStageId } from "./core/machine";
import { PERIOD_FACTS_FILE, loadConfig, resolveRoute } from "@openthink/pablo-core";
import { PERIOD_BRIEF_FILE } from "./core/machine";
import { CHECKLIST_FILE } from "./core/checklist";
import { CLAIMS_FILE, OUTLINE_FILE, THESIS_FILE } from "./core/nonfiction";
import { isNarratableSource } from "./outputs/narrated";
import type { OutputDefinition } from "./outputs/types";
import { DEFAULT_TRACK, isTrackId, trackDefinition, trackIds } from "./tracks/registry";
import type { TrackId } from "./tracks/registry";

/**
 * The model `write` drafts on: the provider the `draft` intent routes to under the configured providers (and, with
 * `projectDir`, the work's own `pablo.json`), as `anthropic (the-model-id)`. Undefined when no model is configured or the
 * config cannot be read: the guide then says so rather than naming a model.
 */
export function writerModel(env: Record<string, string | undefined>, projectDir?: string): string | undefined {
  try {
    const config = loadConfig({ env, ...(projectDir === undefined ? {} : { projectDir }) });
    const provider = config.providers.get(resolveRoute(config, { name: "draft", kind: "drafting" }).provider);
    return provider === undefined ? undefined : `${provider.id} (${provider.model})`;
  } catch {
    return undefined;
  }
}

/** Where a step sits on the path, in the order the path runs. */
export type GuidePhase = "create" | "core" | "research" | "output" | "write" | "check" | "publish";

export interface GuideStep {
  readonly phase: GuidePhase;
  /** The core or output stage the step meets, when it meets one. */
  readonly stage?: string;
  /** What to do, in a few words. */
  readonly title: string;
  /** The verb that does it, with placeholders (`<slug>`, `N`). */
  readonly command: string;
  /** More about the step, when a line helps. */
  readonly detail?: string;
  /** The track gates drafting on this step (`write` refuses until it is met). */
  readonly gate?: true;
  /** The step is optional on this track. */
  readonly optional?: true;
}

export interface Guide {
  readonly track: TrackId;
  readonly output: string;
  readonly steps: readonly GuideStep[];
}

export type GuideOutcome =
  | ({ readonly ok: true } & Guide)
  | { readonly ok: false; readonly code: 2; readonly message: string; readonly missing: readonly string[] };

/** `guide` with no pair: what there is to choose from. */
export interface GuideIndex {
  readonly ok: true;
  readonly tracks: readonly { readonly id: TrackId; readonly coreStages: readonly string[]; readonly outputs: readonly string[]; readonly waiting: readonly string[]; readonly planned: readonly string[] }[];
  readonly outputs: readonly { readonly id: string; readonly noun: string; readonly tracks: readonly TrackId[]; readonly stages: readonly string[]; readonly targets: readonly string[] }[];
  readonly next: string;
}

const P = "--project <slug>";

/** One core stage's step on `track`; `research` is expanded by `researchSteps`. */
function coreStep(stage: CoreStageId, track: TrackId): GuideStep[] {
  switch (stage) {
    case "premise":
      return [{ phase: "core", stage, title: "save the premise (a logline in bible/overview.md)", command: `pablo save ${P} --stage premise` }];
    case "period":
      return [{ phase: "core", stage, gate: true, title: `save the period brief (${PERIOD_BRIEF_FILE})`, command: `pablo save ${P} --stage ${PERIOD_BRIEF_FILE}` }];
    case "research":
      return researchSteps(track);
    case "period-facts":
      return [
        {
          phase: "research",
          stage,
          gate: true,
          title: `distill the research into sourced period facts (${PERIOD_FACTS_FILE})`,
          command: `pablo research distill ${P}`,
          detail: "the only research the drafting model sees; accept its plan/ branch in the screen (bare `pablo`)",
        },
      ];
    case "bible":
      return [
        {
          phase: "core",
          stage,
          title: "save the bible (characters, places, timeline)",
          command: `pablo save ${P} --stage bible/<file>`,
          detail: "bible/characters/<name>.md, bible/places.md, bible/timeline.md",
        },
      ];
    case "acts":
      return [
        {
          phase: "core",
          stage,
          title: "save the acts table",
          command: `pablo save ${P} --stage acts`,
          detail: "| Act | Years | What it accomplishes |: the act's id (I, II or 1, 2), the story time it spans (years, or dates for a short work), what it does",
        },
      ];
    case "beats":
      return [{ phase: "core", stage, title: "save the beats (one row per beat, with a story date)", command: `pablo save ${P} --stage beats` }];
    case "facts":
      return [
        {
          phase: "core",
          stage,
          title: "decide every [pick] in the bible",
          command: `pablo save ${P} --stage bible/<file>`,
          detail: "a [pick] blocks only the units whose beat names it",
        },
      ];
    case "thesis":
      return [{ phase: "core", stage, gate: true, title: `save the thesis (${THESIS_FILE})`, command: `pablo save ${P} --stage thesis` }];
    case "claims":
      return [
        {
          phase: "core",
          stage,
          gate: true,
          title: `save the claims, each citing a research note (${CLAIMS_FILE})`,
          command: `pablo save ${P} --stage claims`,
        },
      ];
    case "outline":
      return [
        {
          phase: "core",
          stage,
          gate: true,
          title: `save the outline sections (${OUTLINE_FILE})`,
          command: `pablo save ${P} --stage outline`,
          detail: 'name the claims a section makes in its "What it covers" cell as #2, #3 (none named: the section gets every claim); a number the claims table lacks refuses the draft',
        },
      ];
  }
}

/** The research stage: the guided checklist on a track that gates it (D-9), an optional note otherwise. */
function researchSteps(track: TrackId): GuideStep[] {
  const gated = track === "historical-fiction" || track === "nonfiction";
  if (!gated) {
    return [
      {
        phase: "research",
        stage: "research",
        optional: true,
        title: "keep any research as sourced notes",
        command: `pablo research save ${P} --title <text> --note <text> --source <url>`,
      },
    ];
  }
  return [
    {
      phase: "research",
      stage: "research",
      gate: true,
      title: `plan the research checklist (${CHECKLIST_FILE})`,
      command: `pablo research plan ${P}`,
      detail: "accept its plan/ branch in the screen (bare `pablo`) before sourcing or waiving items",
    },
    {
      phase: "research",
      stage: "research",
      gate: true,
      title: "source each checklist item with a note",
      command: `pablo research save ${P} --title <text> --note <text> --source <url> --item <#>`,
    },
    {
      phase: "research",
      stage: "research",
      gate: true,
      title: "or waive items, with a reason",
      command: `pablo research waive <#,#,a-b> "<reason>" ${P}`,
      detail: "several items go on one branch; accept a waive or link branch in the screen before starting the next (two unaccepted ones conflict); the gate opens when every item is sourced or waived",
    },
  ];
}

/** `write` for one unit of `def`: the story has one unit, so no `--unit`. */
function writeCommand(def: OutputDefinition): string {
  return def.soleUnit !== undefined ? `pablo write ${P} --output ${def.id}` : `pablo write ${P} --output ${def.id} --unit N`;
}

/** The unit flag the audio verbs take for `def`: radio's `--episode N`, anything else's `--output <id> --unit N`. */
function audioUnit(def: OutputDefinition): string {
  return def.id === "radio" ? "--episode N" : `--output ${def.id} --unit N`;
}

/** One output stage's steps (every stage but `publish`, which `buildGuide` adds after `check`). */
function outputStageSteps(def: OutputDefinition, stage: string, writer?: string): GuideStep[] | undefined {
  const each = def.soleUnit !== undefined ? `the ${def.noun}` : `each ${def.noun}`;
  switch (stage) {
    case "chapter":
    case "draft":
    case "script":
      return [
        {
          phase: "write",
          stage,
          title: `draft ${each} on ${writer === undefined ? "the configured writer model (none is configured: pablo init --config)" : writer}`,
          command: writeCommand(def),
          detail: `the draft lands on a draft/ branch; the author reads and accepts it (pablo merge ${P} <branch>, or the screen)`,
        },
      ];
    case "narrate":
      return [
        {
          phase: "write",
          stage,
          title: `make ${each} from the source's unit (no model)`,
          command: writeCommand(def),
          detail: `add --voices characters to give characters their own lines; the author accepts it (pablo merge ${P} <branch>, or the screen)`,
        },
      ];
    case "revise":
      return [
        {
          phase: "write",
          stage,
          optional: true,
          title: `revise passages of ${each}`,
          command: `pablo revise ${P} --file <file> --passage "<text>" --instruction "<text>" --branch`,
          detail: "or revise in the screen (bare `pablo`); accept the revise/ branch there",
        },
      ];
    case "cast":
      return [{ phase: "write", stage, title: `cast the roles of ${each}`, command: `pablo cast --auto ${P} ${audioUnit(def)}`, detail: "or the mixer's Cast panel" }];
    case "perform":
      return [{ phase: "write", stage, title: `perform ${each} in the bound voices`, command: `pablo perform ${P} ${audioUnit(def)}` }];
    case "mix":
      return [{ phase: "write", stage, title: `mix ${each}`, command: `pablo mix ${P} ${audioUnit(def)}`, detail: `edit the mix in pablo mixer ${P} ${audioUnit(def)}` }];
    case "fix":
      return [
        {
          phase: "write",
          stage,
          optional: true,
          title: "re-record flagged lines",
          command: `pablo fix ${P} ${audioUnit(def)}`,
          detail: `flag lines in pablo review ${P} or the mixer's punch list`,
        },
      ];
    default:
      return undefined;
  }
}

/** The built outputs on `track` a derived output (narrated) can read: prose drafted from the core. */
function proseSources(track: TrackId): string[] {
  return outputsOnTrack(track).filter((id) => {
    const src = outputDefinition(id);
    return src !== undefined && isNarratableSource(src);
  });
}

/** Why `def` cannot be finished on `track` yet, or undefined: a derived output with no prose output on the track to read. */
function waitingOn(def: OutputDefinition, track: TrackId): string | undefined {
  if (def.derive === undefined || proseSources(track).length > 0) return undefined;
  const planned = (trackDefinition(track).outputs as readonly string[]).filter((o) => outputDefinition(o) === undefined);
  return `the ${def.id} output reads a prose output, and the ${track} track has none built yet${planned.length === 0 ? "" : ` (planned: ${planned.join(", ")})`}`;
}

/** The steps that add `def` to a work on `track`; a derived output (narrated) first needs a written prose output to read. */
function addSteps(def: OutputDefinition, track: TrackId): GuideStep[] {
  if (def.derive === undefined) {
    const plan = `plan.md: ${def.planNote ?? "which units tell which beats"}`;
    // A fiction track's essay argues a thesis about the story (AGT-2135): the add takes it and scaffolds the outline.
    if (def.scaffold !== undefined && track !== "nonfiction") {
      return [
        {
          phase: "output",
          title: `add the ${def.id} output with its thesis (once the core is in)`,
          command: `pablo output add ${def.id} --thesis "<the one thing it argues about the story>" ${P}`,
          detail: `scaffolds outputs/${def.id}/ (thesis.md; outline.md, its sections drawn from the story core; ${plan}; RULES.md)`,
        },
      ];
    }
    return [{ phase: "output", title: `add the ${def.id} output (once the core is in)`, command: `pablo output add ${def.id} ${P}`, detail: `scaffolds outputs/${def.id}/ (${plan}; RULES.md)` }];
  }
  const from = `<${proseSources(track).join("|")}>`;
  return [
    {
      phase: "output",
      title: `add and write a prose output for the ${def.id} output to read`,
      command: `pablo output add ${from} ${P}`,
      detail: `then draft its units (pablo write ${P} --output ${from} ...), each accepted by the author`,
    },
    { phase: "output", title: `add the ${def.id} output over it`, command: `pablo output add ${def.id} --from ${from} ${P}` },
  ];
}

/** The refusal for a pair `guide` cannot build, naming what to choose instead. */
function refuse(message: string, missing: readonly string[]): GuideOutcome {
  return { ok: false, code: 2, message: `pablo: guide: ${message}`, missing };
}

/**
 * The path for `track` × `output`: create the work, the track's core stages
 * (research expanded where the track gates it), add the output, its stages,
 * check, publish. A refusal for an unknown track or output, an output the
 * track does not allow, or an allowed type pablo does not ship yet.
 */
export function buildGuide(track: string, output: string, writer?: string): GuideOutcome {
  if (!isTrackId(track)) return refuse(`unknown track "${track}" (known: ${trackIds().join(", ")})`, [`--track: ${trackIds().join(" | ")}`]);
  const allowed = outputsOnTrack(track);
  const def = outputDefinition(output);
  if (def === undefined) {
    const planned = (trackDefinition(track).outputs as readonly string[]).includes(output);
    return refuse(
      planned ? `the ${output} output is planned for the ${track} track and not built yet (built: ${allowed.join(", ")})` : `unknown output "${output}" (known: ${outputIds().join(", ")})`,
      [`--output: ${allowed.join(" | ")}`],
    );
  }
  if (!def.tracks.includes(track)) {
    return refuse(`the ${output} output is not allowed on the ${track} track (allowed: ${allowed.length === 0 ? "none" : allowed.join(", ")})`, [`--output: ${allowed.join(" | ")}`]);
  }

  const waiting = waitingOn(def, track);
  if (waiting !== undefined) {
    const usable = allowed.filter((id) => waitingOn(outputDefinition(id) as OutputDefinition, track) === undefined);
    return refuse(waiting, [`--output: ${usable.length === 0 ? "none on this track yet" : usable.join(" | ")}`]);
  }

  const steps: GuideStep[] = [
    {
      phase: "create",
      title: `create the work on the ${track} track`,
      command: `pablo init --track ${track} <slug> "<Title>"`,
      detail: "writes the track's core files and pablo.json; status shows where it stands",
    },
  ];
  for (const stage of trackDefinition(track).coreStages) steps.push(...coreStep(stage as CoreStageId, track));
  steps.push(...addSteps(def, track));
  for (const stage of def.stages) {
    if (stage === "publish") continue;
    const found = outputStageSteps(def, stage, writer);
    if (found === undefined) throw new Error(`pablo: guide: the ${def.id} output's stage "${stage}" has no guide step`);
    steps.push(...found);
  }
  steps.push({
    phase: "check",
    title: `check the ${def.plural}`,
    command: `pablo check ${P} --output ${def.id}`,
    detail: `mechanical tells and provenance; the ${track} track's checks: ${trackDefinition(track).checks.join(", ")}`,
  });
  steps.push({
    phase: "publish",
    title: `publish the ${def.id}`,
    command: `pablo publish ${P} --output ${def.id} --target <target>`,
    detail: `targets: ${def.publish.targets.join(", ")}`,
  });
  return { ok: true, track, output: def.id, steps };
}

/** `guide` with no pair (or only `--track`): the tracks and outputs to choose from. */
export function guideIndex(track?: TrackId): GuideIndex {
  const ids = track === undefined ? trackIds() : [track];
  return {
    ok: true,
    tracks: ids.map((id) => {
      const built = outputsOnTrack(id);
      const waiting = built.filter((o) => waitingOn(outputDefinition(o) as OutputDefinition, id) !== undefined);
      return {
        id,
        coreStages: trackDefinition(id).coreStages,
        outputs: built.filter((o) => !waiting.includes(o)),
        waiting,
        planned: (trackDefinition(id).outputs as readonly string[]).filter((o) => !built.includes(o)),
      };
    }),
    outputs: outputIds()
      .map((id) => outputDefinition(id) as OutputDefinition)
      .filter((def) => track === undefined || def.tracks.includes(track))
      .map((def) => ({ id: def.id, noun: def.noun, tracks: def.tracks, stages: def.stages, targets: def.publish.targets })),
    next: `pablo guide --track ${track ?? "<track>"} --output <output>`,
  };
}

/**
 * The `guide` verb's answer: the index with no flags (or only `track`), the
 * path for a pair. `output` without `track` reads the default track
 * (fiction) when it allows the output, else the first track that does.
 */
export function guide(args: { readonly track?: string | undefined; readonly output?: string | undefined }, writer?: string): GuideIndex | GuideOutcome {
  if (args.output === undefined) {
    if (args.track === undefined) return guideIndex();
    if (!isTrackId(args.track)) return refuse(`unknown track "${args.track}" (known: ${trackIds().join(", ")})`, [`--track: ${trackIds().join(" | ")}`]);
    return guideIndex(args.track);
  }
  if (args.track !== undefined) return buildGuide(args.track, args.output, writer);
  const def = outputDefinition(args.output);
  const track = def === undefined || def.tracks.includes(DEFAULT_TRACK) ? DEFAULT_TRACK : (def.tracks[0] ?? DEFAULT_TRACK);
  return buildGuide(track, args.output, writer);
}

/** The prose form of `guide`'s body. */
export function guideText(body: unknown): string {
  const b = body as Record<string, unknown>;
  if (b["ok"] !== true) return String(b["message"]);
  if (Array.isArray(b["steps"])) {
    const g = b as unknown as Guide;
    const lines = [`pablo guide: ${g.track} track, ${g.output} output`, ""];
    g.steps.forEach((step, i) => {
      const flags = [step.gate === true ? "gate" : "", step.optional === true ? "optional" : ""].filter((f) => f !== "").join(", ");
      lines.push(`${String(i + 1).padStart(2)}. ${step.title}${flags === "" ? "" : ` (${flags})`}`);
      lines.push(`      ${step.command}`);
      if (step.detail !== undefined) lines.push(`      ${step.detail}`);
    });
    lines.push("", "A refused verb names what is missing; pablo status --project <slug> shows where the work stands.");
    return lines.join("\n");
  }
  const index = b as unknown as GuideIndex;
  const lines = ["Tracks:"];
  for (const t of index.tracks) {
    lines.push(`  ${t.id.padEnd(20)}core: ${t.coreStages.join(", ")}`);
    const extra = [t.waiting.length === 0 ? "" : `waiting on a prose output: ${t.waiting.join(", ")}`, t.planned.length === 0 ? "" : `planned: ${t.planned.join(", ")}`].filter((x) => x !== "");
    lines.push(`  ${"".padEnd(20)}outputs: ${t.outputs.length === 0 ? "none yet" : t.outputs.join(", ")}${extra.length === 0 ? "" : ` (${extra.join("; ")})`}`);
  }
  lines.push("", "Outputs:");
  for (const o of index.outputs) lines.push(`  ${o.id.padEnd(12)}${o.stages.join(" > ")}  (tracks: ${o.tracks.join(", ")}; targets: ${o.targets.join(", ")})`);
  lines.push("", `Next: ${index.next}`);
  return lines.join("\n");
}
