import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";
import { renderPack, withReceipts } from "@openthink/pablo-core";
import type { Adapter, CompletionEvent, Pack, Receipt } from "@openthink/pablo-core";
import { renderPeriodFacts } from "../src/distill";
import { readMarker } from "../src/marker";
import type { Marker } from "../src/marker";
import { buildChapterPack } from "../src/novel/pack";
import { buildRadioPack } from "../src/outputs/radio/pack";
import { buildScreenplayPack } from "../src/outputs/screenplay/pack";
import { buildStoryPack } from "../src/outputs/story/pack";

/**
 * AGT-2110 (D-10): `facts/period.md` goes into every fiction drafting pack, the rows dated on or before the unit's
 * story date plus every undated row; the receipt counts them. The fixture's beats are dated January 1929, Winter
 * 1931, Summer 1931 and 1934.
 */
const VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));

const FACTS = [
  { fact: "Ice sold at forty cents a hundredweight.", source: "prices", date: "1929-01" },
  { fact: "Hotel kitchens had begun buying electric refrigerators.", source: "fridges", date: "1931-06" },
  { fact: "The county seat paved its main road.", source: "roads", date: "1934" },
  { fact: "A pond was scored in squares with a horse-drawn marker.", source: "cutting" },
];

const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop() ?? "", { recursive: true, force: true });
});

function vaultWithFacts() {
  const dir = mkdtempSync(join(tmpdir(), "pablo-period-facts-"));
  temps.push(dir);
  const vault = join(dir, "vault");
  cpSync(VAULT, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  mkdirSync(join(work, "facts"), { recursive: true });
  writeFileSync(join(work, "facts", "period.md"), renderPeriodFacts(FACTS));
  const m = readMarker(work);
  if (!m.ok) throw new Error(m.message);
  return { vault, work, marker: m.marker };
}

type Builder = (vault: string, work: string, unit: number, opts: { marker: Marker }) => { ok: true; pack: Pack } | { ok: false; message: string };

const BUILDERS: Record<string, { build: Builder; unit: number }> = {
  novel: { build: (v, w, u, o) => buildChapterPack(v, w, u, o), unit: 2 },
  radio: { build: (v, w, u, o) => buildRadioPack(v, w, u, o), unit: 2 },
  screenplay: { build: (v, w, u, o) => buildScreenplayPack(v, w, u, { ...o, output: "screenplay" }), unit: 2 },
};

function packOf(r: { ok: true; pack: Pack } | { ok: false; message: string }): Pack {
  if (!r.ok) throw new Error(r.message);
  return r.pack;
}

for (const [type, { build, unit }] of Object.entries(BUILDERS)) {
  test(`AGT-2110: the ${type} pack carries the period facts dated by its unit (Winter 1931)`, () => {
    const { vault, work, marker } = vaultWithFacts();
    const pack = packOf(build(vault, work, unit, { marker }));
    const period = pack.slices.find((s) => s.name === "period");
    expect(period?.source).toContain("novels/ice-house/facts/period.md");
    expect(pack.prompt).toContain("Ice sold at forty cents a hundredweight. (from 1929-01)");
    expect(pack.prompt).toContain("Hotel kitchens had begun buying electric refrigerators.");
    expect(pack.prompt).toContain("A pond was scored in squares with a horse-drawn marker.");
    expect(pack.prompt).not.toContain("The county seat paved its main road.");
    expect(pack.periodFacts).toBe(3);
  });
}

test("AGT-2110: the first chapter (January 1929) gets only what holds by then", () => {
  const { vault, work, marker } = vaultWithFacts();
  const pack = packOf(buildChapterPack(vault, work, 1, { marker }));
  expect(pack.prompt).toContain("Ice sold at forty cents");
  expect(pack.prompt).not.toContain("Hotel kitchens");
  expect(pack.periodFacts).toBe(2);
});

test("AGT-2110: the story pack spans every beat, so every fact holds", () => {
  const { vault, work, marker } = vaultWithFacts();
  const pack = packOf(buildStoryPack(vault, work, 1, { marker, output: "story" }));
  expect(pack.prompt).toContain("The county seat paved its main road.");
  expect(pack.periodFacts).toBe(4);
});

test("AGT-2110: the source note never reaches the writer, only the fact", () => {
  const { vault, work, marker } = vaultWithFacts();
  const period = packOf(buildChapterPack(vault, work, 2, { marker })).slices.find((s) => s.name === "period");
  expect(period?.text).not.toContain("fridges");
  expect(period?.text).not.toContain("research/");
});

test("AGT-2110: a work with no facts/period.md has no count, and the dry run says what was sent", () => {
  const { vault, work, marker } = vaultWithFacts();
  rmSync(join(work, "facts"), { recursive: true });
  expect(packOf(buildChapterPack(vault, work, 2, { marker })).periodFacts).toBeUndefined();
  mkdirSync(join(work, "facts"));
  writeFileSync(join(work, "facts", "period.md"), renderPeriodFacts(FACTS));
  expect(renderPack(packOf(buildChapterPack(vault, work, 2, { marker }))).text).toContain("period facts sent: 3");
});

test("AGT-2110: the receipt lists how many period facts were sent", async () => {
  const { vault, work, marker } = vaultWithFacts();
  const pack = packOf(buildChapterPack(vault, work, 2, { marker }));
  const stub = {
    id: "stub",
    model: "stub-writer",
    async *complete(): AsyncIterable<CompletionEvent> {
      yield { type: "token", text: "prose" };
    },
  } as unknown as Adapter;
  const log: Receipt[] = [];
  const adapter = withReceipts(stub, (r) => void log.push(r), { pack, intent: "draft" });
  for await (const _ of adapter.complete({ prompt: pack.prompt, maxTokens: 10 })) void _;
  expect(log[0]?.period_facts).toBe(3);
});
