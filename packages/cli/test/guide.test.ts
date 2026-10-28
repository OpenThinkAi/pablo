// AGT-2142 (D-16): `pablo guide` composes the path for a track x output from the registries.
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { buildGuide, guide, guideIndex, guideText } from "../src/guide";
import type { Guide, GuidePhase } from "../src/guide";
import { outputDefinition, outputsOnTrack } from "../src/outputs/registry";
import { trackDefinition, trackIds } from "../src/tracks/registry";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const ORDER: readonly GuidePhase[] = ["create", "core", "research", "output", "write", "check", "publish"];

function ok(track: string, output: string): Guide {
  const outcome = buildGuide(track, output);
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome;
}

test("every registered track x allowed output produces a guide, or a refusal naming what it waits on", () => {
  let pairs = 0;
  for (const track of trackIds()) {
    const usable = guideIndex(track).tracks[0]!.outputs;
    for (const output of outputsOnTrack(track)) {
      if (!usable.includes(output)) {
        const refused = buildGuide(track, output);
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.message).toMatch(/has none built yet/);
        continue;
      }
      const g = ok(track, output);
      pairs++;
      expect(g.track).toBe(track);
      expect(g.output).toBe(output);
      expect(g.steps[0]!.phase).toBe("create");
      expect(g.steps[0]!.command).toContain(`pablo init --track ${track}`);
      expect(g.steps.at(-2)!.phase).toBe("check");
      expect(g.steps.at(-1)!.phase).toBe("publish");
      for (const step of g.steps) expect(step.command.startsWith("pablo ")).toBe(true);
      // Every core stage of the track appears, in the track's order.
      const coreStages = [...new Set(g.steps.filter((s) => s.stage !== undefined && (s.phase === "core" || s.phase === "research")).map((s) => s.stage))];
      expect(coreStages).toEqual([...trackDefinition(track).coreStages]);
      // Every output stage but publish has a write step; publish names the type's targets.
      const def = outputDefinition(output)!;
      const outStages = [...new Set(g.steps.filter((s) => s.phase === "write").map((s) => s.stage))];
      expect(outStages).toEqual(def.stages.filter((s) => s !== "publish"));
      for (const target of def.publish.targets) expect(g.steps.at(-1)!.detail).toContain(target);
      // The write phase comes after the core and the output is added before it.
      const firstWrite = g.steps.findIndex((s) => s.phase === "write");
      const lastCore = g.steps.map((s) => s.phase === "core" || s.phase === "research").lastIndexOf(true);
      const add = g.steps.findIndex((s) => s.phase === "output");
      expect(lastCore).toBeLessThan(add);
      expect(add).toBeLessThan(firstWrite);
      expect(ORDER.includes(g.steps[firstWrite]!.phase)).toBe(true);
    }
  }
  expect(pairs).toBeGreaterThanOrEqual(10);
});

test("research is a gated checklist on historical-fiction and nonfiction, optional on fiction", () => {
  const research = (t: string, o: string) => ok(t, o).steps.filter((s) => s.stage === "research");
  expect(research("fiction", "novel").every((s) => s.optional === true && s.gate === undefined)).toBe(true);
  for (const [t, o] of [["historical-fiction", "novel"], ["historical-fiction", "narrated"]] as const) {
    const steps = research(t, o);
    expect(steps.every((s) => s.gate === true)).toBe(true);
    expect(steps.map((s) => s.command).join("\n")).toContain("pablo research plan");
    expect(steps.map((s) => s.command).join("\n")).toContain("pablo research waive");
  }
  expect(ok("historical-fiction", "novel").steps.some((s) => s.command.includes("pablo research distill"))).toBe(true);
});

test("output-specific verbs: story has no --unit, radio casts and mixes by episode, narrated adds over a prose output", () => {
  expect(ok("fiction", "story").steps.find((s) => s.phase === "write")!.command).toBe("pablo write --project <slug> --output story");
  const radio = ok("fiction", "radio").steps.map((s) => s.command);
  expect(radio).toContain("pablo cast --auto --project <slug> --episode N");
  expect(radio).toContain("pablo mix --project <slug> --episode N");
  const narrated = ok("fiction", "narrated").steps.filter((s) => s.phase === "output").map((s) => s.command);
  expect(narrated).toEqual(["pablo output add <novel|story|essay> --project <slug>", "pablo output add narrated --from <novel|story|essay> --project <slug>"]);
});

test("essay is built on every track; narrated on nonfiction reads the essay (AGT-2134)", () => {
  for (const track of trackIds()) expect(guideIndex(track).tracks[0]!.outputs).toContain("essay");
  const essay = ok("nonfiction", "essay");
  expect(essay.steps.find((s) => s.phase === "write")!.command).toBe("pablo write --project <slug> --output essay --unit N");
  expect(essay.steps.find((s) => s.phase === "output")!.detail).toContain("core/outline.md");
  expect(essay.steps.at(-1)!.detail).toBe("targets: draft, final");
  const narrated = ok("nonfiction", "narrated").steps.filter((s) => s.phase === "output").map((s) => s.command);
  expect(narrated).toEqual(["pablo output add <essay> --project <slug>", "pablo output add narrated --from <essay> --project <slug>"]);
  const t = guideIndex("nonfiction").tracks[0]!;
  expect(t.outputs).toEqual(["narrated", "essay"]);
  expect(t.waiting).toEqual([]);
  expect(t.planned).toEqual([]);
});

test("refusals name what to pick: unknown track, unknown output, a disallowed output, a planned one not built", () => {
  const cases: [string, string, RegExp][] = [
    ["romance", "novel", /unknown track "romance"/],
    ["fiction", "podcast", /unknown output "podcast"/],
    ["nonfiction", "novel", /not allowed on the nonfiction track/],
  ];
  for (const [t, o, re] of cases) {
    const outcome = buildGuide(t, o);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) continue;
    expect(outcome.code).toBe(2);
    expect(outcome.message).toMatch(re);
    expect(outcome.missing.length).toBe(1);
  }
});

test("no flags lists every track and output; --track alone scopes it; --output alone reads fiction", () => {
  const index = guideIndex();
  expect(index.tracks.map((t) => t.id)).toEqual(trackIds());
  expect(index.outputs.map((o) => o.id)).toContain("novel");
  expect(index.outputs.map((o) => o.id)).toContain("essay");
  const scoped = guide({ track: "nonfiction" });
  expect(scoped.ok && "tracks" in scoped ? scoped.outputs.map((o) => o.id) : []).toEqual(outputsOnTrack("nonfiction"));
  expect(scoped.ok && "tracks" in scoped ? scoped.tracks[0]!.outputs : ["x"]).toEqual(["narrated", "essay"]);
  const novel = guide({ output: "novel" });
  expect(novel.ok && "steps" in novel ? novel.track : undefined).toBe("fiction");
  expect(guideText(guideIndex())).toContain("Tracks:");
  expect(guideText(ok("fiction", "novel"))).toContain("pablo guide: fiction track, novel output");
});

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const r = Bun.spawnSync(["bun", "run", CLI, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PABLO_VAULT: "" } });
  return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), exitCode: r.exitCode };
}

test("pablo guide runs with no vault: the list, a path, --json, and a refusal exits 2", () => {
  const list = runCli(["guide"]);
  expect(list.exitCode).toBe(0);
  expect(list.stdout).toContain("Outputs:");
  const json = runCli(["guide", "--track", "historical-fiction", "--output", "narrated", "--json"]);
  expect(json.exitCode).toBe(0);
  expect(JSON.parse(json.stdout)).toEqual(JSON.parse(JSON.stringify(buildGuide("historical-fiction", "narrated"))));
  const refused = runCli(["guide", "--track", "nonfiction", "--output", "radio"]);
  expect(refused.exitCode).toBe(2);
  expect(refused.stderr).toContain("not allowed on the nonfiction track");
});

// AGT-2193: the draft step names the configured writer model, and the outline step the `#N` claim convention.
test("the draft step names the configured writer model, or says none is configured", () => {
  const draft = (g: Guide) => g.steps.find((s) => s.phase === "write")!.title;
  expect(draft(ok("fiction", "novel"))).toContain("the configured writer model");
  expect(draft(ok("fiction", "novel"))).not.toContain("local model");
  const named = buildGuide("fiction", "novel", "anthropic (some-model)");
  if (!named.ok) throw new Error(named.message);
  expect(draft(named)).toBe("draft each chapter on anthropic (some-model)");
  expect(guide({ track: "fiction", output: "novel" }, "local (qwen)")).toMatchObject({ ok: true });
});

test("the nonfiction outline step explains the #N claim convention", () => {
  const step = ok("nonfiction", "essay").steps.find((s) => s.stage === "outline")!;
  expect(step.detail).toContain("#2, #3");
});
