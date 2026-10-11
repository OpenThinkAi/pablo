import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import Mixer from "../views/mixer";
import type { MixDocument, MixPayload } from "../views/mixer-protocol";

/**
 * AGT-1768: the mixer view rendered to static markup (react-dom/server: no browser, no window, no effects), and
 * bundled the way the ui-leaf binary bundles it. Playback needs a real Chrome and is not covered here; what it
 * plays is `mixer-logic.ts`'s, tested in `mixer-logic.test.ts`.
 */
const G = JSON.parse(readFileSync(join(import.meta.dir, "../../casting/tests/fixtures/mix-anchors-golden.json"), "utf8"));
const DOC = G.document as MixDocument;
const KEY = (n: number): string => n.toString(16).padStart(64, "0");

const PAYLOAD: MixPayload = {
  episode: 1,
  title: "The First Night",
  version: 2,
  newest: 2,
  versions: [
    { version: 1, by: "auto", created: "t1", parent: null, manifest_version: 1 },
    { version: 2, by: "human", created: "t2", parent: 1, manifest_version: 1, summary: "bed-b faded out" },
  ],
  document: DOC,
  manifest: {
    version: 1,
    duration: 6,
    lines: [
      { i: 0, speaker: "KEEPER", text: "Who keeps the lamp tonight?", take: KEY(1), stretch: 1, start: 0.5, end: 1.75 },
      { i: 1, speaker: "TOLLER", text: "I do.", take: KEY(2), stretch: 1.1, start: 1.55, end: 2.45 },
    ],
    cues: [{ index: 0, kind: "SFX", desc: "a gull overhead", key: KEY(0xa0), after: 1, line: null, start: null, end: null }],
  },
  latestManifest: 2,
  layout: [],
};

const noMutate = (async () => undefined) as never;

test("before the host answers, the view says it is loading the episode's mix", () => {
  const html = renderToStaticMarkup(<Mixer data={{ title: "The Lamp Room", episode: 1 }} mutate={noMutate} />);
  expect(html).toContain("Loading episode 1");
});

test("a loaded mix draws the four fixed tracks, a lane per role, labelled clips, the versions and the transport", () => {
  const html = renderToStaticMarkup(<Mixer data={{ title: "The Lamp Room", episode: 1 }} mutate={noMutate} preloaded={PAYLOAD} />);
  for (const track of ["Dialogue", "SFX", "Beds", "Music"]) expect(html).toContain(`>${track}<`);
  expect(html).toContain(">KEEPER<");
  expect(html).toContain(">TOLLER<");
  expect(html).toContain("Who keeps the lamp tonight?");
  expect(html).toContain("a gull overhead");
  expect(html).toContain("Episode 1: The First Night");
  expect(html).toContain("v1 (auto)");
  expect(html).toContain("v2 (human)");
  expect(html).toContain("bed-b faded out");
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Play<\/button>/); // no audio decoded yet
  expect(html).toContain("the newest is v2"); // the mix is behind a fix
  expect((html.match(/class="clip"/g) ?? []).length).toBe(8);
  expect(html).toContain("-2.0 dB"); // the document's SFX volume
  expect((html.match(/class="playhead"/g) ?? []).length).toBe(1);
});

test("a clip that cannot be placed is listed by field, and the rest of the mix still draws", () => {
  const broken = {
    ...DOC,
    tracks: { ...DOC.tracks, music: { lanes: { main: { clips: [{ ...DOC.tracks.music.lanes["main"]?.clips[0], anchor: { line: 42, edge: "end", offset: 0 } }] } } } },
  } as MixDocument;
  const html = renderToStaticMarkup(<Mixer data={{ title: "t", episode: 1 }} mutate={noMutate} preloaded={{ ...PAYLOAD, document: broken }} />);
  expect(html).toContain("tracks.music.lanes.main.clips[0].anchor: anchors to line 42, which no dialogue clip voices");
  expect((html.match(/class="clip"/g) ?? []).length).toBe(7);
});

test("the view bundles the way the ui-leaf binary bundles it and calls only loadMix, peaks, clipAudio and the marker mutations", async () => {
  const result = await Bun.build({
    entrypoints: [new URL("../views/mixer.tsx", import.meta.url).pathname],
    external: ["react", "react/jsx-runtime", "react-dom", "react-dom/client"],
    target: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  expect(result.success).toBe(true);
  const text = (await result.outputs[0]?.text()) ?? "";
  const called = new Set([...text.matchAll(/mutate\(\s*"([A-Za-z]+)"/g)].map((m) => m[1]));
  expect([...called].sort()).toEqual(["clipAudio", "deleteNote", "exportNotes", "listNotes", "loadMix", "notesToFlags", "peaks", "saveNote"]);
  expect(text).not.toContain("saveMix"); // read-only: saving is M5
});
