/**
 * The reader's side of a reading round, part 1 (AGT-1583): find the rounds
 * waiting for this person on GitHub and fetch a round's chapters into a local
 * cache. Design: `pm project show ai-terminal --doc readers` ("What the reader
 * does"). It works on a reader's Mac, which has no vault and no pablo project:
 * nothing here reads `<vault>/.pablo/rounds/` (that is Matt's side, `share.ts`).
 *
 * Every `gh` call is an argument array handed to the injected `Runner` from
 * `share.ts`; tests pass a fake, nothing here shells out any other way.
 *
 * The cache, per round: `$XDG_STATE_HOME/pablo/rounds/<org>/<repo>/<pr>/`
 *  - `round.json`   — `CachedRound`: the PR head commit the chapters were read at;
 *  - `<chapter path>` — each chapter file at that commit, under the path it has
 *    in the reading repo (and the vault);
 *  - `sent.json`    — written by Submit (AGT-1585) through `markRoundSent`; its
 *    presence is what `listReaderRounds` reports as `sent`.
 * Later tickets (the reader view, Submit, the tray) read it with `readCachedRound`
 * / `cachedRoundDir` and list rounds with `listReaderRounds`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { stateDir } from "./paths";
import { CHAPTER_PATH, READING_ORG } from "./share";
import type { Runner, RunResult } from "./share";

type Env = Record<string, string | undefined>;

/** `OpenThinkAi/<slug>-reading`: the only repos a reader's pablo lists or fetches from. */
const READING_REPO = new RegExp(`^${READING_ORG}/[a-z0-9]+(?:-[a-z0-9]+)*-reading$`);

export interface RoundRef {
  /** `OpenThinkAi/<slug>-reading`. */
  readonly repo: string;
  readonly pr: number;
}

/** `OpenThinkAi/<slug>-reading#<pr>` — the form `pablo read --list` prints. */
export function roundRefLabel(ref: RoundRef): string {
  return `${ref.repo}#${ref.pr}`;
}

/**
 * `<slug>-reading#<pr>` or `OpenThinkAi/<slug>-reading#<pr>` (also `/` before the number);
 * undefined for anything else, including another org's repo.
 */
export function parseRoundRef(text: string): RoundRef | undefined {
  const match = /^(?:([A-Za-z0-9-]+)\/)?([a-z0-9]+(?:-[a-z0-9]+)*-reading)[#/](\d{1,9})$/.exec(text.trim());
  if (!match) return undefined;
  if (match[1] !== undefined && match[1] !== READING_ORG) return undefined;
  return { repo: `${READING_ORG}/${match[2]}`, pr: Number(match[3]) };
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

/** `$XDG_STATE_HOME/pablo/rounds` (default `~/.local/state/pablo/rounds`). */
export function roundCacheRoot(env: Env = process.env): string {
  return join(stateDir(env), "rounds");
}

/** `<cache root>/<org>/<repo>/<pr>`; throws on a ref that is not a reading-repo round. */
export function cachedRoundDir(ref: RoundRef, env: Env = process.env): string {
  if (!READING_REPO.test(ref.repo) || !Number.isInteger(ref.pr) || ref.pr < 1) throw new Error(`not a round: ${ref.repo}#${ref.pr}`);
  return join(roundCacheRoot(env), ref.repo, String(ref.pr));
}

export interface CachedChapter {
  readonly number: number;
  /** The chapter's path in the reading repo; the cached file is `<dir>/<path>`. */
  readonly path: string;
}

/** `<dir>/round.json`: what was fetched and the commit it was pinned to. */
export interface CachedRound {
  readonly repo: string;
  readonly pr: number;
  readonly title: string;
  readonly prUrl: string;
  /** The PR's head commit the chapters were read at. A review is submitted against this commit. */
  readonly commit: string;
  readonly sender: string;
  readonly chapters: readonly CachedChapter[];
  /** ISO timestamp of the fetch. */
  readonly fetchedAt: string;
}

/** `<dir>/sent.json`, written when this machine submits its review (AGT-1585). */
export interface SentRecord {
  /** ISO timestamp. */
  readonly sentAt: string;
}

export function readCachedRound(ref: RoundRef, env: Env = process.env): CachedRound | undefined {
  try {
    return JSON.parse(readFileSync(join(cachedRoundDir(ref, env), "round.json"), "utf8")) as CachedRound;
  } catch {
    return undefined;
  }
}

/** Records that this machine has submitted its review of the round; the list then shows it as `sent`. */
export function markRoundSent(ref: RoundRef, env: Env = process.env, now: () => Date = () => new Date()): void {
  const dir = cachedRoundDir(ref, env);
  mkdirSync(dir, { recursive: true });
  const record: SentRecord = { sentAt: now().toISOString() };
  writeFileSync(join(dir, "sent.json"), `${JSON.stringify(record)}\n`, "utf8");
}

/** Whether `markRoundSent` has been called for the round on this machine. */
export function isRoundSent(ref: RoundRef, env: Env = process.env): boolean {
  return existsSync(join(cachedRoundDir(ref, env), "sent.json"));
}

// ---------------------------------------------------------------------------
// gh helpers
// ---------------------------------------------------------------------------

function describe(result: RunResult): string {
  return (result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`).split("\n").slice(0, 3).join(" / ");
}

/** `gh api -X GET <endpoint> -f k=v …`, JSON-parsed. */
function ghJson(run: Runner, endpoint: string, fields: readonly [string, string][] = []): { ok: true; value: unknown } | { ok: false; reason: string } {
  const result = run("gh", ["api", "-X", "GET", endpoint, ...fields.flatMap(([k, v]) => ["-f", `${k}=${v}`])]);
  if (result.code !== 0) return { ok: false, reason: describe(result) };
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, reason: "gh's answer was not JSON" };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function chapterNumber(path: string): number {
  const match = /^(\d+)-/.exec(basename(path));
  return match ? Number(match[1]) : 0;
}

/** The chapter files a PR adds, in the order GitHub lists them. Anything else in the PR is ignored. */
function prChapters(run: Runner, repo: string, pr: number): { ok: true; chapters: CachedChapter[] } | { ok: false; reason: string } {
  const files = ghJson(run, `repos/${repo}/pulls/${pr}/files`, [["per_page", "100"]]);
  if (!files.ok) return files;
  if (!Array.isArray(files.value)) return { ok: false, reason: "gh's file list was not an array" };
  const chapters: CachedChapter[] = [];
  for (const entry of files.value) {
    const path = str(asRecord(entry)?.["filename"]);
    if (path !== undefined && CHAPTER_PATH.test(path)) chapters.push({ number: chapterNumber(path), path });
  }
  return { ok: true, chapters };
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface ReaderRound {
  readonly repo: string;
  readonly pr: number;
  /** `OpenThinkAi/<slug>-reading#<pr>`, what `pablo read <round>` takes. */
  readonly ref: string;
  readonly title: string;
  readonly url: string;
  /** Who opened the PR (the author's GitHub login). */
  readonly sender: string;
  /** ISO date the round was opened. */
  readonly date: string;
  readonly chapters: readonly CachedChapter[];
  /** `waiting`: the reader has not submitted from this machine. `sent`: they have. */
  readonly status: "waiting" | "sent";
}

export type ListOutcome =
  | { readonly ok: true; readonly rounds: readonly ReaderRound[]; readonly notices: readonly string[] }
  | { readonly ok: false; readonly code: 1; readonly message: string };

export interface ListOptions {
  readonly run: Runner;
  readonly env?: Env;
  /** Default: `OpenThinkAi`. */
  readonly org?: string;
}

/**
 * The reader's rounds: open PRs in `<org>/*-reading` repos with the signed-in `gh` user as requested
 * reviewer, plus rounds this machine has submitted (`sent`) whose PR is still open. Waiting rounds
 * first, newest first within each group. The one function the list verb, the reader view and the
 * tray share. A PR whose chapter list cannot be read is still listed (with no chapters) and noticed.
 */
export function listReaderRounds(options: ListOptions): ListOutcome {
  const { run } = options;
  const env = options.env ?? process.env;
  const org = options.org ?? READING_ORG;
  const notices: string[] = [];

  const search = ghJson(run, "search/issues", [
    ["q", `is:pr is:open review-requested:@me org:${org}`],
    ["per_page", "100"],
  ]);
  if (!search.ok) return { ok: false, code: 1, message: `pablo: read: cannot ask GitHub for your rounds (${search.reason})` };
  const items = asRecord(search.value)?.["items"];
  if (!Array.isArray(items)) return { ok: false, code: 1, message: "pablo: read: GitHub's search answer had no items" };

  const rounds = new Map<string, ReaderRound>();
  for (const item of items) {
    const entry = asRecord(item);
    const number = entry?.["number"];
    const repoUrl = str(entry?.["repository_url"]);
    const repo = repoUrl?.replace(/^https:\/\/api\.github\.com\/repos\//, "");
    if (entry === undefined || typeof number !== "number" || repo === undefined || !READING_REPO.test(repo)) continue;
    const chapters = prChapters(run, repo, number);
    if (!chapters.ok) notices.push(`pablo: read: cannot list the chapters of ${repo}#${number} (${chapters.reason})`);
    rounds.set(`${repo}#${number}`, {
      repo,
      pr: number,
      ref: `${repo}#${number}`,
      title: str(entry["title"]) ?? `${repo}#${number}`,
      url: str(entry["html_url"]) ?? `https://github.com/${repo}/pull/${number}`,
      sender: str(asRecord(entry["user"])?.["login"]) ?? "",
      date: str(entry["created_at"]) ?? "",
      chapters: chapters.ok ? chapters.chapters : [],
      status: "waiting",
    });
  }

  // Rounds this machine already submitted: GitHub drops the review request on submit, so the search no longer finds them.
  for (const ref of sentRounds(env)) {
    const key = roundRefLabel(ref);
    const known = rounds.get(key);
    if (known !== undefined) {
      rounds.set(key, { ...known, status: "sent" });
      continue;
    }
    const pr = ghJson(run, `repos/${ref.repo}/pulls/${ref.pr}`);
    const record = pr.ok ? asRecord(pr.value) : undefined;
    if (record !== undefined && record["state"] !== "open") continue; // closed: the round is over
    const cached = readCachedRound(ref, env);
    if (record === undefined) notices.push(`pablo: read: cannot check ${key} (${pr.ok ? "unexpected answer" : pr.reason})`);
    rounds.set(key, {
      repo: ref.repo,
      pr: ref.pr,
      ref: key,
      title: str(record?.["title"]) ?? cached?.title ?? key,
      url: str(record?.["html_url"]) ?? cached?.prUrl ?? `https://github.com/${ref.repo}/pull/${ref.pr}`,
      sender: str(asRecord(record?.["user"])?.["login"]) ?? cached?.sender ?? "",
      date: str(record?.["created_at"]) ?? "",
      chapters: cached?.chapters ?? [],
      status: "sent",
    });
  }

  const order = (r: ReaderRound): number => (r.status === "waiting" ? 0 : 1);
  const sorted = [...rounds.values()].sort((a, b) => order(a) - order(b) || b.date.localeCompare(a.date));
  return { ok: true, rounds: sorted, notices };
}

/** Every cached round that has a `sent.json`. Directory names that are not refs are ignored. */
function sentRounds(env: Env): RoundRef[] {
  const found: RoundRef[] = [];
  const root = join(roundCacheRoot(env), READING_ORG);
  if (!existsSync(root)) return found;
  for (const repoName of readdirSync(root)) {
    const repo = `${READING_ORG}/${repoName}`;
    if (!READING_REPO.test(repo)) continue;
    for (const prName of readdirSync(join(root, repoName))) {
      if (!/^\d{1,9}$/.test(prName)) continue;
      const ref = { repo, pr: Number(prName) };
      if (ref.pr >= 1 && isRoundSent(ref, env)) found.push(ref);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

export type FetchOutcome =
  | { readonly ok: true; readonly round: CachedRound; readonly dir: string; readonly reused: boolean }
  | { readonly ok: false; readonly code: 1 | 2; readonly message: string };

export interface FetchOptions {
  readonly run: Runner;
  readonly env?: Env;
  readonly ref: RoundRef;
  readonly now?: () => Date;
}

/**
 * Fetches a round's chapter files at the PR's head commit into the cache and records that commit
 * (`round.json`). The PR must be open, in a `<org>/*-reading` repo, with its head in that same repo
 * (never a fork), and only paths that pass the chapter-path pattern are written. If the cache already
 * holds the same head commit, nothing is fetched again. Everything is read before anything is written,
 * so a failure leaves the previous cache intact.
 */
export function fetchRound(options: FetchOptions): FetchOutcome {
  const { run, ref } = options;
  const env = options.env ?? process.env;
  if (!READING_REPO.test(ref.repo) || !Number.isInteger(ref.pr) || ref.pr < 1) {
    return { ok: false, code: 2, message: `pablo: read: ${ref.repo}#${ref.pr} is not a reading-repo round` };
  }

  const pull = ghJson(run, `repos/${ref.repo}/pulls/${ref.pr}`);
  if (!pull.ok) return { ok: false, code: 1, message: `pablo: read: cannot read ${roundRefLabel(ref)} (${pull.reason})` };
  const record = asRecord(pull.value);
  const head = asRecord(record?.["head"]);
  const commit = str(head?.["sha"]);
  if (record === undefined || commit === undefined || !/^[0-9a-f]{40}$/.test(commit)) {
    return { ok: false, code: 1, message: `pablo: read: GitHub's answer for ${roundRefLabel(ref)} had no head commit` };
  }
  if (record["state"] !== "open") return { ok: false, code: 2, message: `pablo: read: ${roundRefLabel(ref)} is not open` };
  if (str(asRecord(head?.["repo"])?.["full_name"]) !== ref.repo) {
    return { ok: false, code: 2, message: `pablo: read: ${roundRefLabel(ref)} does not come from the reading repo itself; refusing it` };
  }

  const dir = cachedRoundDir(ref, env);
  const cached = readCachedRound(ref, env);
  if (cached !== undefined && cached.commit === commit && cached.chapters.every((c) => existsSync(join(dir, c.path)))) {
    return { ok: true, round: cached, dir, reused: true };
  }

  const listed = prChapters(run, ref.repo, ref.pr);
  if (!listed.ok) return { ok: false, code: 1, message: `pablo: read: cannot list the chapters of ${roundRefLabel(ref)} (${listed.reason})` };
  if (listed.chapters.length === 0) return { ok: false, code: 2, message: `pablo: read: ${roundRefLabel(ref)} carries no chapter files` };

  const texts: { path: string; text: string }[] = [];
  for (const chapter of listed.chapters) {
    const encoded = chapter.path.split("/").map(encodeURIComponent).join("/");
    const raw = run("gh", ["api", "-X", "GET", `repos/${ref.repo}/contents/${encoded}`, "-H", "Accept: application/vnd.github.raw+json", "-f", `ref=${commit}`]);
    if (raw.code !== 0) return { ok: false, code: 1, message: `pablo: read: cannot fetch ${chapter.path} at ${commit.slice(0, 7)} (${describe(raw)})` };
    texts.push({ path: chapter.path, text: raw.stdout });
  }

  const round: CachedRound = {
    repo: ref.repo,
    pr: ref.pr,
    title: str(record["title"]) ?? roundRefLabel(ref),
    prUrl: str(record["html_url"]) ?? `https://github.com/${ref.repo}/pull/${ref.pr}`,
    commit,
    sender: str(asRecord(record["user"])?.["login"]) ?? "",
    chapters: listed.chapters,
    fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
  };

  // Replace the previous commit's chapters wholesale (keep only sent.json), then write the new ones.
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) if (name !== "sent.json") rmSync(join(dir, name), { recursive: true, force: true });
  for (const { path, text } of texts) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
  }
  const tmp = join(dir, "round.json.tmp");
  writeFileSync(tmp, `${JSON.stringify(round, null, 2)}\n`, "utf8");
  renameSync(tmp, join(dir, "round.json")); // last: a round.json means the chapters are all there
  return { ok: true, round, dir, reused: false };
}
