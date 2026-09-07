/**
 * `pablo review list|show|approve|reject|wait` (AGT-1261) — the CLI-facing
 * shape over `packages/cli/src/review.ts`'s pure queue module (AGT-1255),
 * mirroring `saveCore`/`runSave` (`save.ts`) and `proseCore`/`runProse`
 * (`prose.ts`): `reviewCore` returns `{body, exitCode}` and never prints or
 * throws; `runReview` is the CLI wrapper that does the printing (prose or
 * `--json`). `verbs.ts`'s `review` verb calls `reviewCore` directly for the
 * MCP path, exactly the way `runSaveVerb` calls `saveCore`.
 *
 * The review queue is global, not project-scoped (`~/saltline-digital-vault/
 * projects/ai-terminal/review-tray.md`: "one file, not one per vault"), so
 * this file never resolves a vault or a project — its only input beyond the
 * action/id/flags is the queue path (`paths.ts`'s `stateReviewPath`).
 */

import type { DecidedBy, DecisionEvent, EditedEvent, PieceRecord, QueuedEvent, ReviewEvent } from "./review";
import { decide, pending, readEvents, record, waitForDecision } from "./review";
import { stateReviewPath } from "./paths";

export const REVIEW_EXIT_OK = 0;
export const REVIEW_EXIT_ERROR = 1;
export const REVIEW_EXIT_REFUSED = 2;

export const REVIEW_ACTIONS = ["list", "show", "approve", "reject", "wait"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

/** A piece record, with its decision attached when it has one — `list --all`'s per-item shape. */
export type ReviewRecordWithDecision = PieceRecord & { readonly decision?: DecisionEvent };

/** `{ok:false, code, message}` — the same refusal shape every other verb's `--json` prints (AGT-1235's convention), minus `tried` (review never resolves a project/vault path). */
export interface ReviewRefusalBody {
  readonly ok: false;
  readonly code: number;
  readonly message: string;
}

export interface ReviewShowBody {
  readonly piece: PieceRecord;
  readonly decision?: DecisionEvent;
  readonly edits: readonly EditedEvent[];
}

export interface ReviewWaitBody {
  readonly id: string;
  readonly status: "approved" | "rejected" | "timeout" | "unknown-piece";
  readonly event?: DecisionEvent;
}

export type ReviewBody =
  | ReviewRefusalBody
  | readonly ReviewRecordWithDecision[]
  | ReviewShowBody
  | DecisionEvent
  | ReviewWaitBody;

export interface ReviewOutcome {
  readonly body: ReviewBody;
  readonly exitCode: number;
}

/** The fields `reviewCore` needs, independent of the action — every field but `action` is optional because each action only reads the ones it needs (mirrors `VOICE_ARGS`'s shared shape). */
export interface ReviewCoreOptions {
  readonly action: ReviewAction;
  readonly id?: string;
  /** `list`: include decided pieces, with their decision. */
  readonly all?: boolean;
  /** `approve`/`reject`: record the decision as unread (`read: false`). */
  readonly unread?: boolean;
  /** `reject`: why, recorded on the decision. */
  readonly reason?: string;
  /** `wait`: seconds to wait before timing out. `reviewCore` defaults this to 3600 when omitted — the CLI/MCP default lives here, once, rather than in every caller. */
  readonly timeoutSeconds?: number;
}

export interface ReviewCoreDeps {
  readonly path: string;
  readonly by: DecidedBy;
  /** Injectable for tests — passed straight through to `decide`. */
  readonly now?: Date;
  /** Injectable for tests — passed straight through to `waitForDecision` so a `wait` test never spins on a real clock. */
  readonly sleep?: (ms: number) => Promise<void>;
}

function refusal(code: number, message: string): ReviewOutcome {
  return { body: { ok: false, code, message }, exitCode: code };
}

/** Every queued piece, newest `at` first, with its decision attached when it has one — `list --all`'s shape (AC1). Pending-only listing is `review.ts`'s own `pending`, reused as-is. */
export function allRecords(events: readonly ReviewEvent[]): ReviewRecordWithDecision[] {
  const queued = events.filter((event): event is QueuedEvent => event.type === "queued");

  return queued
    .slice()
    .sort((a, b) => b.at.localeCompare(a.at))
    .map(({ type: _type, ...piece }) => {
      const decision = events.find(
        (event): event is DecisionEvent => (event.type === "approved" || event.type === "rejected") && event.id === piece.id,
      );
      return decision ? { ...piece, decision } : piece;
    });
}

/**
 * The pure core of every `review` subcommand: reads/writes `deps.path`
 * (`review.ts`'s append-only JSONL), returns the exact `--json`/MCP body, and
 * never prints or throws (AC1-4). `deps.by` is `"cli"` from `runReview`,
 * `"mcp"` from `verbs.ts`'s `review` verb (AC3's parenthetical).
 */
export async function reviewCore(options: ReviewCoreOptions, deps: ReviewCoreDeps): Promise<ReviewOutcome> {
  const { path } = deps;

  if (options.action === "list") {
    const events = readEvents(path);
    const records = options.all ? allRecords(events) : pending(events);
    return { body: records, exitCode: REVIEW_EXIT_OK };
  }

  if (options.id === undefined) {
    return refusal(REVIEW_EXIT_REFUSED, `pablo: review ${options.action} requires id`);
  }
  const id = options.id;

  if (options.action === "show") {
    const events = readEvents(path);
    const found = record(events, id);
    if (found === undefined) {
      return refusal(REVIEW_EXIT_REFUSED, `unknown piece ${id}`);
    }
    return { body: found, exitCode: REVIEW_EXIT_OK };
  }

  if (options.action === "approve" || options.action === "reject") {
    // AC3: both approve and reject call `decide` with `read: !unread` — reject
    // has no `--unread` flag of its own, so `unread` is simply undefined there
    // and `read` comes out `true`, exactly as if it had never been asked.
    const result = decide(path, {
      id,
      kind: options.action === "approve" ? "approved" : "rejected",
      by: deps.by,
      read: !options.unread,
      reason: options.action === "reject" ? options.reason : undefined,
      now: deps.now,
    });

    if (!result.ok) {
      return refusal(REVIEW_EXIT_REFUSED, result.detail);
    }
    return { body: result.event, exitCode: REVIEW_EXIT_OK };
  }

  // action === "wait"
  const timeoutMs = (options.timeoutSeconds ?? 3600) * 1000;
  const waited = await waitForDecision(path, id, { timeoutMs, sleep: deps.sleep });

  const exitCode =
    waited.status === "approved"
      ? REVIEW_EXIT_OK
      : waited.status === "timeout"
        ? REVIEW_EXIT_ERROR
        : REVIEW_EXIT_REFUSED; // "rejected" or "unknown-piece"

  return {
    body: { id, status: waited.status, ...(waited.event !== undefined ? { event: waited.event } : {}) },
    exitCode,
  };
}

function isRefusal(body: ReviewBody): body is ReviewRefusalBody {
  return typeof body === "object" && body !== null && !Array.isArray(body) && (body as { ok?: unknown }).ok === false;
}

/** `list`'s one-line-per-piece prose format: `<id>  <kind>  <words>w  <title>  <path>`, with `  [<decision>]` appended for a decided piece (`--all` only — `pending()` never returns one). */
function formatRecordLine(piece: ReviewRecordWithDecision): string {
  const base = `${piece.id}  ${piece.kind}  ${piece.words}w  ${piece.title}  ${piece.path}`;
  return piece.decision ? `${base}  [${piece.decision.type}]` : base;
}

function printShow(found: ReviewShowBody): void {
  const { piece, decision, edits } = found;
  console.log(`${piece.id}  ${piece.kind}  ${piece.words}w  ${piece.title}  ${piece.path}`);
  console.log(`queued ${piece.at}`);
  if (decision) {
    const read = decision.read ? "" : " (unread)";
    const reason = decision.reason !== undefined ? ` — ${decision.reason}` : "";
    console.log(`${decision.type} ${decision.at} by ${decision.by}${read}${reason}`);
  } else {
    console.log("pending");
  }
  if (edits.length === 0) {
    console.log("no edits");
  } else {
    for (const edit of edits) console.log(`edited ${edit.at}: ${edit.words}w`);
  }
}

/** `runReview`'s options: `reviewCore`'s own plus the CLI-only `json` flag — mirrors `SaveOptions`/`runSave`'s split (`{json, ...core}`). `action`/`id` arrive as plain strings here (CLI positionals, unvalidated) rather than `ReviewCoreOptions`'s typed `ReviewAction` — validated below before `reviewCore` ever sees them. */
export interface RunReviewOptions {
  readonly action: string | undefined;
  readonly id: string | undefined;
  readonly all: boolean;
  readonly unread: boolean;
  readonly reason: string | undefined;
  readonly timeoutSeconds: number | undefined;
  readonly json: boolean;
}

function isReviewAction(value: string | undefined): value is ReviewAction {
  return value !== undefined && (REVIEW_ACTIONS as readonly string[]).includes(value);
}

/**
 * `pablo review <action> [<id>] [flags]`. Prints prose or (`--json`) the
 * exact body `reviewCore` returned, and returns the exit code. `by: "cli"`
 * (AC3) — `verbs.ts`'s MCP path calls `reviewCore` directly with `by: "mcp"`
 * instead of going through this function at all.
 */
export async function runReview(options: RunReviewOptions, env: Record<string, string | undefined>): Promise<number> {
  if (!isReviewAction(options.action)) {
    console.error(
      `pablo: review: unknown action "${options.action ?? ""}" (expected list, show, approve, reject, or wait)`,
    );
    return REVIEW_EXIT_ERROR;
  }

  const path = stateReviewPath(env);
  const { body, exitCode } = await reviewCore(
    {
      action: options.action,
      id: options.id,
      all: options.all,
      unread: options.unread,
      reason: options.reason,
      timeoutSeconds: options.timeoutSeconds,
    },
    { path, by: "cli" },
  );

  if (options.json) {
    console.log(JSON.stringify(body));
    return exitCode;
  }

  if (options.action === "list") {
    const records = body as readonly ReviewRecordWithDecision[];
    if (records.length === 0) {
      console.log("nothing waiting");
    } else {
      for (const piece of records) console.log(formatRecordLine(piece));
    }
    return exitCode;
  }

  if (options.action === "show") {
    if (isRefusal(body)) {
      console.error(body.message);
      return exitCode;
    }
    printShow(body as ReviewShowBody);
    return exitCode;
  }

  if (options.action === "approve" || options.action === "reject") {
    if (isRefusal(body)) {
      console.error(body.message);
      return exitCode;
    }
    console.log(`${options.action === "approve" ? "approved" : "rejected"} ${options.id}`);
    return exitCode;
  }

  // action === "wait"
  if (isRefusal(body)) {
    // Only reachable when `id` was omitted entirely (checked before reviewCore
    // ever runs a poll) — every other `wait` outcome is a `ReviewWaitBody`.
    console.error(body.message);
    return exitCode;
  }
  const waited = body as ReviewWaitBody;
  if (waited.status === "approved") {
    console.log(`approved ${waited.id}`);
  } else if (waited.status === "rejected") {
    console.log(`rejected ${waited.id}`);
  } else if (waited.status === "timeout") {
    console.error(`timeout waiting for ${waited.id}`);
  } else {
    console.error(`unknown piece ${waited.id}`);
  }
  return exitCode;
}
