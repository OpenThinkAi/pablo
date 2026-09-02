# bench — the structured-output bake-off (AGT-1202)

Which structured path an adapter should take is a property of the model behind
the endpoint, not a design preference. This bench measures it.

It runs both paths over the same ten spans:

1. **tool** — a native `propose_edit` call whose `replacement` argument is the
   new prose.
2. **text** — CriticMarkup in the completion body, checked by
   `validateProposal`.

and then runs the `extract_facts` tool call over the same passages, verifying
every anchor verbatim the way `~/writing-lab/bench/ai-terminal-extraction`
does.

## Running it

```sh
bun run bench/bakeoff.ts --adapter local          # the whole thing, ~9 minutes
bun run bench/bakeoff.ts --adapter local --limit 2 --no-extract   # a smoke run
bun run bench/bakeoff.ts --adapter openai --paths tool --json out.json
```

| flag | default | what it does |
|---|---|---|
| `--adapter <id>` | `local` | Any provider id in the config. The Anthropic adapter (AGT-1206) is measurable the day it registers, with no change here. |
| `--paths tool,text` | both | Which structured paths to run. |
| `--spans <dir>` | `bench/spans` | The fixture set. |
| `--timeout <ms>` | `300000` | Per-request idle timeout, set on the provider being measured. Generous on purpose: the rate meter starts cold, so nothing stretches the first request's budget, and a slow first token on a shared local endpoint is queueing, not a hang. |
| `--max-tokens <n>` | `2000` | |
| `--temperature <t>` | `0.2` | |
| `--limit <n>` | all | First `n` fixtures. |
| `--no-extract` / `--no-proposals` | — | Run one half only. |
| `--json <file>` | — | Write the per-run records. |

It is a bench, not a test: it talks to a real endpoint and is run by hand.
`bun test` never touches `:8002` — the adapter's unit tests use an in-process
`Bun.serve` fake, and the only tests here are the pure classifiers in
`classify.test.ts`.

A cloud OpenAI-compatible endpoint needs `OPENAI_API_KEY` in the environment (or
a `key: keychain:…` entry in the config) plus a provider entry pointing at it;
without one, only the local run is meaningful.

## The fixtures

`bench/spans/` holds ten markdown documents with the replacement target marked
between `<<<span` and `span>>>`, and the instruction in the frontmatter. Three
of the ten targets are over 400 words (`06-submarine` 440, `07-courtroom` 446,
`08-rescue` 412), which is the case the design doc worried about. Each fixture
has prose on both sides of the span, so the model sees a real neighbourhood and
has to leave it alone.

The prose is written for this bench. **Nothing here comes from the writing
vault** — the GitHub mirror of this repo is public.

## Mangling classes

`classify.ts` labels an answer with any of four failures, as pure functions of
the passage and the answer:

| class | what it catches |
|---|---|
| `escaped-newlines` | A literal backslash-n in prose: the JSON string argument came back escaped one level too many. |
| `lost-quotes` | Quotation marks the passage had and the answer does not, or quotes still escaped. |
| `truncated` | The answer stops mid-thought, or is under a quarter of the passage it replaces. |
| `extra-prose` | Chat wrapping around the replacement — a preamble, a sign-off, a code fence. |

These label a result. They never decide whether a proposal is applied; that is
`validateProposal`'s job, and it runs first.

## Results — local writer, 2026-09-02

Gemma 4 31B (`mlx-community/gemma-4-31b-it-4bit`) on mlx_lm at
`127.0.0.1:8002`, 10 spans, temperature 0.2, max_tokens 2000.

| path | pass rate | over 400w | median wall | total wall | mangling classes seen |
|---|---|---|---|---|---|
| tool | **10/10 (100%)** | **3/3 (100%)** | **7.3s** | 100.4s | truncated ×1 |
| text | 7/10 (70%) | 1/3 (33%) | 13.3s | 224.0s | none |

`extract_facts`: 10/10 spans returned a tool call, 98 facts, 60 anchors verbatim
(61%), **96 once hard wraps are collapsed (98%)**, median 19.7s.

**No cloud run.** `OPENAI_API_KEY` was not set, so these numbers are the local
writer only.

### What the numbers say

- **The tool call wins, and it is not close.** `preferredOutput` for the
  OpenAI-compatible adapter is `"tool"` (`PREFERRED_OUTPUT` in
  `packages/core/src/providers/openai.ts`). It conformed everywhere, including
  on all three 400-word spans, and did it in half the wall time — a tool call
  returns the replacement alone, where the text path has to re-emit the whole
  passage before it can propose anything.
- **The design doc's worry was aimed at the wrong failure.** Long prose inside a
  JSON string argument did *not* degrade: zero escaped newlines and zero lost
  quotes across all twenty runs. What breaks at length is the **CriticMarkup
  delimiter** — past about 400 words Gemma 4 drops a `~~}`, emits a stray
  closer, or forgets the `~>` and hands back plain prose. All three text-path
  failures were delimiter failures (`03-depot`, `06-submarine`, `07-courtroom`).
- **The tool path's own weakness is scope, not encoding.** On `10-harbour`,
  whose instruction targets only the last two sentences of the span, the tool
  call returned those two sentences (21 words) instead of the whole 110-word
  span; the text path returned the whole span correctly, because CriticMarkup
  makes the untouched text part of the answer. It passed the parser — a
  fragment is valid — so this is a **prompt and UI concern for AGT-1205**, not a
  validation one: a `replacement` argument has no way to say "and the rest
  unchanged". Watch for it whenever an instruction addresses part of a span.
- **Anchors miss on hard wraps, not on paraphrase.** The strict 61% looks much
  worse than the writing-lab bench's 16/17; collapsing whitespace on both sides
  takes it to 98%. The model is quoting correctly and the manuscript's hard line
  wraps are putting a newline where the model wrote a space. **The map's anchor
  lookup must be whitespace-insensitive** (AGT-1205 onward), or two facts in
  three will look unprovenanced.
- **The tool path is unstreamed**, so there is no visible progress and the whole
  generation has to land inside the first-byte budget. At 7.3s median on the
  local writer that is fine, but the default 60s `timeoutMs` is thin for a long
  replacement on a busy endpoint — raise it per request rather than lowering the
  bar.

## Results — Anthropic, 2026-09-02

Claude Opus 5 (`claude-opus-5`) on the Messages API, 10 spans, `--max-tokens
8000`. Run as `bun run bench/bakeoff.ts --adapter anthropic --max-tokens 8000`
with the provider key in the Keychain.

| path | pass rate | over 400w | median wall | total wall | mangling classes seen |
|---|---|---|---|---|---|
| tool | **10/10 (100%)** | **3/3 (100%)** | **6.0s** | 65.0s | none |
| text | **10/10 (100%)** | **3/3 (100%)** | 18.0s | 204.5s | none |

`extract_facts`: 10/10 spans returned a tool call, 192 facts, **183 anchors
verbatim (95%)**, 192 once hard wraps are collapsed (100%), median 15.6s.

Two flags differ from the local run, and both are properties of the API rather
than choices:

- **`--max-tokens 8000`, not the 2000 default.** Adaptive thinking spends the
  same budget as the answer, so a 2000-token ceiling on a 440-word replacement
  is a truncation waiting to happen.
- **`--temperature` has no effect.** Sampling parameters were removed from every
  current Claude model and return a 400, so the adapter does not send one; this
  run is at the API's own default, where the local run was at 0.2.

### What the numbers say

- **Conformance did not decide it; speed did.** Both paths passed everything,
  with no mangling class on either — the delimiter failure that costs the local
  writer three of ten spans past 400 words simply does not happen here. What
  separates them is that a tool call returns the replacement alone where the
  text path re-emits the whole passage around it: three times the wall clock and
  three times the output tokens for the same result, and a 58.5s worst case on
  `07-courtroom`. `PREFERRED_OUTPUT` in
  `packages/core/src/providers/anthropic.ts` is `"tool"`.
- **The tool path's scope weakness is the local writer's, not the model's.** On
  `10-harbour`, whose instruction targets only the last two sentences, Gemma 4
  returned 21 words of a 110-word span; Opus 5 returned 104 words — the whole
  span, edited. The finding stands as a *path* weakness worth a review surface
  (AGT-1205), but it is not universal, and the text path remains the better
  choice for a part-of-span instruction on any model.
- **Anchors are near-perfect, and the remaining gap is still hard wraps.** 95%
  verbatim against the local writer's 61%, and 100% once whitespace is
  collapsed on both sides — the same nine misses are line wraps, not paraphrase.
  This is more evidence for the whitespace-insensitive lookup, not less: the
  strict check would still throw away nine true facts.
- **The Anthropic tool path streams**, unlike the OpenAI-compatible one. The
  `input_json_delta` framing is specified, so the argument arrives in fragments
  that can be shown as progress and measured; there is no unstreamed
  first-byte budget to blow through on a long replacement.

Both paths stay. Which one an adapter takes is `Adapter.preferredOutput`, and
any caller can override it per request with `EditRequest.output`.
