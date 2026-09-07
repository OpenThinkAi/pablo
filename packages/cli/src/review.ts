/**
 * The review queue: one global, append-only JSONL log recording that pablo
 * wrote a piece and is waiting for a decision. No manuscript text ever lands
 * here — id, kind, title, path, vault, project, word count, prompt hash.
 *
 * This module is pure: it depends on nothing but `node:fs`, `node:path` and
 * `node:crypto`, and never imports from `packages/core`. Wiring it to `write`,
 * `prose`, the CLI or MCP is a later ticket (AGT-1261, AGT-1262).
 *
 * Modeled on `packages/core/src/pack/receipt-log.ts`'s append-only JSONL
 * reader/writer shape, without importing it.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export type PieceKind = "chapter" | "prose";
export type DecidedBy = "cli" | "mcp" | "tray" | "editor";

export interface QueuedEvent {
  type: "queued";
  id: string;
  at: string;
  kind: PieceKind;
  title: string;
  path: string;
  vault?: string;
  project?: string;
  words: number;
  prompt_hash: string;
}

export interface DecisionEvent {
  type: "approved" | "rejected";
  id: string;
  at: string;
  by: DecidedBy;
  read: boolean;
  reason?: string;
}

export interface EditedEvent {
  type: "edited";
  id: string;
  at: string;
  words: number;
}

export type ReviewEvent = QueuedEvent | DecisionEvent | EditedEvent;

export type PieceRecord = Omit<QueuedEvent, "type">;

/** 4 lowercase hex characters, the default `random` for `mintPieceId`. */
function defaultRandom(): string {
  return randomBytes(2).toString("hex");
}

/**
 * `<YYYYMMDD>-<slug>-<4 lowercase hex>`. `slug` is lowercased, every run of
 * non-alphanumeric characters collapsed to a single hyphen, trimmed of
 * leading/trailing hyphens, then cut to 24 characters.
 */
export function mintPieceId(now: Date, slug: string, random: () => string = defaultRandom): string {
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const date = `${year}${month}${day}`;

  const cleanSlug = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);

  return `${date}-${cleanSlug}-${random()}`;
}

/**
 * Appends one event as a single JSON line, creating the parent directory and
 * the file itself when missing.
 */
export function appendEvent(path: string, event: ReviewEvent): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
}

function isReviewEvent(value: unknown): value is ReviewEvent {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "queued" || type === "approved" || type === "rejected" || type === "edited";
}

/**
 * Every well-formed line, in order. A missing file reads as no events; a
 * malformed line (bad JSON, or JSON that isn't a recognizable event) is
 * skipped rather than thrown.
 */
export function readEvents(path: string): ReviewEvent[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  const events: ReviewEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isReviewEvent(parsed)) events.push(parsed);
    } catch {
      // malformed line: skip it
    }
  }
  return events;
}

function decisionFor(events: ReviewEvent[], id: string): DecisionEvent | undefined {
  return events.find(
    (event): event is DecisionEvent => (event.type === "approved" || event.type === "rejected") && event.id === id,
  );
}

/** Queued pieces with no `approved` or `rejected` event for their id, newest `at` first. */
export function pending(events: ReviewEvent[]): PieceRecord[] {
  const decidedIds = new Set<string>();
  for (const event of events) {
    if (event.type === "approved" || event.type === "rejected") decidedIds.add(event.id);
  }

  const queued = events.filter(
    (event): event is QueuedEvent => event.type === "queued" && !decidedIds.has(event.id),
  );

  return queued
    .slice()
    .sort((a, b) => b.at.localeCompare(a.at))
    .map(({ type: _type, ...piece }) => piece);
}

/** One piece's full history, or `undefined` when it was never queued. */
export function record(
  events: ReviewEvent[],
  id: string,
): { piece: PieceRecord; decision?: DecisionEvent; edits: EditedEvent[] } | undefined {
  const queuedEvent = events.find((event): event is QueuedEvent => event.type === "queued" && event.id === id);
  if (queuedEvent === undefined) return undefined;

  const { type: _type, ...piece } = queuedEvent;
  const decision = decisionFor(events, id);
  const edits = events.filter((event): event is EditedEvent => event.type === "edited" && event.id === id);

  return decision === undefined ? { piece, edits } : { piece, decision, edits };
}

export interface DecideInput {
  id: string;
  kind: "approved" | "rejected";
  by: DecidedBy;
  read: boolean;
  reason?: string;
  now?: Date;
}

export type DecideResult =
  | { ok: true; event: DecisionEvent }
  | { ok: false; code: "unknown-piece" | "already-decided"; detail: string };

/**
 * Appends a decision only when the piece exists and has no decision yet; the
 * file is otherwise untouched.
 */
export function decide(path: string, input: DecideInput): DecideResult {
  const events = readEvents(path);
  const found = record(events, input.id);

  if (found === undefined) {
    return { ok: false, code: "unknown-piece", detail: `no queued piece with id "${input.id}"` };
  }
  if (found.decision !== undefined) {
    return {
      ok: false,
      code: "already-decided",
      detail: `piece "${input.id}" was already ${found.decision.type}`,
    };
  }

  const now = input.now ?? new Date();
  const event: DecisionEvent = {
    type: input.kind,
    id: input.id,
    at: now.toISOString(),
    by: input.by,
    read: input.read,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  };

  appendEvent(path, event);
  return { ok: true, event };
}

export interface WaitForDecisionOptions {
  timeoutMs: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WaitForDecisionResult {
  status: "approved" | "rejected" | "timeout" | "unknown-piece";
  event?: DecisionEvent;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `readEvents` every `pollMs` (default 500) until a decision exists or
 * `timeoutMs` passes. `sleep` is injectable so tests run instantly.
 */
export async function waitForDecision(
  path: string,
  id: string,
  opts: WaitForDecisionOptions,
): Promise<WaitForDecisionResult> {
  const pollMs = opts.pollMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;
  const start = Date.now();

  for (;;) {
    const events = readEvents(path);
    const found = record(events, id);

    if (found === undefined) return { status: "unknown-piece" };
    if (found.decision !== undefined) return { status: found.decision.type, event: found.decision };
    if (Date.now() - start >= opts.timeoutMs) return { status: "timeout" };

    await sleep(pollMs);
  }
}
