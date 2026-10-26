#!/usr/bin/env bun
/**
 * `pablo` — the CLI that writes: the manager for writing projects, driven by
 * whatever agent you like (Claude Code, Codex, pi). See
 * `pm project show ai-terminal` for the design.
 *
 * This is the P0 skeleton: argument parsing, `--help`, `--project`
 * resolution, and `init` (which writes the `pablo.json` marker every other
 * verb requires) are real; every other verb body is a stub. Exit codes are
 * the contract every later ticket builds on: 0 ok, 2 refused (a framework
 * precondition — an unresolvable `--project`, a missing/invalid marker, or
 * later an unmet stage precondition), 1 error (including "not implemented
 * yet").
 */

import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { workBookStages } from "./book";
import { configSet, configShow, configTest, realConfigTestDeps } from "./config-verb";
import { doctorText, gateText, lineTakesText, realCastingDeps, runDoctor, runGate, runTakes, takeShowText, takesGcText } from "./casting";
import { parseForEpisode, radioBind, radioStatus } from "./radio";
import { branchDiff, fileAt, repoRoot, waitingBranches } from "./branch";
import { runCheck, screenChecks } from "./check";
import { reviewCommentsOf } from "./critique";
import { migrateLines } from "./migrate";
import { migrateOutputs } from "./migrate-outputs";
import { migrateTrack } from "./migrate-track";
import { migrateStyle } from "./migrate-style";
import { mergeDraftInProject } from "./novel/merge";
import { initAdopt, initNovel, initTrack, vaultAuthor } from "./init";
import type { TrackChoice } from "./tracks/infer";
import type { InitResult } from "./init";
import { outputsLabel, readMarker } from "./marker";
import type { Composer } from "@openthink/pablo-tui";
import { loadConfig } from "@openthink/pablo-core";
import { runAgent } from "./harness/agent";
import { lineReader, stdinAskAuthor } from "./harness/ask-author";
import { harnessProvider } from "./harness/provider";
import { createComposer } from "./harness/compose";
import { loadPromptWork } from "./harness/prompt";
import type { HarnessSpec } from "./harness/session";
import { runMcp } from "./mcp";
import { findVault, resolveProjectFromCwd } from "./project";
import { realWritingDoctorDeps, runWritingDoctor, writingDoctorText } from "./doctor-writing";
import type { Refusal } from "./project";
import { runProse } from "./prose";
import { OUTPUTS, isOutputId, outputDefinition } from "./outputs/registry";
import { radioStageCheck } from "./outputs/radio/state";
import { runRevise } from "./revise";
import type { ReviseCoreContext } from "./revise";
import { readTool, searchTool } from "./harness-tools";
import { runResumeVerb } from "./resume";
import { formatStatusProse, readWorkStatus } from "./work-state";
import { runSave } from "./save";
import { screenEditor } from "./edit-session";
import { screenCommenter, screenFinisher } from "./review-finish";
import { screenReviser } from "./screen-revise";
import { screenVoicer } from "./screen-voice";
import { screenWriter } from "./screen-write";
import { screenPuller, screenRefresh, screenRounds } from "./screen-reviews";
import { deriveCliOptions, notesWith, publishOutput, runVoiceEdit, runVoiceList, runVoiceRemove, runVoiceRule, runVoiceUse, shareWith, unitStatus, VERBS, verbArgsFromCli } from "./verbs";
import { realRunner } from "./share";
import type { Runner } from "./share";
import { fetchRound, listReaderRounds, parseRoundRef, roundRefLabel } from "./read";
import { openReader } from "./reader-host";
import { openReview } from "./review-host";
import { openMixer } from "./mixer-host";
import { createNotesHost } from "./mixer-notes-host";
import { addExemplar, flagLine, listVoices, readVoice, resolveVoice, scaffoldVoice } from "./voice";
import type { Voice } from "./voice";
import { TARGET_USAGE } from "./voice-rules";
import { VERSION } from "./version";
import { runWrite } from "./write";

/** Verbs P0 ships: the manager for novels (see the design doc's build order). */
const P0_VERBS = [
  "init",
  "resume",
  "status",
  "write",
  "save",
  "check",
  "promote",
  "research",
  "fact",
  "migrate",
  "merge",
  "publish",
  "share",
  "notes",
  "output",
  "story",
  "mcp",
  "voice",
  "prose",
  "revise",
  "agent",
  "read",
  "search",
  "doctor",
  "audition",
  "takes",
  "bind",
  "gate",
  "cast",
  "voices",
  "perform",
  "mix",
  "review",
  "mixer",
  "fix",
  "config",
] as const;

/** Verbs planned for P1/P2 — listed in `--help` as later, not yet wired up. */
const LATER_VERBS = ["dry-run"] as const;

export const ALL_VERBS: readonly string[] = [...P0_VERBS, ...LATER_VERBS];

export const EXIT_OK = 0;
export const EXIT_REFUSED = 2;
export const EXIT_ERROR = 1;

function helpText(): string {
  return [
    "pablo — the CLI that writes: the manager for writing projects (novels, stories, essays)",
    "",
    "Usage: pablo <verb> [--project <slug>] [--json] [options]",
    "",
    "Verbs:",
    ...P0_VERBS.map((verb) => `  ${verb}`),
    "",
    "Later (not yet implemented):",
    ...LATER_VERBS.map((verb) => `  ${verb}`),
    "",
    "dry-run as its own verb is later; today use `write --dry-run` (or `prose`/`revise --dry-run`).",
    "",
    "Every verb accepts --project <slug> and --json.",
    "pablo --version (or -v) prints the installed version.",
    "--project resolves to <vault>/<kind>/<slug> (kind: novels, stories, essays).",
    "The vault is $PABLO_VAULT if set, else the nearest ancestor of the current",
    "directory holding a style/ or voices/ directory.",
    "",
    "  pablo init <format> <slug> \"<Title>\" [--track <t>]",
    "                                            scaffold a new work and write its marker (--track:",
    "                                            fiction, historical-fiction; adds that track's core files)",
    "  pablo init --track <t> <slug> \"<Title>\"  a work with only its track's core files, no output yet",
    "                                            (--track: fiction, historical-fiction, nonfiction)",
    "  pablo init --adopt --project <slug>      write only the marker into an existing work",
    "  pablo status --project <slug>            the story core's stages, then each output's",
    "  pablo status --project <slug> --for \"<output> N\"",
    "                                            {ready, missing[]} for one unit (\"chapter N\" is",
    "                                            the novel's); exit 0 if ready, 2 if not. \"radio N\"",
    "                                            lists what the episode still needs (roles to",
    "                                            cast, render, mix, flags, the casting side)",
    "  pablo write --project <slug> [--output <type>] --unit N [--dry-run]",
    "                                            draft unit N of an output on the local model;",
    "                                            --chapter N is --output novel --unit N; a work",
    "                                            with several outputs needs --output;",
    "                                            --output narrated [--voices characters] reads",
    "                                            the source unit's prose as a script, no model",
    "  pablo output list|add|remove|plan [<type>] --project <slug>",
    "                                            the work's outputs: list them, add one (once the",
    "                                            core is at beats), remove one (archived under",
    "                                            outputs/_removed/), or rewrite its plan.md;",
    "                                            add narrated --from <output> reads that output",
    "  pablo story \"<prompt>\" [--output <type>]... [--review] [--title T] [--words N] [--track <t>]",
    "                                            create a work and write it end to end: the core",
    "                                            through the harness, then each output (default:",
    "                                            a story or novel by the prompt's length cue);",
    "                                            the track is --track, else inferred from the prompt",
    "                                            (historical-fiction when it names a period or event);",
    "                                            --review stops on every branch, and",
    "                                            pablo story --project <slug> continues the run",
    "  check, publish and share take --output <type> the same way",
    "  pablo check --project <slug> --output <type>",
    "                                            tells and provenance, plus the core check:",
    "                                            story-time and names the core does not know",
    "  pablo check --project <slug> --across     contradictions between the outputs' ledgers,",
    "                                            each with a promote action",
    "  pablo promote --project <slug> --finding <id> --keep <type>",
    "                                            a finding's fact to facts.md on a plan/ branch,",
    "                                            commenting the contradicting units' lines",
    "  pablo research save --project <slug> --title T --note N --source URL [--source URL]... [--item N]...",
    "                                            keep a finding with its sources as research/<slug>.md",
    "                                            on a plan/ branch (also the save_research MCP tool);",
    "                                            --item marks those checklist items sourced by it",
    "  pablo research plan --project <slug>       research/checklist.md from the period brief or thesis",
    "                                            on a plan/ branch (also plan_research)",
    "  pablo research waive <#> \"<reason>\" --project <slug>",
    "                                            close a checklist item with a reason (waive_research_item)",
    "  pablo research link <#> <note> --project <slug>",
    "                                            close a checklist item with a saved note (link_research_item)",
    "  pablo research distill --project <slug>",
    "                                            research/ notes to short, sourced period facts in",
    "                                            facts/period.md on a plan/ branch (also distill_facts)",
    "  pablo fact record --project <slug> --fact F --where continuity|<bible file> --kind researched|invented|author",
    "                    [--source CITATION] [--heading H] [--chapter chNN] [--promote --established-by novel/ch03]",
    "                                            one tagged fact on a plan/ branch (also record_fact over MCP)",
    "  pablo migrate lines --project <slug> [--dry-run]",
    `                                            one-time split of ${OUTPUTS.novel.artifactDir}/*.md to one`,
    "                                            sentence per line, committed on its own",
    "  pablo migrate outputs --project <slug> [--dry-run]",
    "                                            one-time move of a format:novel work to a",
    "                                            story core plus a novel output (pablo.json",
    "                                            outputs, outputs/novel/, outline/beats.md,",
    "                                            facts.md), committed on its own",
    "  pablo migrate track --project <slug> --track <t> [--dry-run]",
    "                                            write the track (fiction, historical-fiction,",
    "                                            nonfiction) into pablo.json, committed on its own;",
    "                                            reports the new core stages the work lacks",
    "  pablo migrate style --project <slug> [--dry-run]",
    "                                            rename the work's QWEN.md to STYLE.md with git",
    "                                            mv (QWEN.md is still read when not migrated)",
    "  pablo merge --project <slug> <draft/chNN>",
    "                                            merge a reviewed draft branch to main, then run",
    "                                            the after-write steps (outline, note, README,",
    "                                            continuity, commit, think sync)",
    "  pablo publish --project <slug> [--output <type>] --target draft|bundle",
    "                                            compile every chapter into one markdown file",
    "                                            under <work>/.pablo/out/ (frontmatter stripped,",
    "                                            sentences joined, quotes curled); the radio",
    "                                            output's bundle copies every script and each",
    "                                            mixed episode's m4a and manifest into one dir",
    "  pablo publish --project <slug> --output radio --target stream",
    "                                            copy each mixed radio episode (newest version's",
    "                                            audio and manifest, with its time to first audio)",
    "                                            to the listening directory <work>/.pablo/out/stream/",
    "  pablo share --project <slug> --reader <name> --chapters N|N-M",
    "                                            open a reading round: push those chapters (all",
    "                                            on main) to the book's private reading repo as a",
    "                                            PR, request the reader's review, record the round",
    "  pablo share --list --project <slug>       the work's rounds: open, submitted (waiting to",
    "                                            pull), pulled",
    "  pablo read --list [--json]               the reading rounds waiting for you on GitHub (and",
    "                                            those you have sent); no vault or project needed",
    "  pablo read <slug>-reading#<pr> [--no-open]",
    "                                            fetch a round's chapters at its head commit into",
    "                                            $XDG_STATE_HOME/pablo/rounds/<repo>/<pr>/ and open",
    "                                            the reader window on it (needs Google Chrome);",
    "                                            --no-open only fetches",
    "  pablo notes pull --project <slug>        each reader's submitted review becomes a",
    "                                            reader/<round> branch: one commit per suggestion,",
    "                                            authored as the reader; comments for review mode",
    "  pablo voice new <name> [--global]        scaffold a voice directory",
    "  pablo voice list [--project <slug>]      every voice, and every rule with its id",
    "  pablo voice show <name>                  the assembled voice as a model will see it",
    '  pablo voice flag <name> "<line>" [--section <heading>]',
    "                                            record a rejected line under a voice.md/",
    "                                            style/prose.md section (default \"Flagged\")",
    '  pablo voice exemplar <name> <file> [--title "<t>"]',
    "                                            keep a piece as-is under the voice's exemplars/",
    '  pablo voice rule <name> "<text>" [--example "<s>"]',
    "                                            add a rule under ## Rules of style/prose.md (fiction)",
    "                                            or the named voice's voice.md",
    '  pablo voice rule "<text>" --target global|vault|work|output:<type> [--project <slug>]',
    "                                            add it to that layer's rules file (work and output",
    "                                            need --project; work = STYLE.md, output = RULES.md)",
    '  pablo voice edit <id> "<text>" [--target <t>] [--project <slug>]',
    "                                            change one rule (ids are in `voice list`)",
    "  pablo voice remove <id> [--target <t>] [--project <slug>]",
    "                                            delete one rule",
    "  pablo voice use <name> --project <slug>  add a named voice to the work's pablo.json voice",
    "  pablo prose --voice <name> --brief <file|-> [--context <file>]...",
    "              [--format email|post|page|reply|note] [--words N]",
    "              [--draft <file> --instruction \"<text>\"]",
    "              [--out <file> [--force]] [--json] [--dry-run]",
    "                                            write a piece in a voice: assemble, send,",
    "                                            print the text, receipt it, check it;",
    "                                            no --project, no vault required;",
    "                                            --draft + --instruction revise a previous",
    "                                            piece instead of starting fresh",
    "  pablo revise --project <slug> --file F",
    '              (--passage "<quoted text>" | --start N --end N)',
    '              --instruction "<text>" [--json] [--dry-run]',
    "                                            send one located passage to the local model;",
    "                                            returns {candidate, span, receipt} and writes",
    "                                            nothing — the file is never touched",
    '  pablo agent --project <slug> [--new] "<message>"',
    "                                            one headless session of pablo's agent loop",
    "                                            on the provider the agent intent routes to;",
    "                                            prints the transcript (--new: accepted, every",
    "                                            run is a fresh conversation for now)",
    "  pablo agent --project <slug> --tag-facts",
    "                                            tag every untagged bible and continuity fact",
    "                                            (researched/invented/author) on a plan/ branch;",
    "                                            chapters are never touched",
    "  pablo config show [--project <slug>] [--json]",
    "                                            the merged providers and which provider each intent",
    "                                            routes to; keys shown as their reference, never a value",
    "  pablo config set <path> <value> [--project <slug>]",
    "                                            edit config.json (or the work's pablo.json):",
    "                                            default, intents.<intent>, providers.<id>.<field>",
    "  pablo config test [--project <slug>] [--json]",
    "                                            one tiny request per mapped intent; ok/error per provider",
    "  pablo doctor [--json]                    the casting side's state (not provisioned,",
    "                                            stale, provisioned), uv, and its config;",
    "                                            never provisions or downloads. Also checks the",
    "                                            writing side: config, each routed provider,",
    "                                            the vault is a git repo, the search backend;",
    "                                            each failure says how to fix it, exit 1 on one",
    "  pablo status --project <slug> --for \"episode N\"",
    "                                            radio: exit 2 while a role is unbound",
    "  pablo bind --project <slug> --role <NAME> --voice <slug>",
    "                                            pin a script role to a voice in the library",
    "  pablo audition --dry-run [--project <slug>]",
    "                                            provision the casting side (uv sync --frozen,",
    "                                            configured weights) on first use, then check",
    "                                            it runs; no model is loaded. Needs uv",
    "                                            (brew install uv); writing verbs never do",
    '  pablo audition --role R --describe "..." [--designer qwen3|voxcpm2] [-n 6]',
    "                [--traits '{\"gender\":\"f\",...}'] [--seed S]",
    "                                            render n candidate voices reading the audition",
    "                                            passage into <vault>/casting/voices/<slug>/",
    "                                            auditions/ (untracked), scored, near duplicates",
    "                                            marked",
    "  pablo cast --role R --candidate n [--recast] [--notes \"...\"]",
    "                                            freeze a candidate as the voice's card",
    "                                            (card.json, reference.flac/.txt, ECAPA",
    "                                            embedding); prints the card hash. --recast",
    "                                            archives the old card under recast/. No",
    "                                            --from-wav: voices are synthetic only",
    "  pablo cast --auto --project <slug> [--episode N | --all]",
    "                                            match every unbound CAST: role to a distinct,",
    "                                            active library voice (by: match, score,",
    "                                            runner-up; review in the middle band); roles",
    "                                            with no fit are listed as needing design",
    "  pablo cast --auto --design --project <slug> [--role-traits '{\"R\":{...}}']",
    "                                            design a voice for each role that needs one:",
    "                                            6 candidates, screened, a 3-line trial through",
    "                                            the engine and every gate; the best is admitted",
    "                                            (admitted.by: auto) and bound by: design. One",
    "                                            re-phrased retry, then a refusal naming the role",
    '  pablo describe_voice --describe "..." [--gender f|m|x]',
    "                                            a CAST: description in the traits vocabulary,",
    "                                            and the phrases the mapper could not normalise",
    "  pablo voices list [--auto-admitted] | show <slug> | retire <slug> [--reason \"...\"]",
    "                                            the shared voice library; retire keeps the",
    "                                            card hash, so pinned stories still perform",
    "  pablo perform --project <slug> --output radio --unit N (or --episode N) [--engine chatterbox-turbo|dia] [--json-lines]",
    "                                            refused, naming it, while a role is not cast;",
    "                                            render the episode's lines in their bound voices",
    "                                            (gates, up to 4 takes a line, pace stretch within",
    "                                            0.75-1.05) into takes and renders/epNN/v1.json;",
    "                                            one JSON line per line on stderr as it lands",
    "                                            (and stdout with --json-lines). Uses the GPU",
    "  pablo perform --project <slug> --episode N|--all --stream",
    "                                            progressive render: mix as the lines pass, cut 6 s",
    "                                            segments into <work>/.pablo/out/stream/ (playable in",
    "                                            pablo review once 30 s have passed the gates), mix",
    "                                            the episode file and publish it there at once;",
    "                                            --all performs every unrendered episode in order",
    "  pablo mix --project <slug> --output radio --unit N (or --episode N) [--version k]",
    "                                            mix a performed episode: its takes (paced by the",
    "                                            manifest) and the script's cues from the cue",
    "                                            library (<library>/cues; the same description is",
    "                                            the same asset) into renders/epNN/epNN.v<k>.m4a,",
    "                                            epNN.m4a moved to it, each line's start/end",
    "                                            written to the manifest; a mixed version remixes",
    "                                            into a new one. Generates new cues on the GPU",
    "  pablo review --project <slug> [--episode N]",
    "                                            the review player (needs Google Chrome): a radio",
    "                                            work's episodes with a reason on each flag, the",
    "                                            line's gate scores, the performer's auto-flags,",
    "                                            a version switcher and a chapter list that fills",
    "                                            in as chapters are published. Flags go to",
    "                                            outputs/radio/casting/flags.json for `pablo fix`",
    "  pablo mixer --project <slug> --episode N [--version k] [--library DIR]",
    "                                            the mixer (needs Google Chrome): the episode's mix",
    "                                            document as tracks (Dialogue a lane per role, SFX,",
    "                                            Beds, Music) of clips with waveforms on a ruler;",
    "                                            plays every clip with its gain, fades, crossfades",
    "                                            and track automation; volume, mute and solo are",
    "                                            live (not saved). --version opens an older mix",
    "                                            Save writes the next mix version; Render saves (if",
    "                                            edited), runs pablo mix on it and reloads the audio.",
    "                                            --library DIR: the library whose cues/ hold cues.",
    "                                            Press M to drop a marker at the playhead (note +",
    "                                            category); Export writes the punch list.",
    "  pablo mixer --project <slug> --episode N --export-notes",
    "                                            no window: write renders/epNN/punch-list.md from",
    "                                            the episode's saved markers (notes.json)",
    "  pablo fix --project <slug> --output radio --unit N (or --episode N) [--line I] [--json-lines]",
    "                                            re-record only the episode's flagged lines",
    "                                            (flags.json; a reason can bump the engine),",
    "                                            write the next manifest version, remix it and",
    "                                            move the flags to flags-done.json; no open",
    "                                            flags is a refusal; --line I fixes only that",
    "                                            line's flags. Uses the GPU",
    "  pablo takes show <key> --project <slug>  one radio take: inputs, scores, timings and",
    "                                            receipt id (a unique key prefix is enough)",
    "  pablo takes gc --project <slug> [--yes]  list the takes no manifest references, then",
    "                                            ask before archiving them (moved, never",
    "                                            deleted); without a terminal, needs --yes",
    "  pablo takes line --project <slug> --episode N --line I",
    "                                            every take a line has had, newest version's",
    "                                            marked current, with status and gates",
    "  pablo takes choose <key> --project <slug> --episode N --line I",
    "                                            put an earlier take back on the line: the",
    "                                            next manifest version, remixed (a mix saved",
    "                                            in the mixer is rebased onto it)",
    '  pablo gate <take.wav> --line "<line>" --card <slug|dir> [--centroid <file>]',
    "             [--emotion <class>] [--library DIR] [--vault DIR] [--project <slug>] [--json]",
    "                                            score a take (Whisper WER + tail, aligner",
    "                                            pace, ECAPA, UTMOS, Audiobox, DNSMOS,",
    "                                            emotion2vec) against the card's gates; exit 0",
    "                                            with pass and the failing gates. The first",
    "                                            run installs the scorers and their weights",
    "  pablo gate --scores <record.json> --card <slug|dir>",
    "                                            re-judge stored scores; loads no model",
    "  pablo gate calibrate --approved <dir> [--others <dir>] [--card <slug|dir>] [--apply]",
    "                                            fit each threshold (5th percentile of approved",
    "                                            vs midpoint to others, stricter wins) and print",
    "                                            a gates block; writes the card only with --apply",
    "",
    "Every verb but init refuses (exit 2) when the resolved project has no",
    "pablo.json marker.",
    "",
    "Exit codes: 0 ok, 2 refused (a framework precondition), 1 error.",
  ].join("\n");
}

interface ParsedArgs {
  readonly verb: string | undefined;
  /** Positionals after the verb — e.g. `<format> <slug> "<Title>"` for `init`. */
  readonly rest: readonly string[];
  readonly project: string | undefined;
  readonly json: boolean;
  readonly help: boolean;
  /** `--version` / `-v` (AGT-1597): print the installed version. */
  readonly version: boolean;
  readonly adopt: boolean;
  /** `agent --tag-facts` (AGT-1570): tag every untagged fact on a plan branch. */
  readonly tagFacts: boolean;
  /** `status --for "chapter N"` (also accepts `chapter-N`, `ch N`, or bare `N`). */
  readonly for: string | undefined;
  /** `bind --role <NAME>` (AGT-1680): a role from a script's `CAST:` line; the voice is `--voice <slug>`. */
  readonly role: string | undefined;
  /** `save --stage acts|beats|premise|bible/<file>` (nonfiction: `thesis|claims|outline`). */
  readonly stage: string | undefined;
  /** `save --file <path>` — stdin is read when omitted. */
  readonly file: string | undefined;
  /** `write --chapter N`; parsed and validated by `runWrite`, not here. */
  readonly chapter: string | undefined;
  /** `migrate track --track <id>` (AGT-2104): the track to write into pablo.json. */
  readonly track: string | undefined;
  /** `--output <type>` (AGT-1669): the output `write`, `status`, `check`, `publish` and `share` act on. */
  readonly output: string | undefined;
  /** `write --unit N` (AGT-1669); validated by `runWrite`. */
  readonly unit: string | undefined;
  /** `write --words W`; defaults to `DEFAULT_WORD_TARGET` when absent. */
  readonly words: string | undefined;
  /** `write --scenes S`; defaults to `DEFAULT_MIN_SCENES` when absent. */
  readonly scenes: string | undefined;
  /** `write --dry-run`: assemble and render the pack, send nothing. */
  readonly dryRun: boolean;
  /** `write --force`: overwrite an existing chapter file. */
  readonly force: boolean;
  /** `takes gc --yes` (AGT-1681): archive the listed takes without asking. */
  readonly yes: boolean;
  /** `write --temperature T`: sampling temperature; validated by `runWrite`. */
  readonly temperature: string | undefined;
  /** `write --seed N`: sampling seed; validated by `runWrite`. */
  readonly seed: string | undefined;
  /** `write --direction "<text>"` (AGT-1562): a steer for the chapter; its own pack slice. */
  readonly direction: string | undefined;
  /** `write --voices narrator|characters` (AGT-2137): who reads a narrated unit; validated by `runWrite`. */
  readonly voices: string | undefined;
  /** `voice new --global`: scaffold under the global voices directory instead of the vault. */
  readonly global: boolean;
  /** `voice flag --section <heading>`: which `## ` section to append the flagged line under (default "Flagged"). */
  readonly section: string | undefined;
  /** `voice exemplar --title "<t>"`: the title to file the exemplar under. */
  readonly title: string | undefined;
  /** `voice rule --example "<sentences>"` (AGT-1594): written as a Flagged line under the rule. */
  readonly example: string | undefined;
  /** `prose --voice <name>`: which voice directory to write in. */
  readonly voice: string | undefined;
  /** `prose --brief <file|->`: the ask (a file, or `-` for stdin). */
  readonly brief: string | undefined;
  /** `prose --context <file>` (repeatable): sent verbatim, in argument order. */
  readonly context: readonly string[];
  /** `prose --format email|post|page|reply|note`. */
  readonly format: string | undefined;
  /** `prose --out <path>`: write the answer to a file (with `--force` to overwrite). */
  readonly out: string | undefined;
  /** `prose --draft <file>` (AGT-1244): the previous piece to revise. Requires `instruction`. */
  readonly draft: string | undefined;
  /** `prose --instruction "<text>"` / `revise --instruction "<text>"`: what to change. */
  readonly instruction: string | undefined;
  /** `revise --passage "<quoted text>"` (AGT-1264): located with `locatePassage`. Alternative to `--start`/`--end`. */
  readonly passage: string | undefined;
  /** `revise --start <n>` (AGT-1264): a UTF-16 offset into the frontmatter-stripped body. Requires `--end`. */
  readonly start: string | undefined;
  /** `revise --end <n>` (AGT-1264): a UTF-16 offset into the frontmatter-stripped body. Requires `--start`. */
  readonly end: string | undefined;
  /** `publish --target draft|review|final` (AGT-1534). */
  readonly target: string | undefined;
  /** `share --reader <name>` (AGT-1582): a reader named in the config's `readers`. */
  readonly reader: string | undefined;
  /** `share --chapters 3|3-5` (AGT-1582). */
  readonly chapters: string | undefined;
  /** `agent --new` (AGT-1565): start a fresh harness session; the old one stays on disk. */
  readonly new: boolean;
  /** `read --list` (AGT-1583): the reader's open rounds. */
  readonly list: boolean;
  /** `read <round> --no-open` (AGT-1586): fetch the round into the cache without opening the reader window. */
  readonly noOpen: boolean;
  /** Every parsed flag, raw (AGT-1679): the casting verbs build their args from it with `verbArgsFromCli`. */
  readonly values: Readonly<Record<string, unknown>>;
}

/**
 * The five MCP-exposed verbs' own options (`project`, `for`, `stage`, `file`,
 * `chapter`, `words`, `scenes`, `dry-run`, `force`) are derived from
 * `verbs.ts`'s zod shapes (`deriveCliOptions`) rather than hand-typed here —
 * `pablo mcp` reads its tool schemas off the same shapes, so the CLI's argv
 * and the MCP surface cannot drift apart. `json`/`help`/`adopt` are CLI-only
 * flags no verb's contract includes, so they're added on top.
 */
export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  // `pablo mix --version k` (AGT-1684): `--version` is the global "print the version" flag everywhere
  // else, so for the `mix` verb (and `mixer`, AGT-1768: the mix version to open) it is read as
  // `--mix-version` and handed to the verb as `version`.
  const first = argv.find((token) => !token.startsWith("-"));
  const mixing = first === "mix" || first === "mixer";
  const tokens = mixing ? argv.map((token) => (token === "--version" ? "--mix-version" : token.startsWith("--version=") ? `--mix-${token.slice(2)}` : token)) : argv;
  const parsed = parseArgs({
    args: tokens as string[],
    allowPositionals: true,
    strict: false,
    options: {
      ...deriveCliOptions(),
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
      adopt: { type: "boolean", default: false },
      "tag-facts": { type: "boolean", default: false },
      new: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      "no-open": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      // `audition -n 6` (AGT-1679): the derived `n` option, with its short form.
      n: { type: "string", short: "n" },
      // Declared only so `cast --from-wav` is refused by name (synthetic voices only);
      // no verb's schema has it, so it never reaches a verb's args.
      "from-wav": { type: "string" },
      "mix-version": { type: "string" },
    },
  });
  const { positionals } = parsed;
  const values: Record<string, unknown> = mixing ? { ...parsed.values, version: parsed.values["mix-version"] } : parsed.values;

  return {
    verb: positionals[0],
    rest: positionals.slice(1),
    project: typeof values["project"] === "string" ? values["project"] : undefined,
    json: values["json"] === true,
    help: values["help"] === true,
    version: values["version"] === true,
    adopt: values["adopt"] === true,
    tagFacts: values["tag-facts"] === true,
    new: values["new"] === true,
    list: values["list"] === true,
    noOpen: values["no-open"] === true,
    for: typeof values["for"] === "string" ? values["for"] : undefined,
    role: typeof values["role"] === "string" ? values["role"] : undefined,
    stage: typeof values["stage"] === "string" ? values["stage"] : undefined,
    file: typeof values["file"] === "string" ? values["file"] : undefined,
    chapter: typeof values["chapter"] === "string" ? values["chapter"] : undefined,
    track: typeof values["track"] === "string" ? values["track"] : undefined,
    output: typeof values["output"] === "string" ? values["output"] : undefined,
    unit: typeof values["unit"] === "string" ? values["unit"] : undefined,
    words: typeof values["words"] === "string" ? values["words"] : undefined,
    scenes: typeof values["scenes"] === "string" ? values["scenes"] : undefined,
    dryRun: values["dry-run"] === true,
    force: values["force"] === true,
    yes: values["yes"] === true,
    temperature: typeof values["temperature"] === "string" ? values["temperature"] : undefined,
    seed: typeof values["seed"] === "string" ? values["seed"] : undefined,
    direction: typeof values["direction"] === "string" ? values["direction"] : undefined,
    voices: typeof values["voices"] === "string" ? values["voices"] : undefined,
    global: values["global"] === true,
    section: typeof values["section"] === "string" ? values["section"] : undefined,
    title: typeof values["title"] === "string" ? values["title"] : undefined,
    example: typeof values["example"] === "string" ? values["example"] : undefined,
    voice: typeof values["voice"] === "string" ? values["voice"] : undefined,
    brief: typeof values["brief"] === "string" ? values["brief"] : undefined,
    context: Array.isArray(values["context"]) ? (values["context"] as string[]) : [],
    format: typeof values["format"] === "string" ? values["format"] : undefined,
    out: typeof values["out"] === "string" ? values["out"] : undefined,
    draft: typeof values["draft"] === "string" ? values["draft"] : undefined,
    instruction: typeof values["instruction"] === "string" ? values["instruction"] : undefined,
    passage: typeof values["passage"] === "string" ? values["passage"] : undefined,
    start: typeof values["start"] === "string" ? values["start"] : undefined,
    end: typeof values["end"] === "string" ? values["end"] : undefined,
    target: typeof values["target"] === "string" ? values["target"] : undefined,
    reader: typeof values["reader"] === "string" ? values["reader"] : undefined,
    chapters: typeof values["chapters"] === "string" ? values["chapters"] : undefined,
    values,
  };
}

/** A yes/no question on the terminal (stderr, so `--json`-free stdout stays the body); anything but y/yes is no. */
async function askYesNo(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await prompt.question(question)).trim());
  } finally {
    prompt.close();
  }
}

interface Result {
  readonly ok: boolean;
  readonly code: number;
  readonly message: string;
  readonly tried?: readonly string[];
}

function emit(result: Result, json: boolean): void {
  if (json) {
    const body: Record<string, unknown> = { ok: result.ok, code: result.code, message: result.message };
    if (result.tried) body["tried"] = result.tried;
    console.log(JSON.stringify(body));
    return;
  }
  if (result.ok) console.log(result.message);
  else console.error(result.message);
}

/** Plain-text output for `pablo output` (AGT-1669): the list, what a change committed, the plan's rows, or the refusal. */
export function outputVerbText(raw: unknown): string {
  const body = raw as Record<string, unknown>;
  if (body["ok"] !== true) return [String(body["message"]), ...((body["missing"] as string[] | undefined) ?? []).map((m) => `  ${m}`)].join("\n");
  if (Array.isArray(body["outputs"])) {
    const outputs = body["outputs"] as { type: string; drafted: number; total: number; noun: string; plural: string; dir: string; next?: string }[];
    const lines = outputs.length === 0 ? ["outputs: none"] : outputs.map((o) => `${o.type}: ${o.drafted} of ${o.total} ${o.total === 1 ? o.noun : o.plural} drafted (${o.dir}/)${o.next ? `; next: ${o.next}` : ""}`);
    const available = body["available"] as string[];
    return [...lines, `available: ${available.length === 0 ? "none" : available.join(", ")}`].join("\n");
  }
  if (Array.isArray(body["rows"])) {
    const rows = body["rows"] as { unit: number; title: string; beats: number[]; status: string }[];
    const head = body["dryRun"] === true ? `pablo: output plan ${String(body["type"])}: ${String(body["path"])} (dry run)` : `pablo: output plan ${String(body["type"])}: ${String(body["path"])} ${body["changed"] === true ? (body["committed"] === true ? "rewritten (committed)" : "rewritten") : "unchanged"}`;
    return [head, ...rows.map((r) => `  ${r.unit}  ${r.title}  beats ${r.beats.join(", ")}  ${r.status}`), ...(body["notice"] ? [String(body["notice"])] : [])].join("\n");
  }
  const paths = (body["paths"] as string[]).map((p) => `  ${p}`);
  const what = body["action"] === "remove" ? (body["archived"] !== undefined ? `removed, archived to ${String(body["archived"])}` : "removed") : "added";
  return [`pablo: output ${String(body["type"])}: ${what}${body["committed"] === true ? " (committed)" : ""}`, ...paths, ...(body["notice"] ? [String(body["notice"])] : [])].join("\n");
}

/** Plain-text output for `check --across` (AGT-1671): each finding with both sources and its promote commands. */
export function acrossText(raw: unknown): string {
  const body = raw as Record<string, unknown>;
  if (body["ok"] !== true) return String(body["message"]);
  const findings = (body["findings"] ?? []) as { id: string; claim: string; sources: { output: string; ledger: string; line: number; fact: string; tag?: string }[]; actions: { command: string }[] }[];
  if (findings.length === 0) return `no contradictions between outputs${typeof body["note"] === "string" ? ` (${body["note"]})` : ""}`;
  return findings
    .map((f) =>
      [
        `${f.id}  ${f.claim}`,
        ...f.sources.map((s) => `  ${s.output}${s.tag ? ` ${s.tag}` : ""}: ${s.fact}  (${s.ledger}:${s.line})`),
        ...f.actions.map((a) => `  promote: ${a.command}`),
      ].join("\n"),
    )
    .join("\n");
}

/** Plain-text output for `research save` and `fact record` (AGT-2106). */
export function researchFactText(raw: unknown): string {
  const body = raw as Record<string, unknown>;
  if (body["ok"] !== true) return String(body["message"]);
  const review = "  review the branch in the screen (pablo), then merge it";
  if (typeof body["added"] === "number") {
    // `research plan` (AGT-2111).
    const items = (body["items"] ?? []) as { number: number; category: string; item: string; status: string }[];
    const rejected = (body["rejected"] ?? []) as { item: string; reason: string }[];
    return [
      `pablo: planned ${String(body["added"])} new checklist item${body["added"] === 1 ? "" : "s"} from ${String(body["from"])} -> ${String(body["path"])} on ${String(body["branch"])}`,
      ...items.map((i) => `  #${i.number} ${i.category}: ${i.item} (${i.status})`),
      ...rejected.map((r) => `  rejected: ${r.item || "(empty)"} (${r.reason})`),
      review,
    ].join("\n");
  }
  if (typeof body["open"] === "number") {
    // `research waive|link`, or `research save --item` (AGT-2111).
    const items = (Array.isArray(body["items"]) ? body["items"] : [body["item"]]) as { number: number; category: string; item: string; status: string }[];
    const saved = body["note"] !== undefined;
    const head = saved ? `saved ${String(body["path"])} and research/checklist.md` : `updated ${String(body["path"])}`;
    return [
      `pablo: ${head} on ${String(body["branch"])}`,
      ...items.map((i) => `  #${i.number} ${i.category}: ${i.item} -> ${i.status}`),
      `  ${String(body["open"])} checklist item${body["open"] === 1 ? "" : "s"} still open once merged`,
      review,
    ].join("\n");
  }
  if (typeof body["facts"] === "number") {
    // `research distill` (AGT-2109).
    const rejected = (body["rejected"] ?? []) as { fact: string; reason: string }[];
    const swapped = (body["swapped"] ?? []) as { from: string; to: string }[];
    return [
      `pablo: distilled ${String(body["facts"])} period fact${body["facts"] === 1 ? "" : "s"} -> ${String(body["path"])} on ${String(body["branch"])}`,
      ...swapped.map((s) => `  swapped ${s.from} -> ${s.to}`),
      ...rejected.map((r) => `  rejected: ${r.fact || "(empty)"} (${r.reason})`),
      "  review the branch in the screen (pablo), then merge it",
    ].join("\n");
  }
  const what = typeof body["line"] === "string" ? `recorded ${String(body["line"])} ->` : "saved";
  return [`pablo: ${what} ${String(body["path"])} on ${String(body["branch"])}`, "  review the branch in the screen (pablo), then merge it"].join("\n");
}

/** Plain-text output for `promote` (AGT-1671). */
export function promoteText(raw: unknown): string {
  const body = raw as Record<string, unknown>;
  if (body["ok"] !== true) return String(body["message"]);
  const comments = (body["comments"] ?? []) as { path: string; line?: number }[];
  return [
    `pablo: promote ${String(body["finding"])}: ${String(body["line"])} -> ${String(body["path"])} on ${String(body["branch"])}`,
    ...comments.map((c) => `  comment on ${c.path}${c.line !== undefined ? `:${c.line}` : ""}`),
    ...((body["notices"] ?? []) as string[]),
    "  review the branch in the screen (pablo), then merge it",
  ].join("\n");
}

/** Runs one verb off its `VERBS` entry with the CLI's flags, printing `text(body)` (or the JSON body). */
async function runVerbEntry(name: string, args: ParsedArgs, cwd: string, text: (body: unknown) => string): Promise<number> {
  const verb = VERBS.find((v) => v.name === name) as (typeof VERBS)[number];
  const built = verbArgsFromCli(verb, args.values, args.rest);
  if (!built.ok) {
    emit({ ok: false, code: EXIT_REFUSED, message: built.message }, args.json);
    return EXIT_REFUSED;
  }
  const result = await verb.run(built.args as never, { cwd, env: process.env, stderr: process.stderr });
  if (args.json) console.log(JSON.stringify(result.body));
  else if ((result.body as { ok?: boolean }).ok === true) console.log(text(result.body));
  else console.error(text(result.body));
  return result.exitCode;
}

/** The verbs `cli.ts` dispatches straight off their `VERBS` entry (AGT-1679). */
const CASTING_VERBS: ReadonlySet<string> = new Set(["audition", "cast", "voices", "perform", "mix", "fix", "describe_voice"]);

/** Plain-text output for a casting verb's body. */
export function castingText(verb: string, body: Record<string, unknown>): string {
  const lines: string[] = [];
  if (typeof body["message"] === "string") lines.push(`pablo: ${body["message"]}`);
  if (verb === "audition" && Array.isArray(body["candidates"])) {
    for (const c of body["candidates"] as Array<Record<string, unknown>>) {
      const scores = (c["scores"] ?? {}) as Record<string, unknown>;
      const near = (c["near_duplicates"] as number[] | undefined) ?? [];
      lines.push(
        `  ${String(c["candidate"])}: seed ${String(c["seed"])}, ${String(c["seconds"])} s${c["reference_ok"] ? "" : " (too short or long for a reference)"}, ` +
          `naturalness ${String(scores["utmos"])}/5, ${String(scores["pitch_hz"])} Hz, ${String(scores["wps"])} w/s` +
          (near.length > 0 ? `, sounds like ${near.join(", ")}` : "") +
          `  ${String(c["file"])}`,
      );
    }
  }
  if (verb === "voices" && Array.isArray(body["voices"])) {
    const rows = body["voices"] as Array<Record<string, unknown>>;
    if (rows.length === 0) lines.push(`pablo: no voices in ${String(body["library"])}`);
    for (const row of rows) {
      if (row["cast"] !== true) {
        lines.push(`${String(row["slug"])}  not cast (${String(row["auditions"])} auditions)`);
        continue;
      }
      const traits = Object.entries((row["traits"] ?? {}) as Record<string, unknown>)
        .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("/") : String(v)}`)
        .join(" ");
      const status = [row["retired"] ? "retired" : "", row["admitted_by"] === "auto" ? "auto-admitted" : ""].filter(Boolean).join(", ");
      lines.push(`${String(row["slug"])}  ${String(row["hash"]).slice(0, 12)}  ${traits}${status ? `  (${status})` : ""}`);
    }
  }
  if (verb === "cast" && Array.isArray(body["bindings"])) {
    for (const b of body["bindings"] as Array<Record<string, unknown>>) {
      const runner = b["runnerUp"] as { slug?: unknown; score?: unknown } | null | undefined;
      const score = typeof b["score"] === "number" ? `, score ${String(b["score"])}` : "";
      lines.push(
        `  ${String(b["role"])} -> ${String(b["slug"])} (${String(b["by"])}${score}` +
          (runner ? `, runner-up ${String(runner.slug)} ${String(runner.score)}` : "") +
          `)${b["review"] ? "  REVIEW" : ""}${b["pin"] !== undefined && b["pin"] !== "ok" ? `  PIN ${String(b["pin"]).toUpperCase()}` : ""}`,
      );
    }
    const refused = new Set(((body["refused"] as Array<Record<string, unknown>> | undefined) ?? []).map((r) => String(r["role"])));
    for (const n of (body["needsDesign"] as Array<Record<string, unknown>> | undefined) ?? []) {
      if (refused.has(String(n["role"]))) continue;
      lines.push(`  ${String(n["role"])}: needs a designed voice (${String(n["reason"])})`);
    }
    for (const r of (body["refused"] as Array<Record<string, unknown>> | undefined) ?? []) {
      lines.push(`  ${String(r["role"])}: REFUSED (${String(r["message"])})`);
    }
    for (const d of (body["designed"] as Array<Record<string, unknown>> | undefined) ?? []) {
      lines.push(`  ${String(d["role"])}: designed ${String(d["slug"])} (round ${String(d["round"])}, candidate ${String(d["candidate"])}), card ${String(d["hash"]).slice(0, 12)}`);
    }
  }
  if (verb === "describe_voice" && typeof body["traits"] === "object" && body["traits"] !== null) {
    const traits = Object.entries(body["traits"] as Record<string, unknown>)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("/") : String(v)}`)
      .join(" ");
    lines.push(`  traits: ${traits || "(none)"}`);
    const free = (body["freeText"] as readonly string[] | undefined) ?? [];
    if (free.length > 0) lines.push(`  not normalised: ${free.join("; ")} (choose traits for these and pass --role-traits to cast --auto --design)`);
    lines.push(`  instruct: ${String(body["instruct"])}`);
  }
  if (verb === "perform" && typeof body["manifest"] === "string") {
    lines.push(`  manifest: ${body["manifest"]}`);
    lines.push(`  wall ${String(body["wall"])} s for ${String(body["audioSeconds"])} s of audio; rtf_total ${String(body["rtfTotal"])}, engine ${String(body["rtfEngine"])}`);
    const flags = (body["flags"] as readonly string[] | undefined) ?? [];
    if (flags.length > 0) lines.push(`  ${flags.length} line(s) auto-flagged for pablo fix`);
    const ttfa = body["ttfa"] as { first_audio?: unknown; playable?: unknown; chapter?: unknown } | undefined;
    if (ttfa !== undefined) {
      lines.push(`  time to first audio ${String(ttfa.first_audio)} s, playable after ${String(ttfa.playable)} s, episode file after ${String(ttfa.chapter)} s`);
    }
    if (typeof body["audio"] === "string") lines.push(`  audio: ${body["audio"]}`);
  }
  if (verb === "mix" && typeof body["audio"] === "string") {
    lines.push(`  audio: ${body["audio"]}`);
    lines.push(`  manifest: ${String(body["manifest"])}`);
    lines.push(`  ${String(body["duration"])} s, ${String(body["cuesGenerated"])} cue(s) generated, ${String(body["cuesReused"])} reused (${String(body["cueLibrary"])})`);
    if (body["linkMoved"] === false) lines.push("  epNN.m4a was left on the newer version that already has audio");
  }
  if (verb === "fix" && typeof body["manifest"] === "string") {
    lines.push(`  manifest: ${body["manifest"]}`);
    lines.push(`  changed lines: ${((body["changedLines"] as readonly number[] | undefined) ?? []).join(", ")}`);
    if (typeof body["audio"] === "string") lines.push(`  audio: ${body["audio"]}`);
    const again = (body["flags"] as readonly string[] | undefined) ?? [];
    if (again.length > 0) lines.push(`  ${again.length} line(s) flagged again automatically`);
  }
  if (verb === "voices" && body["card"] !== undefined) {
    lines.push(`${String(body["slug"])}  ${String(body["hash"])}${body["retired"] ? "  (retired)" : ""}${body["reference_intact"] ? "" : "  REFERENCE CHANGED"}`);
    lines.push(JSON.stringify(body["card"], null, 2));
  }
  return lines.length > 0 ? lines.join("\n") : JSON.stringify(body, null, 2);
}

async function runCastingVerb(args: ParsedArgs, cwd: string): Promise<number> {
  const verb = VERBS.find((v) => v.name === args.verb);
  if (verb === undefined) return EXIT_ERROR;
  if (args.verb === "cast" && args.values["from-wav"] !== undefined) {
    const message = "pablo: cast has no --from-wav: voices are synthetic only, and a card's reference comes from a designer (`pablo audition`), never from a recording";
    emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
    return EXIT_REFUSED;
  }
  const built = verbArgsFromCli(verb, args.values, args.rest);
  if (!built.ok) {
    emit({ ok: false, code: EXIT_ERROR, message: built.message }, args.json);
    return EXIT_ERROR;
  }
  const result = await verb.run(built.args as never, { cwd, env: process.env, stderr: process.stderr, stdout: process.stdout });
  const body = result.body as Record<string, unknown>;
  if (args.json) console.log(JSON.stringify(body));
  else if (body["ok"] === true) console.log(castingText(verb.name, body));
  else console.error(typeof body["message"] === "string" ? (body["message"].startsWith("pablo") ? body["message"] : `pablo: ${body["message"]}`) : "pablo: failed");
  // A partly failed design (AGT-1699): one line per refused role, and the roles that were designed and bound.
  if (!args.json && body["ok"] !== true && Array.isArray(body["refused"])) {
    console.error(castingText(verb.name, { ...body, message: undefined }));
  }
  return result.exitCode;
}

function refusalResult(refusal: Refusal): Result {
  return { ok: false, code: refusal.code, message: refusal.message, tried: refusal.tried };
}

/**
 * The AC4 gate: every verb but `init` refuses (exit 2) when the resolved
 * project has no valid `pablo.json`. Delegates to `readMarker`, whose
 * refusal already names the missing/invalid key or points at
 * `pablo init --adopt`.
 */
function requireMarker(projectPath: string): Refusal | undefined {
  const marker = readMarker(projectPath);
  return marker.ok ? undefined : marker;
}

function emitInitResult(result: InitResult, json: boolean): number {
  if (!result.ok) {
    emit(refusalResult(result), json);
    return result.code;
  }

  if (json) {
    const body: Record<string, unknown> = {
      ok: true,
      path: result.path,
      format: result.format ?? null,
      ...(result.track === undefined ? {} : { track: result.track }),
      slug: result.slug,
      title: result.title,
      committed: result.committed,
    };
    if (result.notice) body["notice"] = result.notice;
    console.log(JSON.stringify(body));
  } else {
    const committedNote = result.committed ? " (committed)" : "";
    console.log(result.adoptedLine ?? `pablo: created ${result.path}${committedNote}`);
    if (result.notice) console.log(result.notice);
  }

  return EXIT_OK;
}

function runInit(args: ParsedArgs, cwd: string): number {
  const vaultResult = findVault(cwd);
  if (!vaultResult.ok) {
    emit(refusalResult(vaultResult), args.json);
    return vaultResult.code;
  }
  const vault = vaultResult.path;

  if (args.adopt) {
    if (args.project === undefined) {
      const message = "pablo: init --adopt requires --project <slug>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }

    const resolved = resolveProjectFromCwd(cwd, args.project);
    if (!resolved.ok) {
      emit(refusalResult(resolved), args.json);
      return resolved.code;
    }

    return emitInitResult(initAdopt(vault, resolved.path, args.project, { author: vaultAuthor(vault) }), args.json);
  }

  // `pablo init --track <t> <slug> "<Title>"` (AGT-2103): a core-only work on the track, no output yet.
  if (args.track !== undefined && args.rest.length === 2) {
    const [coreSlug, coreTitle] = args.rest as [string, string];
    // `pablo init novel <slug> --track t` (the title left off) is a mistyped novel init, not a work named "novel".
    if (isOutputId(coreSlug)) {
      const message = `pablo: init: "${coreSlug}" is an output, not a slug; did you mean pablo init ${coreSlug} <slug> "<Title>" --track ${args.track}?`;
      emit({ ok: false, code: EXIT_ERROR, message }, args.json);
      return EXIT_ERROR;
    }
    return emitInitResult(initTrack(vault, coreSlug, coreTitle, args.track, { author: vaultAuthor(vault) }), args.json);
  }

  const [format, slug, title] = args.rest;
  if (format === undefined || slug === undefined || title === undefined) {
    const message = 'pablo: usage: pablo init <format> <slug> "<Title>" [--track <t>], or pablo init --track <t> <slug> "<Title>"';
    emit({ ok: false, code: EXIT_ERROR, message }, args.json);
    return EXIT_ERROR;
  }

  if (format !== "novel") {
    const message = `pablo: init: only "novel" is implemented (got "${format}")`;
    emit({ ok: false, code: EXIT_ERROR, message }, args.json);
    return EXIT_ERROR;
  }

  return emitInitResult(initNovel(vault, slug, title, { author: vaultAuthor(vault), ...(args.track === undefined ? {} : { track: args.track }) }), args.json);
}

/**
 * `pablo status --project <slug> [--for "chapter N"]`. With no `--for`, the
 * work in both layers (AGT-1667): the core's stages, then each output's
 * units, the branches waiting for review, and `next` (JSON: `readWorkStatus`;
 * prose: `formatStatusProse`). With
 * `--for`, one chapter's preconditions — JSON body is `{ready, missing}`
 * (no `ok`/`code` wrapper: a refused precondition is data here, not a
 * framework-resolution failure), and the exit code carries readiness: 0 when
 * ready, 2 when not (a framework precondition, same as every other refusal).
 */
function runStatus(args: ParsedArgs, projectPath: string): number {
  if (args.for !== undefined) {
    // `--for "episode N"` (AGT-1680): a radio episode is ready when every role in its script is bound to a voice.
    const episode = parseForEpisode(args.for);
    if (episode !== undefined) {
      const result = radioStatus({ env: process.env, stderr: process.stderr }, realCastingDeps(process.env), projectPath, episode);
      const body = result.body as { ready?: boolean; missing?: string[]; message?: string };
      if (args.json) console.log(JSON.stringify(result.body));
      else if (body.ready !== undefined) {
        console.log(`episode ${episode}: ${body.ready ? "ready" : "not ready"}`);
        for (const item of body.missing ?? []) console.log(`  ${item}`);
      } else console.error(body.message ?? "pablo: status failed");
      return result.exitCode;
    }

    // `--for "<output> N"` (AGT-1669): the addressed output's preconditions for one unit.
    const result = unitStatus(projectPath, args.for);
    const body = result.body as { ready?: boolean; missing?: string[]; message?: string };
    if (args.json) {
      console.log(JSON.stringify(result.body));
    } else if (body.ready !== undefined) {
      console.log(`${result.label ?? args.for.trim()}: ${body.ready ? "ready" : "not ready"}`);
      for (const item of body.missing ?? []) console.log(`  ${item}`);
      // A radio episode (AGT-1686) also says its stage, render, open flags and the casting side.
      for (const line of result.lines ?? []) console.log(`  ${line}`);
    } else {
      console.error(body.message ?? "pablo: status failed");
      for (const item of body.missing ?? []) console.error(`  ${item}`);
    }
    return result.exitCode;
  }

  const status = readWorkStatus(projectPath);
  console.log(args.json ? JSON.stringify(status) : formatStatusProse(status));
  return EXIT_OK;
}

/** One line per rule/exemplar/never source — `voice show`'s prose rendering, "the assembled voice as a model will see it." */
function formatVoice(voice: Voice): string {
  const parts: string[] = [];
  for (const rule of voice.rules) parts.push(rule.text);
  if (voice.never) parts.push(voice.never.text);
  if (voice.exemplars.length > 0) {
    parts.push(["Exemplars:", ...voice.exemplars.map((ex) => `- ${ex.path}`)].join("\n"));
  }
  return parts.join("\n\n");
}

/**
 * `pablo read --list` / `pablo read <repo>#<pr>` (AGT-1583): the reader's rounds on GitHub, with the
 * `gh` runner and environment injectable so tests never reach GitHub.
 */
export function runReadRounds(args: ParsedArgs, run: Runner = realRunner, env: Record<string, string | undefined> = process.env): number {
  if (args.list) {
    const listed = listReaderRounds({ run, env });
    if (!listed.ok) {
      emit({ ok: false, code: listed.code, message: listed.message }, args.json);
      return listed.code;
    }
    if (args.json) {
      console.log(JSON.stringify({ ok: true, rounds: listed.rounds, notices: listed.notices }));
    } else {
      if (listed.rounds.length === 0) console.log("pablo: no reading rounds waiting for you");
      for (const round of listed.rounds) {
        const chapters = round.chapters.map((c) => (c.number > 0 ? String(c.number) : c.path)).join(", ") || "-";
        const sent = round.status === "sent" ? "  [sent]" : "";
        console.log(`${round.ref}  chapters ${chapters}  from ${round.sender || "?"}  ${round.date.slice(0, 10)}${sent}`);
      }
      for (const notice of listed.notices) console.error(notice);
    }
    return EXIT_OK;
  }
  const ref = parseRoundRef(args.rest[0] ?? "");
  if (ref === undefined) {
    emit({ ok: false, code: EXIT_REFUSED, message: "pablo: read requires a round like <slug>-reading#<pr>" }, args.json);
    return EXIT_REFUSED;
  }
  const fetched = fetchRound({ run, env, ref });
  if (!fetched.ok) {
    emit({ ok: false, code: fetched.code, message: fetched.message }, args.json);
    return fetched.code;
  }
  if (args.json) console.log(JSON.stringify({ ok: true, reused: fetched.reused, dir: fetched.dir, ...fetched.round }));
  else console.log(`pablo: ${fetched.reused ? "already have" : "fetched"} ${fetched.round.repo}#${fetched.round.pr} at ${fetched.round.commit.slice(0, 7)}: ${fetched.dir}`);
  return EXIT_OK;
}

/**
 * `pablo read <repo>#<pr>` (AGT-1586): fetch the round, then open the reader window on it and hold the
 * process until the window closes. `--no-open` is the fetch alone (`runReadRounds`). `open` is injectable
 * so tests never start a window.
 */
export async function runReadView(args: ParsedArgs, open: typeof openReader = openReader): Promise<number> {
  const ref = parseRoundRef(args.rest[0] ?? "");
  if (ref === undefined) {
    emit({ ok: false, code: EXIT_REFUSED, message: "pablo: read requires a round like <slug>-reading#<pr>" }, args.json);
    return EXIT_REFUSED;
  }
  const opened = await open(ref);
  if (!opened.ok) {
    emit({ ok: false, code: opened.code, message: opened.message }, args.json);
    return opened.code;
  }
  if (args.json) console.log(JSON.stringify({ ok: true, ref: roundRefLabel(ref), url: opened.view.url }));
  else console.log(`pablo: opened ${roundRefLabel(ref)} in the reader window; close it when you are done`);
  await opened.closed;
  return EXIT_OK;
}

/**
 * `pablo review --project W [--episode N]` (AGT-1693): open the review player on a radio work and hold the
 * process until the window closes. `open` is injectable so tests never start a window.
 */
export async function runReviewView(args: ParsedArgs, projectPath: string | undefined, open: typeof openReview = openReview): Promise<number> {
  const episodeArg = args.values["episode"];
  const episode = episodeArg === undefined ? undefined : Number(episodeArg);
  if (projectPath === undefined || (episode !== undefined && (!Number.isInteger(episode) || episode < 1))) {
    const message = projectPath === undefined ? "pablo: review requires --project <slug>" : "pablo: review: --episode expects a whole number of 1 or more";
    emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
    return EXIT_REFUSED;
  }
  // The radio output's stage machine (AGT-1686): the player plays mixed versions, so an episode with none is refused by name.
  if (episode !== undefined) {
    const check = radioStageCheck(projectPath, "review", episode);
    if (!check.ready) {
      const message = `pablo: review: radio episode ${episode} is not ready to review (${check.missing.join("; ")}); nothing was opened`;
      if (args.json) console.log(JSON.stringify({ ok: false, code: EXIT_REFUSED, message, missing: check.missing }));
      else console.error(message);
      return EXIT_REFUSED;
    }
  }
  const marker = readMarker(projectPath);
  const opened = await open(projectPath, marker.ok ? marker.marker.title : args.project ?? "radio", episode);
  if (!opened.ok) {
    emit({ ok: false, code: opened.code, message: opened.message }, args.json);
    return opened.code;
  }
  if (args.json) console.log(JSON.stringify({ ok: true, url: opened.view.url }));
  else console.log(`pablo: opened the review player${episode === undefined ? "" : ` on episode ${episode}`}; close it when you are done`);
  await opened.closed;
  return EXIT_OK;
}

/**
 * `pablo mixer --project W --episode N [--version k] [--library DIR]` (AGT-1768): open the mixer on one episode's
 * mix document and hold the process until the window closes. `open` is injectable so tests never start a window.
 */
export async function runMixerView(args: ParsedArgs, projectPath: string | undefined, cwd: string, open: typeof openMixer = openMixer): Promise<number> {
  const whole = (value: unknown): number | undefined | null => (value === undefined ? undefined : Number.isInteger(Number(value)) && Number(value) >= 1 ? Number(value) : null);
  const episode = whole(args.values["episode"] ?? args.unit);
  const version = whole(args.values["version"]);
  let message: string | undefined;
  if (projectPath === undefined) message = "pablo: mixer requires --project <slug> and --episode N";
  else if (episode === undefined) message = "pablo: mixer requires --episode N";
  else if (episode === null) message = "pablo: mixer: --episode expects a whole number of 1 or more";
  else if (version === null) message = "pablo: mixer: --version expects a whole number of 1 or more";
  if (message !== undefined || projectPath === undefined || episode === undefined || episode === null || version === null) {
    emit({ ok: false, code: EXIT_REFUSED, message: message ?? "pablo: mixer: bad arguments" }, args.json);
    return EXIT_REFUSED;
  }
  const marker = readMarker(projectPath);
  const vault = findVault(cwd, process.env);
  // `--export-notes` (AGT-1792): no window, no Chrome, no mix document: the saved markers to a punch list.
  if (args.values["export-notes"] !== undefined && args.values["export-notes"] !== false) {
    try {
      const exported = createNotesHost({ work: projectPath, title: marker.ok ? marker.marker.title : args.project ?? "radio" }).exportNotes({ episode });
      if (args.json) console.log(JSON.stringify({ ok: true, path: exported.path, count: exported.count }));
      else console.log(`pablo: wrote the punch list for episode ${episode} (${exported.count} ${exported.count === 1 ? "note" : "notes"}): ${exported.path}`);
      return EXIT_OK;
    } catch (error) {
      emit({ ok: false, code: EXIT_REFUSED, message: `pablo: mixer: ${(error as Error).message}` }, args.json);
      return EXIT_REFUSED;
    }
  }
  const library = args.values["library"];
  const opened = await open({
    work: projectPath,
    title: marker.ok ? marker.marker.title : args.project ?? "radio",
    episode,
    ...(version === undefined ? {} : { version }),
    ...(vault.ok ? { vault: vault.path } : {}),
    ...(typeof library === "string" ? { library } : {}),
    casting: realCastingDeps(process.env),
  });
  if (!opened.ok) {
    emit({ ok: false, code: opened.code, message: opened.message }, args.json);
    return opened.code;
  }
  if (args.json) console.log(JSON.stringify({ ok: true, url: opened.view.url }));
  else console.log(`pablo: opened the mixer on episode ${episode}; close it when you are done`);
  await opened.closed;
  return EXIT_OK;
}

/**
 * `pablo voice new|list|show|flag|exemplar` (AGT-1240, `flag`/`exemplar`
 * AGT-1243). `sub`/`name` are positionals (`args.rest`), as is `flag`'s
 * `<line>` and `exemplar`'s `<file>` (`args.rest[2]`) — `--global`,
 * `--section`, `--title`, and `--json` are the only flags this verb takes.
 * There is no `--project`: a voice resolves from `cwd`/`PABLO_VAULT` (vault)
 * plus the global voices directory, never a `<vault>/<kind>/<slug>` project.
 */
function runVoice(args: ParsedArgs, cwd: string): number {
  const [sub, name, extra] = args.rest;
  const env = process.env;

  if (sub === "list") {
    const { body, exitCode } = runVoiceList({ project: args.project }, { cwd, env });
    const b = body as { ok: boolean; message?: string; voices?: readonly { name: string; scope: string; path: string }[]; rules?: readonly { id: string; target: string; text: string }[] };
    if (args.json) {
      console.log(JSON.stringify(body));
    } else if (!b.ok) {
      console.error(String(b.message));
    } else {
      const voices = b.voices ?? [];
      if (voices.length === 0) console.log("pablo: no voices found");
      for (const v of voices) console.log(`${v.name}\t${v.scope}\t${v.path}`);
      const rules = b.rules ?? [];
      if (rules.length > 0) {
        console.log("");
        console.log("rules (id, target, text):");
        for (const r of rules) console.log(`${r.id}\t${r.target}\t${r.text}`);
      }
    }
    return exitCode;
  }

  if (sub === "edit" || sub === "remove" || sub === "use") {
    const usage = {
      edit: 'pablo: usage: pablo voice edit <id> "<text>" [--target <t>] [--project <slug>]',
      remove: "pablo: usage: pablo voice remove <id> [--target <t>] [--project <slug>]",
      use: "pablo: usage: pablo voice use <name> --project <slug>",
    }[sub];
    if (name === undefined || (sub === "edit" && extra === undefined)) {
      emit({ ok: false, code: EXIT_REFUSED, message: usage }, args.json);
      return EXIT_REFUSED;
    }
    const ctx = { cwd, env };
    const { body, exitCode } =
      sub === "edit"
        ? runVoiceEdit({ id: name, text: extra ?? "", target: args.target, project: args.project }, ctx)
        : sub === "remove"
          ? runVoiceRemove({ id: name, target: args.target, project: args.project }, ctx)
          : runVoiceUse({ name, project: args.project }, ctx);
    const b = body as { ok: boolean; id?: string; path?: string; committed?: boolean; notice?: string; message?: string; added?: boolean };
    if (args.json) {
      console.log(JSON.stringify(body));
    } else if (!b.ok) {
      console.error(String(b.message));
    } else {
      const verb = sub === "edit" ? `rule is now ${b.id} in` : sub === "remove" ? "rule removed from" : b.added ? "voice added in" : "voice already in";
      console.log(`pablo: ${verb} ${b.path}${b.committed ? " (committed)" : ""}`);
      if (b.notice) console.log(b.notice);
    }
    return exitCode;
  }

  if (sub === "new") {
    if (name === undefined) {
      const message = "pablo: usage: pablo voice new <name> [--global]";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    const result = scaffoldVoice(name, { cwd, env, global: args.global });
    if (!result.ok) {
      emit(refusalResult(result), args.json);
      return result.code;
    }
    if (args.json) {
      const body: Record<string, unknown> = {
        ok: true,
        path: result.path,
        scope: result.scope,
        committed: result.committed,
      };
      if (result.notice) body["notice"] = result.notice;
      console.log(JSON.stringify(body));
    } else {
      console.log(`pablo: created ${result.path}${result.committed ? " (committed)" : ""}`);
      if (result.notice) console.log(result.notice);
    }
    return EXIT_OK;
  }

  if (sub === "show") {
    if (name === undefined) {
      const message = "pablo: usage: pablo voice show <name>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    const resolution = resolveVoice(name, { cwd, env });
    if (!resolution.ok) {
      emit(refusalResult(resolution), args.json);
      return resolution.code;
    }
    const voice = readVoice(resolution.path);
    if (args.json) {
      console.log(JSON.stringify({ ok: true, ...voice }));
    } else {
      console.log(formatVoice(voice));
    }
    return EXIT_OK;
  }

  if (sub === "flag") {
    if (name === undefined || extra === undefined) {
      const message = 'pablo: usage: pablo voice flag <name> "<line>" [--section <heading>]';
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    const resolution = resolveVoice(name, { cwd, env });
    if (!resolution.ok) {
      emit(refusalResult(resolution), args.json);
      return resolution.code;
    }
    const result = flagLine(resolution, extra, { section: args.section });
    if (!result.ok) {
      emit(refusalResult(result), args.json);
      return result.code;
    }
    if (args.json) {
      const body: Record<string, unknown> = { ok: true, path: result.path, committed: result.committed };
      if (result.notice) body["notice"] = result.notice;
      console.log(JSON.stringify(body));
    } else {
      console.log(`pablo: flagged in ${result.path}${result.committed ? " (committed)" : ""}`);
      if (result.notice) console.log(result.notice);
    }
    return EXIT_OK;
  }

  if (sub === "exemplar") {
    if (name === undefined || extra === undefined) {
      const message = 'pablo: usage: pablo voice exemplar <name> <file> [--title "<t>"]';
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    const resolution = resolveVoice(name, { cwd, env });
    if (!resolution.ok) {
      emit(refusalResult(resolution), args.json);
      return resolution.code;
    }
    // The CLI's <file> is author-typed, exactly like `save`'s `--file` on
    // the CLI path — resolved against cwd, not bounded to the vault (that
    // bound applies over MCP, where the value is model-controlled instead).
    const sourceFile = resolve(cwd, extra);
    const result = addExemplar(resolution, sourceFile, { title: args.title });
    if (!result.ok) {
      emit(refusalResult(result), args.json);
      return result.code;
    }
    if (args.json) {
      const body: Record<string, unknown> = { ok: true, path: result.path, committed: result.committed };
      if (result.notice) body["notice"] = result.notice;
      console.log(JSON.stringify(body));
    } else {
      console.log(`pablo: kept ${result.path}${result.committed ? " (committed)" : ""}`);
      if (result.notice) console.log(result.notice);
    }
    return EXIT_OK;
  }

  if (sub === "rule") {
    // With a layer --target the voice name is not needed: `voice rule "<text>" --target global`.
    const layered = args.target !== undefined && args.target !== "voice";
    const ruleName = layered && extra === undefined ? undefined : name;
    const ruleText = layered && extra === undefined ? name : extra;
    if (ruleText === undefined || (!layered && ruleName === undefined)) {
      const message = `pablo: usage: pablo voice rule <name> "<text>" [--example "<sentences>"] [--target voice] | pablo voice rule "<text>" --target ${TARGET_USAGE} [--project <slug>]`;
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    const { body, exitCode } = runVoiceRule(
      { name: ruleName, text: ruleText, example: args.example, target: args.target, project: args.project },
      { cwd, env },
    );
    const b = body as { ok: boolean; path?: string; committed?: boolean; notice?: string; message?: string };
    if (args.json) {
      console.log(JSON.stringify(body));
    } else if (!b.ok) {
      console.error(String(b.message));
    } else {
      console.log(`pablo: rule added in ${b.path}${b.committed ? " (committed)" : ""}`);
      if (b.notice) console.log(b.notice);
    }
    return exitCode;
  }

  const message = `pablo: voice: unknown subcommand "${sub ?? ""}" (expected new, list, show, flag, exemplar, rule, edit, remove, or use)`;
  emit({ ok: false, code: EXIT_ERROR, message }, args.json);
  return EXIT_ERROR;
}

/**
 * The project the screen opens on: the nearest ancestor of `cwd` (inclusive)
 * with a valid `pablo.json`, or undefined when `cwd` is not inside a project.
 */
export function bareScreenTarget(cwd: string): { title: string; format: string; dir: string } | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const found = readMarker(dir);
    if (found.ok) return { title: found.marker.title, format: outputsLabel(found.marker), dir };
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The compose view's session spec for the project at `dir` (AGT-1566): the same inputs `pablo agent` builds, so the
 * two run the same agent: the marker, the work's judgement policy and its STYLE.md (`loadPromptWork`), the config's
 * credential. Throws with the refusal's message; the composer calls it on the first message, so a refusal (an unknown
 * policy, no credential) shows in the conversation, not before the screen opens. pablo's tools run in this process;
 * their progress goes nowhere (stderr would draw over the screen).
 */
export function composeSpec(dir: string, cwd: string, env: Record<string, string | undefined> = process.env): HarnessSpec {
  const marker = readMarker(dir);
  if (!marker.ok) throw new Error(marker.message);
  const work = loadPromptWork(dir, marker.marker, basename(dir));
  if (!work.ok) throw new Error(work.message);
  return {
    work: work.work,
    provider: harnessProvider(loadConfig({ env, projectDir: dir }), { keys: { env } }),
    ctx: { cwd, env, stderr: { write: () => {} }, caller: "mcp" },
  };
}

const screenComposer = (dir: string, cwd: string): Composer => createComposer(() => composeSpec(dir, cwd));

/**
 * Every value of a repeatable string flag, in argument order (`--output novel --output story`,
 * `--output=radio`). `parseArgs` keeps only the last value of a flag another verb declares as a
 * single string (`write --output`), so `story` reads its own repeats off the raw argv.
 */
export function repeatedFlag(argv: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (token === "--") break;
    if (token === `--${flag}`) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        values.push(next);
        i += 1;
      }
    } else if (token.startsWith(`--${flag}=`)) {
      values.push(token.slice(flag.length + 3));
    }
  }
  return values;
}

/** One line per thing a story run did, or the branch it waits on. */
function storyText(body: Record<string, unknown>, trackLine: (choice: TrackChoice) => string): string {
  const waiting = body["waiting"] as { step: string; branch?: string; review?: string; unit?: number } | undefined;
  if (waiting !== undefined) {
    // A radio approval (AGT-1700) waits on the episode's bindings or render, not a branch.
    const on = waiting.branch ?? `radio episode ${String(waiting.unit)}'s ${waiting.review === "binding" ? "voices" : "render"}`;
    return `pablo: story ${String(body["project"])} is waiting on ${on}\n  next: ${String(body["next"])}`;
  }
  const published = (body["published"] ?? {}) as Record<string, { where: string; words: number; episodes?: readonly unknown[] }>;
  const assumptions = (body["assumptions"] ?? []) as { question: string }[];
  const track = body["track"] as TrackChoice | undefined;
  return [
    `pablo: wrote ${String(body["project"])} (${String(body["path"])})`,
    ...(track === undefined ? [] : [`  track: ${trackLine(track)}`]),
    ...Object.entries(published).map(([id, p]) =>
      p.episodes !== undefined ? `  ${id}: ${p.episodes.length} episode(s), published to ${p.where}` : `  ${id}: ${p.words} words, published to ${p.where}`,
    ),
    ...assumptions.map((a) => `  assumed: ${a.question}`),
  ].join("\n");
}

/** `pablo story` (AGT-1690): a review run asks the author on the terminal; an on-demand run asks nobody. */
async function runStoryCli(args: ParsedArgs, argv: readonly string[], cwd: string): Promise<number> {
  const { runStory, trackLine } = await import("./story");
  const review = args.values["review"] === true;
  const words = args.words === undefined ? undefined : Number(args.words);
  if (words !== undefined && (!Number.isInteger(words) || words <= 0)) {
    emit({ ok: false, code: EXIT_REFUSED, message: `pablo story: --words must be a positive integer (got "${args.words}")` }, args.json);
    return EXIT_REFUSED;
  }
  const interactive = review && process.stdin.isTTY === true;
  const result = await runStory(
    {
      prompt: args.rest.length === 0 ? undefined : args.rest.join(" "),
      output: repeatedFlag(argv, "output"),
      review,
      title: args.title,
      words,
      project: args.project,
      track: args.track,
    },
    { cwd, env: process.env, stderr: process.stderr },
    interactive ? { ask: stdinAskAuthor(lineReader(process.stdin), process.stderr) } : {},
  );
  const body = result.body as Record<string, unknown>;
  if (args.json) console.log(JSON.stringify(body));
  else if (body["ok"] === true) console.log(storyText(body, trackLine));
  else {
    console.error(String(body["message"]));
    for (const item of (body["missing"] ?? []) as string[]) console.error(`  ${item}`);
  }
  return result.exitCode;
}

/** Runs the CLI for `argv` (already stripped of `bun`/script name) and returns the process exit code. */
export async function main(argv: readonly string[], cwd: string = process.cwd()): Promise<number> {
  const args = parseCliArgs(argv);

  // `--version` / `-v` (AGT-1597) needs no vault, config or project.
  if (args.version) {
    console.log(args.json ? JSON.stringify({ version: VERSION }) : `pablo ${VERSION}`);
    return EXIT_OK;
  }

  // Bare `pablo` (no verb, no flags) inside a pablo project opens the screen
  // (AGT-1522). Anywhere else — no project, or no terminal to draw on — it
  // prints usage as it always did.
  if (args.verb === undefined && !args.help && argv.length === 0) {
    const screen = bareScreenTarget(cwd);
    if (screen !== undefined && process.stdin.isTTY && process.stdout.isTTY) {
      const { runScreen } = await import("@openthink/pablo-tui");
      // The book's stages come from the same stage machine `pablo status` reads (AGT-1526).
      // `dir` goes on too: the main pane reads the selected stage's file from it (AGT-1527).
      // Branches waiting for review and their diffs against main come from the branch layer (AGT-1538).
      const repo = repoRoot(screen.dir);
      const waiting = repo === undefined ? undefined : waitingBranches(repo);
      const vault = findVault(cwd);
      const marked = readMarker(screen.dir);
      const slug = marked.ok ? marked.marker.slug : undefined;
      return await runScreen({
        ...screen,
        stages: workBookStages(screen.dir, waiting?.ok ? waiting.branches : []),
        // A chapter opened there is scanned with `check`'s rules from the vault, each hit a box under its line (AGT-1528).
        ...(vault.ok ? { checks: screenChecks(vault.path) } : {}),
        // `a w` writes the selected chapter through the same `runWrite` the verb uses (AGT-1542).
        ...(vault.ok ? { writer: screenWriter(vault.path, screen.dir) } : {}),
        // `a r` revises the selected sentences; taking the candidate commits it on a revise/ branch (AGT-1544).
        ...(vault.ok ? { reviser: screenReviser(vault.path, screen.dir) } : {}),
        // `a v` adds the selected sentences to the project's voice: flagged, or kept as an exemplar (AGT-1547).
        ...(vault.ok ? { voicer: screenVoicer(vault.path, screen.dir) } : {}),
        // The compose view's session is built when the first message is sent (AGT-1566).
        composer: screenComposer(screen.dir, cwd),
        // `s` in a review merges the accepted changes and runs the after-write steps (AGT-1540).
        finisher: screenFinisher(screen.dir),
        // `c` in a review stores the author's own comment on the branch (AGT-1581).
        commentSaver: screenCommenter(screen.dir),
        // `v e` edits on an `edit/` branch in its own worktree; `v s` saves it through the finisher above (AGT-1545).
        editSession: screenEditor(screen.dir),
        // The rail reads the book again every few seconds, so a branch made outside the screen shows (AGT-1640); the
        // Reviews group polls GitHub for the work's reading rounds, and Enter pulls a review that is in (AGT-1641).
        refresh: screenRefresh(screen.dir),
        ...(slug !== undefined ? { rounds: screenRounds(screen.dir, slug), puller: screenPuller(screen.dir, slug) } : {}),
        ...(repo !== undefined && waiting?.ok ? { branches: waiting.branches, diffOf: (branch: string) => branchDiff(repo, branch), fileOf: (branch: string, path: string) => fileAt(repo, branch, path), commentsOf: (branch: string) => reviewCommentsOf(screen.dir, branch) } : {}),
      });
    }
  }

  if (args.help || args.verb === undefined) {
    console.log(helpText());
    return EXIT_OK;
  }

  if (!ALL_VERBS.includes(args.verb)) {
    const message = `pablo: unknown verb "${args.verb}" — run "pablo --help" for the list`;
    emit({ ok: false, code: EXIT_ERROR, message }, args.json);
    return EXIT_ERROR;
  }

  if (args.verb === "init") {
    return runInit(args, cwd);
  }

  if (args.verb === "mcp") {
    return await runMcp(cwd);
  }

  // `prose` (AGT-1241) has no `--project` at all — AC4 requires it to work
  // with no vault (a global voice, a brief anywhere), so it never enters the
  // shared `--project`/marker resolution below and is dispatched here,
  // before that block runs.
  if (args.verb === "prose") {
    return await runProse(
      {
        voice: args.voice,
        brief: args.brief,
        context: args.context,
        format: args.format,
        words: args.words,
        dryRun: args.dryRun,
        json: args.json,
        out: args.out,
        force: args.force,
        draft: args.draft,
        instruction: args.instruction,
      },
      { cwd, env: process.env },
    );
  }

  // `agent` (AGT-1552) resolves its own project and marker (`harness/agent.ts`),
  // the way an MCP verb does, so it is dispatched before the shared block too.
  if (args.verb === "agent") {
    return await runAgent(
      { project: args.project, message: args.rest.length === 0 ? undefined : args.rest.join(" "), json: args.json, tagFacts: args.tagFacts, new: args.new },
      { cwd, env: process.env, stdout: process.stdout, stderr: process.stderr, stdin: process.stdin },
    );
  }

  // `story` (AGT-1690) creates its work, or resumes one with --project: it resolves both itself.
  if (args.verb === "story") {
    return await runStoryCli(args, argv, cwd);
  }

  // The reader's `read` (AGT-1583) lists/fetches reading rounds from GitHub: no vault, no project.
  // `read <path> --project <slug>` (a file in a work) is the author's, below.
  if (args.verb === "read" && args.project === undefined && (args.list || parseRoundRef(args.rest[0] ?? "") !== undefined)) {
    return args.list || args.noOpen ? runReadRounds(args) : await runReadView(args);
  }

  // `doctor` (AGT-1678) reports the machine, not a work: no vault, no project.
  // It reads the casting side's state and never provisions or downloads.
  if (args.verb === "doctor") {
    const result = runDoctor({ env: process.env, stderr: process.stderr }, realCastingDeps(process.env), VERSION);
    // AGT-2146: the writing side (config, providers, vault git, search); a failed required check exits 1.
    const writing = await runWritingDoctor(realWritingDoctorDeps(process.env, cwd));
    const body = { ...(result.body as Record<string, unknown>), ok: writing.ok, writing };
    console.log(args.json ? JSON.stringify(body) : `${doctorText(result.body)}\n${writingDoctorText(writing)}`);
    return writing.ok ? result.exitCode : 1;
  }

  // The casting verbs (`audition` AGT-1678, `cast`/`voices` AGT-1679) run off
  // their one `VERBS` entry, exactly as `pablo mcp` does: the verb resolves the
  // vault (the library's default home) and the optional `--project` (receipts)
  // itself, and provisions the Python side lazily.
  if (CASTING_VERBS.has(args.verb)) {
    return await runCastingVerb(args, cwd);
  }

  let projectPath: string | undefined;
  if (args.project !== undefined) {
    const resolved = resolveProjectFromCwd(cwd, args.project);
    if (!resolved.ok) {
      emit(refusalResult(resolved), args.json);
      return resolved.code;
    }

    const markerRefusal = requireMarker(resolved.path);
    if (markerRefusal) {
      emit(refusalResult(markerRefusal), args.json);
      return markerRefusal.code;
    }
    projectPath = resolved.path;
  }

  // `config` (AGT-2130) edits and checks the model config: the global file, or --project's pablo.json.
  if (args.verb === "config") {
    const scope = { env: process.env, ...(projectPath === undefined ? {} : { projectDir: projectPath }) };
    const sub = args.rest[0];
    const result =
      sub === "show"
        ? configShow(scope)
        : sub === "set"
          ? configSet(scope, args.rest[1], args.rest[2])
          : sub === "test"
            ? await configTest(scope, realConfigTestDeps())
            : { exitCode: EXIT_REFUSED, body: { ok: false, message: "pablo config: expected show, set or test" }, text: "pablo config: expected show, set or test" };
    if (args.json) console.log(JSON.stringify(result.body));
    else if (result.exitCode === EXIT_REFUSED) console.error(result.text);
    else console.log(result.text);
    return result.exitCode;
  }

  // `review` (AGT-1693): the radio work's review player. Holds the process until the window closes.
  if (args.verb === "review") {
    return await runReviewView(args, projectPath);
  }

  // `mixer` (AGT-1768): one episode's mix document in the mixer view. Holds the process until the window closes.
  if (args.verb === "mixer") {
    return await runMixerView(args, projectPath, cwd);
  }

  // `takes` (AGT-1681): the radio output's take store. `gc` lists, then asks
  // on a terminal; without one (or with --json) it needs --yes.
  if (args.verb === "takes") {
    const interactive = !args.json && process.stdin.isTTY === true && process.stdout.isTTY === true;
    const whole = (raw: unknown): number | undefined => (typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : undefined);
    const text = (raw: unknown): string | undefined => (typeof raw === "string" ? resolve(cwd, raw) : undefined);
    const vaultFound = findVault(cwd, process.env);
    const where = args.rest[0] === "choose" ? { vault: text(args.values["vault"]) ?? (vaultFound.ok ? vaultFound.path : undefined), library: text(args.values["library"]) } : {};
    const result = await runTakes(
      { sub: args.rest[0], key: args.rest[1], yes: args.yes, episode: whole(args.values["episode"]), line: whole(args.values["line"]), ...where },
      { env: process.env, stderr: process.stderr },
      realCastingDeps(process.env),
      projectPath,
      interactive ? askYesNo : undefined,
    );
    const body = result.body as { ok?: boolean; message?: string; unreferenced?: unknown };
    if (args.json) console.log(JSON.stringify(result.body));
    else if (body.ok) console.log(args.rest[0] === "show" ? takeShowText(result.body) : args.rest[0] === "line" ? lineTakesText(result.body) : args.rest[0] === "choose" ? String(body.message ?? "") : takesGcText(result.body));
    else {
      if (body.unreferenced !== undefined) console.log(takesGcText(result.body));
      console.error(body.message ?? "pablo: takes failed");
    }
    return result.exitCode;
  }

  if (args.verb === "bind") {
    if (projectPath === undefined || args.role === undefined || args.voice === undefined) {
      const message = "pablo: bind requires --project <slug>, --role <NAME> and --voice <slug>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    const vaultResult = findVault(cwd);
    if (!vaultResult.ok) {
      emit(refusalResult(vaultResult), args.json);
      return vaultResult.code;
    }
    const result = radioBind({ env: process.env, stderr: process.stderr }, realCastingDeps(process.env), vaultResult.path, projectPath, {
      role: args.role,
      voice: args.voice,
    });
    const body = result.body as { ok?: boolean; message?: string; role?: string; slug?: string; cardHash?: string };
    if (args.json) console.log(JSON.stringify(result.body));
    else if (body.ok) console.log(`pablo: bound ${body.role} to ${body.slug}`);
    else console.error(body.message ?? "pablo: bind failed");
    return result.exitCode;
  }

  // `gate` (AGT-1682) scores a take against a cast card, or calibrates a card's
  // thresholds. Its flags are its own (`runGate` parses everything after the
  // verb strictly); `--project` is optional and only places the receipt.
  if (args.verb === "gate") {
    const result = runGate(argv.slice(argv.indexOf("gate") + 1), { env: process.env, stderr: process.stderr }, realCastingDeps(process.env), cwd, projectPath);
    if (args.json) console.log(JSON.stringify(result.body));
    else if ((result.body as { ok?: boolean }).ok) console.log(gateText(result.body));
    else console.error(gateText(result.body));
    return result.exitCode;
  }

  if (args.verb === "status") {
    if (projectPath === undefined) {
      const message = "pablo: status requires --project <slug>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    return runStatus(args, projectPath);
  }

  if (args.verb === "resume") {
    if (projectPath === undefined) {
      const message = "pablo: resume requires --project <slug>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    return await runResumeVerb(args.json, projectPath, args.project as string);
  }

  if (args.verb === "save") {
    if (projectPath === undefined) {
      const message = "pablo: save requires --project <slug>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    return runSave({ stage: args.stage, file: args.file, json: args.json }, projectPath);
  }

  if (args.verb === "write") {
    if (projectPath === undefined) {
      const message = "pablo: write requires --project <slug>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    const vaultResult = findVault(cwd);
    if (!vaultResult.ok) {
      emit(refusalResult(vaultResult), args.json);
      return vaultResult.code;
    }
    return await runWrite(args, vaultResult.path, projectPath);
  }

  if (args.verb === "check") {
    if (projectPath === undefined) {
      const message = "pablo: check requires --project <slug>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    // `check --across` (AGT-1671) runs off the check verb's `VERBS` entry, as `pablo mcp` does: it asks the critic.
    if (args.values["across"] === true) return await runVerbEntry("check", args, cwd, acrossText);
    const vaultResult = findVault(cwd);
    if (!vaultResult.ok) {
      emit(refusalResult(vaultResult), args.json);
      return vaultResult.code;
    }
    return runCheck(args, vaultResult.path, projectPath);
  }

  if (args.verb === "migrate") {
    const [sub] = args.rest;
    if (sub !== "lines" && sub !== "outputs" && sub !== "track" && sub !== "style") {
      const message = `pablo: migrate: unknown migration "${sub ?? ""}" (expected lines, outputs, track or style)`;
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    if (projectPath === undefined) {
      const message = `pablo: migrate ${sub} requires --project <slug>`;
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    const vaultResult = findVault(cwd);
    if (!vaultResult.ok) {
      emit(refusalResult(vaultResult), args.json);
      return vaultResult.code;
    }
    if (sub === "track") {
      const result = migrateTrack(vaultResult.path, projectPath, { track: args.track, dryRun: args.dryRun });
      if (!result.ok) {
        emit({ ok: false, code: result.code, message: result.message }, args.json);
        return result.code;
      }
      if (args.json) {
        console.log(JSON.stringify(result));
      } else {
        const verb = result.dryRun ? "would write" : result.changes.length === 0 ? "already on" : "wrote";
        console.log(`pablo: migrate track: ${verb} track ${result.track} (was ${result.from})${result.committed ? " (committed)" : ""}`);
        if (result.missingStages.length > 0) console.log(`  missing new core stages: ${result.missingStages.join(", ")}`);
        if (result.notice) console.log(result.notice);
      }
      return EXIT_OK;
    }
    if (sub === "style") {
      const result = migrateStyle(vaultResult.path, projectPath, { dryRun: args.dryRun });
      if (!result.ok) {
        emit({ ok: false, code: result.code, message: result.message }, args.json);
        return result.code;
      }
      if (args.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log(
          result.changes.length === 0
            ? "pablo: migrate style: nothing to migrate"
            : `pablo: migrate style: ${result.dryRun ? "would change" : "changed"} ${result.changes.length} path(s)${result.committed ? " (committed)" : ""}`,
        );
        for (const c of result.changes) console.log(`  ${c}`);
        if (result.notice) console.log(result.notice);
      }
      return EXIT_OK;
    }
    if (sub === "outputs") {
      const result = migrateOutputs(vaultResult.path, projectPath, { dryRun: args.dryRun });
      if (!result.ok) {
        emit({ ok: false, code: result.code, message: result.message }, args.json);
        return result.code;
      }
      if (args.json) {
        console.log(JSON.stringify(result));
      } else {
        const verb = result.dryRun ? "would change" : "changed";
        console.log(`pablo: migrate outputs: ${verb} ${result.changes.length} path(s)${result.committed ? " (committed)" : ""}`);
        for (const c of result.changes) console.log(c.op === "move" ? `  move    ${c.from} -> ${c.path}` : `  ${c.op.padEnd(7)} ${c.path}`);
        if (result.notice) console.log(result.notice);
      }
      return EXIT_OK;
    }
    const outcome = migrateLines(vaultResult.path, projectPath, { dryRun: args.dryRun });
    if (!outcome.ok) {
      emit({ ok: false, code: outcome.code, message: outcome.message }, args.json);
      return outcome.code;
    }
    if (args.json) {
      console.log(JSON.stringify(outcome));
    } else {
      const verb = outcome.dryRun ? "would change" : "changed";
      console.log(`pablo: migrate lines: ${verb} ${outcome.changed.length} chapter(s)${outcome.committed ? " (committed)" : ""}`);
      for (const f of outcome.changed) console.log(`  ${f}`);
      if (outcome.notice) console.log(outcome.notice);
    }
    return EXIT_OK;
  }

  if (args.verb === "merge") {
    const [branch] = args.rest;
    if (projectPath === undefined || branch === undefined) {
      const message = "pablo: usage: pablo merge --project <slug> <draft/chNN>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    const outcome = await mergeDraftInProject(projectPath, branch);
    if (args.json) {
      console.log(JSON.stringify(outcome.body));
    } else if (outcome.body["ok"] === true) {
      console.log(`pablo: merged ${branch} to main (${String(outcome.body["commit"]).slice(0, 7)})`);
      for (const r of outcome.body["rituals"] as { name: string; status: string; detail: string }[]) {
        console.log(`ritual ${r.name}: ${r.status} — ${r.detail}`);
      }
      for (const n of outcome.body["notices"] as string[]) console.log(n);
    } else {
      console.error(outcome.body["message"]);
    }
    return outcome.exitCode;
  }

  if (args.verb === "publish") {
    if (projectPath === undefined) {
      const message = "pablo: publish requires --project <slug>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    // `--output <type>` (AGT-1669): the addressed output's own publish targets.
    const result = publishOutput(projectPath, args.target, args.output);
    const body = result.body as {
      ok: boolean;
      message?: string;
      missing?: string[];
      output?: string;
      target?: string;
      where?: string;
      chapters?: number;
      words?: number;
      notes?: string[];
    };
    if (args.json) {
      console.log(JSON.stringify(body));
    } else if (body.ok) {
      const def = outputDefinition(body.output ?? "") ?? OUTPUTS.novel;
      console.log(`pablo: published ${body.target}: ${body.where} (${body.chapters} ${body.chapters === 1 ? def.noun : def.plural}, ${body.words} words)`);
      // The radio bundle (AGT-1686) names the episodes it holds no audio for yet.
      for (const note of body.notes ?? []) console.log(`  ${note}`);
    } else {
      console.error(body.message);
      for (const item of body.missing ?? []) console.error(`  ${item}`);
    }
    return result.exitCode;
  }

  if (args.verb === "share") {
    if (projectPath === undefined) {
      const message = "pablo: share requires --project <slug>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    if (args.list) {
      const outcome = await shareWith({ project: args.project as string, list: true }, { cwd, env: process.env, stderr: process.stderr }, realRunner);
      const body = outcome.body as { ok?: boolean; message?: string; rounds?: { id: string; chapters: number[]; status: string; closed?: boolean; prUrl: string }[]; notices?: string[] };
      if (args.json) console.log(JSON.stringify(body));
      else if (body.rounds === undefined) console.error(String(body.message));
      else {
        if (body.rounds.length === 0) console.log("pablo: no reading rounds for this project");
        for (const r of body.rounds) console.log(`${r.id}  chapters ${r.chapters.join(", ") || "-"}  ${r.status}${r.status === "pulled" && r.closed === false ? " (not closed yet)" : ""}  ${r.prUrl}`);
        for (const notice of body.notices ?? []) console.error(notice);
      }
      return outcome.exitCode;
    }
    if (!args.reader || !args.chapters) {
      const message = `pablo: share requires ${args.reader ? "--chapters <N|N-M>" : "--reader <name>"}`;
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    const outcome = await shareWith(
      { project: args.project as string, reader: args.reader, chapters: args.chapters, output: args.output },
      { cwd, env: process.env, stderr: process.stderr },
      realRunner,
    );
    const body = outcome.body as Record<string, unknown>;
    if (args.json) {
      console.log(JSON.stringify(body));
    } else if (body["ok"] === true) {
      console.log(`pablo: opened round ${String(body["id"])}: ${String(body["prUrl"])}`);
      for (const notice of body["notices"] as string[]) console.log(notice);
    } else {
      console.error(String(body["message"]));
    }
    return outcome.exitCode;
  }

  // `promote` (AGT-1671), a `check --across` finding's action, runs off its one `VERBS` entry.
  if (args.verb === "promote") {
    if (projectPath === undefined) {
      emit({ ok: false, code: EXIT_REFUSED, message: "pablo: promote requires --project <slug>" }, args.json);
      return EXIT_REFUSED;
    }
    return await runVerbEntry("promote", args, cwd, promoteText);
  }

  // `research save|distill|plan|waive|link` (AGT-2106, AGT-2109, AGT-2111) and `fact record` (AGT-2106) run off their `VERBS` entries, as `pablo mcp` does.
  if (args.verb === "research" || args.verb === "fact") {
    const subs = args.verb === "research" ? ["save", "distill", "plan", "waive", "link"] : ["record"];
    const sub = args.rest[0] ?? "";
    const usage = `pablo ${args.verb} ${subs.join("|")} --project <slug> ...`;
    if (projectPath === undefined || !subs.includes(sub)) {
      const message = !subs.includes(sub)
        ? subs.length === 1
          ? `pablo: ${args.verb}: the only action is "${subs[0]}" (${usage})`
          : `pablo: ${args.verb}: the actions are ${subs.slice(0, -1).map((s) => `"${s}"`).join(", ")} and "${subs[subs.length - 1]}" (${usage})`
        : `pablo: ${args.verb} ${sub} requires --project <slug>`;
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    return await runVerbEntry(args.verb, args, cwd, researchFactText);
  }

  // `output list|add|remove|plan` (AGT-1669) runs off its one `VERBS` entry, as `pablo mcp` does.
  if (args.verb === "output") {
    if (projectPath === undefined) {
      emit({ ok: false, code: EXIT_REFUSED, message: "pablo: output requires --project <slug>" }, args.json);
      return EXIT_REFUSED;
    }
    const verb = VERBS.find((v) => v.name === "output") as (typeof VERBS)[number];
    const built = verbArgsFromCli(verb, args.values, args.rest);
    if (!built.ok) {
      emit({ ok: false, code: EXIT_REFUSED, message: `${built.message} (pablo output list|add|remove|plan [<type>] --project <slug>)` }, args.json);
      return EXIT_REFUSED;
    }
    const result = await verb.run(built.args as never, { cwd, env: process.env, stderr: process.stderr });
    if (args.json) console.log(JSON.stringify(result.body));
    else if ((result.body as { ok?: boolean }).ok === true) console.log(outputVerbText(result.body));
    else console.error(outputVerbText(result.body));
    return result.exitCode;
  }

  if (args.verb === "notes") {
    if (args.rest[0] !== "pull" || projectPath === undefined) {
      const message = args.rest[0] !== "pull" ? 'pablo: notes: the only action is "pull" (pablo notes pull --project <slug>)' : "pablo: notes pull requires --project <slug>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    const outcome = await notesWith({ sub: "pull", project: args.project as string }, { cwd, env: process.env, stderr: process.stderr }, realRunner);
    const body = outcome.body as {
      ok?: boolean;
      message?: string;
      pulled?: { round: string; branch: string; commits: string[]; comments: number }[];
      skipped?: { reason: string; message: string }[];
      notices?: string[];
    };
    if (args.json) {
      console.log(JSON.stringify(body));
    } else if (body.pulled === undefined) {
      console.error(String(body.message));
    } else {
      for (const p of body.pulled) {
        console.log(`pablo: pulled round ${p.round} into ${p.branch} (${p.commits.length} suggestions, ${p.comments} comments)`);
      }
      for (const s of body.skipped ?? []) (s.reason === "error" || s.reason === "refused" ? console.error : console.log)(s.message);
      for (const n of body.notices ?? []) console.log(n);
      if (body.pulled.length === 0 && (body.skipped ?? []).length === 0) console.log("pablo: notes pull: no rounds for this work");
    }
    return outcome.exitCode;
  }

  if (args.verb === "voice") {
    return runVoice(args, cwd);
  }

  if (args.verb === "revise") {
    if (projectPath === undefined) {
      const message = "pablo: revise requires --project <slug>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    const vaultResult = findVault(cwd);
    if (!vaultResult.ok) {
      emit(refusalResult(vaultResult), args.json);
      return vaultResult.code;
    }
    const reviseCtx: ReviseCoreContext = { vaultRoot: vaultResult.path, projectPath, env: process.env };
    return await runRevise(
      {
        file: args.file,
        passage: args.passage,
        start: args.start,
        end: args.end,
        instruction: args.instruction,
        dryRun: args.dryRun,
        json: args.json,
      },
      reviseCtx,
    );
  }

  if (args.verb === "read" || args.verb === "search") {
    const argument = args.verb === "read" ? args.rest[0] : args.rest.join(" ");
    if (projectPath === undefined || !argument) {
      const message =
        projectPath === undefined
          ? `pablo: ${args.verb} requires --project <slug>`
          : args.verb === "read"
            ? "pablo: read requires a <path> in the work"
            : "pablo: search requires a <phrase>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    // The same pure functions the read/search verbs (and so `pablo mcp`) wrap;
    // `read <path>` and `search <phrase...>` only supply the positional.
    const result = args.verb === "read" ? readTool(projectPath, argument) : searchTool(projectPath, argument);
    if (args.json) console.log(JSON.stringify(result));
    else if (!result.ok) console.error(result.message);
    else if ("text" in result) console.log(result.text);
    else if ("entries" in result) console.log(result.entries.join("\n"));
    else {
      for (const match of result.matches) console.log(`${match.file}:${match.line}: ${match.sentence}`);
      if (result.truncated) console.log("(more matches; narrow the phrase)");
    }
    return result.ok ? EXIT_OK : result.code;
  }

  const message = `pablo: "${args.verb}" not implemented yet`;
  emit({ ok: false, code: EXIT_ERROR, message }, args.json);
  return EXIT_ERROR;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
