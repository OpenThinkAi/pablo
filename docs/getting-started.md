# Getting started

This walks you from nothing to a first drafted chapter: install pablo, point it at a
model, make a vault, plan a tiny novel and write chapter 1. It takes about fifteen
minutes, most of it reading.

pablo is early software built and used by one author. Expect rough edges, and please
open an issue when you hit one.

## 1. Install

You need [Bun](https://bun.sh) 1.1 or newer and git. pablo is used daily on macOS;
the writing commands should also work on Linux (the test suite runs there), but the
reader's tray and the browser windows are macOS-only.

```sh
curl -fsSL https://bun.sh/install | bash     # if you don't have Bun
bun add -g @openthink/pablo
bun pm -g trust @openthink/ui-leaf           # lets the window helper finish installing
pablo --version
```

The trust step is only needed for the commands that open a window (`read`, `review`,
`mixer`), but it costs nothing to run now. `npm install -g @openthink/pablo` also
works; pablo still runs on Bun.

## 2. Choose a model

pablo writes prose with one request per chapter to a model you configure. It does
not need one for planning or checking, so you can do steps 3 to 5 before this is
working.

**A local model** (the default). Any server that speaks the OpenAI chat API works:
[LM Studio](https://lmstudio.ai), [Ollama](https://ollama.com), llama.cpp's server or
`mlx_lm.server`. With no config file at all, pablo expects one at
`http://127.0.0.1:8002/v1`. To use yours, create `~/.config/pablo/config.json`:

```json
{
  "providers": {
    "local": {
      "endpoint": "http://127.0.0.1:1234/v1",
      "model": "the-model-id-your-server-lists",
      "local": true
    }
  }
}
```

**A hosted model instead.** Put your key in the environment and route the prose
work to Anthropic. The `intents` block matters: without it, drafting still goes to
the local endpoint.

```sh
export ANTHROPIC_API_KEY=sk-ant-...
```

```json
{
  "providers": {
    "anthropic": { "kind": "anthropic" }
  },
  "default": "anthropic",
  "intents": {
    "draft": "anthropic",
    "revise": "anthropic",
    "prose": "anthropic",
    "continuity": "anthropic"
  }
}
```

Every option, including the macOS Keychain for keys, is in
[configuration.md](configuration.md).

## 3. Make a vault

A vault is a git repository holding your shared style guide, a template for new
works, and the works themselves. This repo ships a starter one:

```sh
git clone --depth 1 https://github.com/OpenThinkAi/pablo.git /tmp/pablo
cp -R /tmp/pablo/examples/starter-vault ~/writing
cd ~/writing
git init -b main && git add -A && git commit -m "Start a writing vault"
```

Read `style/prose.md` and `style/anti-tells.md`. They go to the model with every
chapter, so they are where your taste lives; rewrite them in your own words when you
are ready. [vault.md](vault.md) explains every file.

## 4. Start a novel

From anywhere inside the vault:

```sh
pablo init novel lighthouse "The Lighthouse"
pablo status --project lighthouse
```

`init` copies `templates/novel` to `novels/lighthouse/`, writes its `pablo.json`, and
commits. `status` shows the story core's stages and what to do next:

```
core:
  premise: missing
  research: 0 files
  bible: 3 files, 0 [pick] rows
  acts: 0
  beats: 0
  facts: decided
novel: 0 of 0 chapters drafted
waiting for review: none
next: core: write bible/overview.md
```

## 5. Plan

pablo will not draft a chapter until the plan behind it exists. Usually your agent
does this part with you in conversation (see [agents.md](agents.md)); here it is by
hand. You can edit the files directly, or hand text to `pablo save`, which validates
it, writes the right file and commits.

The premise is `bible/overview.md`. It counts once there is text under `## Logline`:

```sh
pablo save --project lighthouse --stage premise <<'EOF'
# Overview

## Logline

A lighthouse keeper's daughter keeps the light burning the winter her father cannot.

## Premise

Maine, 1911. When the keeper breaks his leg, Ada, fourteen, runs the light alone and
lies to the inspector about it.
EOF
```

Acts and beats are two tables in the outline. Keep the headers exactly as shown:

```sh
pablo save --project lighthouse --stage acts <<'EOF'
| Act | Years | What it accomplishes |
|---|---|---|
| I | 1911 | Ada takes over the light and hides it. |
EOF

pablo save --project lighthouse --stage beats <<'EOF'
| # | Story date | Title (working) | Beat | POV | Status |
|---|---|---|---|---|---|
| 1 | December 1911 | The Fall | Father slips on the iced gallery stairs. Ada sets the leg badly, then climbs to trim the wick herself. Ends with the light turning on time. | Ada | outline |
| 2 | December 1911 | The Inspector | The inspector comes by launch. Ada lies. | Ada | outline |
EOF
```

Now ask whether chapter 1 can be drafted:

```sh
pablo status --project lighthouse --for "chapter 1"
```

```
chapter 1: not ready
  bible/timeline.md has no row dated 1911 or earlier
```

That refusal is the point of pablo: it names exactly what is missing. The timeline
tells the writer what exists by the chapter's date, so add a row:

```sh
pablo save --project lighthouse --stage bible/timeline.md <<'EOF'
# Timeline

| Year | Real events | In the novel |
|---|---|---|
| 1897 | | Ada is born at the light |
| 1911 | | Father breaks his leg in December |
EOF

pablo status --project lighthouse --for "chapter 1"     # chapter 1: ready
```

## 6. Write chapter 1

See exactly what would be sent, and what it costs, without sending anything:

```sh
pablo write --project lighthouse --chapter 1 --words 400 --dry-run
```

The dry run prints a table of the prompt's slices (your style guide, the work's rules,
the beat, the timeline, places, continuity) with token counts, then the prompt itself.
When it looks right, write for real:

```sh
pablo write --project lighthouse --chapter 1 --words 400
```

```
wrote chapters/01-the-fall.md (333 words) on branch draft/ch01
read 1523 tokens in 0.6s, wrote 404 in 16.5s
```

The chapter is not on `main` yet. Every change pablo makes to the manuscript lands on
a branch for you to read first.

## 7. Review and accept

Read the draft any way you like:

```sh
git diff main draft/ch01
```

or run bare `pablo` inside the work for the full-terminal screen, which has a review
mode for exactly this. When you are happy, accept it:

```sh
pablo merge --project lighthouse draft/ch01
```

`merge` brings the chapter onto `main` and runs the after-write steps: it ticks the
outline row, adds a session note and a README line, extracts new facts into the
continuity ledger, and commits. `pablo status` now says `next: novel: write chapter 2`.

## 8. Check and publish

```sh
pablo check --project lighthouse                    # tells, banned names, missing provenance
pablo publish --project lighthouse --target draft   # one markdown file in .pablo/out/
```

## Next

- Drive all of this from Claude Code, Codex or another agent: [agents.md](agents.md).
- Every command and flag: [commands.md](commands.md).
- What each vault file does, and the rules the planner enforces: [vault.md](vault.md).
- Share chapters with readers who leave notes: [readers.md](readers.md).
