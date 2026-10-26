// AGT-2151 (D-3): the TUI and the mixer are the friendly versions of the CLI. This test lists every CLI verb against the
// front-end action that routes it, so a new verb cannot ship without one. A writing/editing verb routes to a TUI key
// action (`DEFAULT_ACTIONS` in packages/tui/src/keys.ts); a casting/production verb routes to a mixer mutation
// (`MUTATIONS` in views/mixer-protocol.ts). A verb with no route yet sits in the table as a known gap and names the
// ticket that closes it; a verb with neither a route nor a gap entry (nor a `support` reason) fails here.
//
// To add a verb: put it in PARITY below. `support` is for verbs that are not editing or composing (setup, inspection,
// serving, publishing); say why. Closing a gap = replace its `gap` with a `route` in the same change.
import { expect, test } from "bun:test";
import { DEFAULT_ACTIONS } from "../../tui/src/keys";
import { MUTATIONS } from "../views/mixer-protocol";
import { ALL_VERBS } from "../src/cli";
import { VERBS } from "../src/verbs";

type Entry =
  | { readonly front: "tui"; readonly route: readonly string[] }
  | { readonly front: "mixer"; readonly route: readonly string[] }
  | { readonly front: "tui" | "mixer"; readonly gap: string }
  | { readonly support: string };

const tui = (...route: string[]): Entry => ({ front: "tui", route });
const mixer = (...route: string[]): Entry => ({ front: "mixer", route });
const gap = (front: "tui" | "mixer", ticket: string): Entry => ({ front, gap: ticket });
const support = (why: string): Entry => ({ support: why });

const PARITY: Readonly<Record<string, Entry>> = {
  // ---- writing and editing -> the TUI
  write: tui("ai.write"),
  draft_unit: tui("ai.write"),
  draft_chapter: tui("ai.write"),
  revise: tui("ai.revise"),
  revise_passage: tui("ai.revise"),
  voice: tui("ai.voice"),
  prose: tui("ai.compose"),
  save: tui("ai.plan"),
  story: tui("ai.compose"),
  output: tui("ai.compose"),
  promote: tui("ai.compose"),
  research: tui("ai.compose"), // via the harness, like save: a plan/ branch the author reviews
  fact: tui("ai.compose"), // via the harness, like save and promote
  critique: tui("review.comment"),
  merge: tui("review.finish"),
  check: tui("go.hit_next"),
  // ---- casting and production -> the mixer
  audition: mixer("auditionVoices", "candidateAudio", "previewVoice"),
  cast: mixer("castCandidate", "castRoles"),
  voices: mixer("listVoices"),
  describe_voice: mixer("describeVoice"),
  bind: mixer("bindVoice", "reperformRole"),
  perform: mixer("retake"), // a line is performed again from the punch list (AGT-2155); a first performance is the CLI's
  mix: mixer("renderMix"),
  fix: mixer("retake", "flag", "unflag", "listFlags"),
  takes: mixer("lineTakes", "chooseTake"),
  // ---- not editing or composing
  init: support("scaffolds a new work; run once"),
  resume: support("read-only session summary for an agent"),
  status: support("read-only; the TUI rail is the status"),
  timeline: support("read-only story-time view"),
  read: support("read-only; the TUI main pane reads documents"),
  search: support("read-only"),
  migrate: support("one-off migrations"),
  publish: support("export, not editing"),
  share: support("review rounds; being removed (AGT-2094)"),
  notes: support("review round notes; being removed (AGT-2094)"),
  mcp: support("serves the verbs to agents"),
  agent: support("headless harness entry"),
  doctor: support("environment check"),
  config: support("model config: show, set, test"),
  gate: support("pipeline gate inspection"),
  review: support("the review window is itself a front end"),
  mixer: support("is the mixer"),
  "dry-run": support("later-verb stub (AGT-2098)"),
};

const liveVerbs = (): string[] => [...new Set([...ALL_VERBS, ...VERBS.map((v) => v.name)])].sort();

test("every CLI verb has a parity entry", () => {
  const missing = liveVerbs().filter((v) => !(v in PARITY));
  expect(missing, `verbs with no front-end route, gap or support reason: ${missing.join(", ")}`).toEqual([]);
});

test("no parity entry names a verb that does not exist", () => {
  const live = new Set(liveVerbs());
  const stale = Object.keys(PARITY).filter((v) => !live.has(v));
  expect(stale).toEqual([]);
});

test("every route names a real front-end action", () => {
  const tuiIds = new Set(DEFAULT_ACTIONS.map((a) => a.id));
  const mixerIds = new Set<string>(MUTATIONS);
  const bad: string[] = [];
  for (const [verb, e] of Object.entries(PARITY)) {
    if (!("route" in e)) continue;
    const known = e.front === "tui" ? tuiIds : mixerIds;
    if (e.route.length === 0) bad.push(`${verb}: empty route`);
    for (const id of e.route) if (!known.has(id)) bad.push(`${verb}: no ${e.front} action "${id}"`);
  }
  expect(bad).toEqual([]);
});

test("every known gap names the ticket that closes it", () => {
  const bad = Object.entries(PARITY).filter(([, e]) => "gap" in e && !/^AGT-\d+$/.test(e.gap)).map(([v]) => v);
  expect(bad).toEqual([]);
});

const frontOf = (e: Entry | undefined): string | undefined => (e !== undefined && "front" in e ? e.front : undefined);

test("casting and production verbs route to the mixer, writing verbs to the TUI", () => {
  for (const v of ["audition", "cast", "voices", "describe_voice", "bind", "perform", "mix", "fix", "takes"]) expect(frontOf(PARITY[v])).toBe("mixer");
  for (const v of ["write", "revise", "voice", "merge"]) expect(frontOf(PARITY[v])).toBe("tui");
});
