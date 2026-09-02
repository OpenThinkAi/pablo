/**
 * The dry run: what is about to be sent, how big it is, and how long it will
 * take. A first-class view, not a debug flag.
 *
 * The rates come in as a parameter rather than from the provider registry: the
 * pack module knows nothing about which endpoint it is destined for, and the
 * shape here is satisfied by `EndpointRates` from `providers/rates.ts`.
 */

import type { Pack, PackKind, SliceAdjustment } from "./types";

/** What an endpoint has been measured doing. `EndpointRates` satisfies this. */
export interface PackRates {
  readonly promptTokensPerSecond: number | undefined;
  readonly outputTokensPerSecond: number | undefined;
}

export interface WaitEstimate {
  readonly prefillMs: number;
  readonly generateMs: number;
  readonly totalMs: number;
}

export interface PackPreview {
  /** The exact bytes that will be sent. */
  readonly prompt: string;
  /** Per-slice token counts, the total, and the budget. */
  readonly table: string;
  /** One line: size, budget headroom, and the wait. */
  readonly summary: string;
  /** Present only when the endpoint has been measured. */
  readonly wait: WaitEstimate | undefined;
  /** `summary`, `table`, every adjustment, then the prompt: the whole dry run. */
  readonly text: string;
}

/**
 * The idle timeout a call built from this pack should ask for.
 *
 * Before an endpoint has been measured the adapter's first-byte timeout falls
 * back to its configured 60s, and a 37k-token pack at ~260 tokens/second is 142
 * seconds of prefill that is work, not a hang. So a pack sizes its own timeout
 * from a deliberately pessimistic prompt rate until the meter has samples.
 */
export const UNMEASURED_PROMPT_TOKENS_PER_SECOND = 120;

/** What a pack kind is called on screen: this view is read by the author, not by a developer. */
const KIND_NAMES: Readonly<Record<PackKind, string>> = {
  spanEdit: "span edit",
  drafting: "drafting",
};

export function estimateWait(pack: Pack, rates: PackRates | undefined): WaitEstimate | undefined {
  const prompt = rates?.promptTokensPerSecond;
  const output = rates?.outputTokensPerSecond;
  if (prompt === undefined || output === undefined || prompt <= 0 || output <= 0) return undefined;
  const prefillMs = (pack.totalTokens / prompt) * 1000;
  const generateMs = (pack.expectedOutputTokens / output) * 1000;
  return { prefillMs, generateMs, totalMs: prefillMs + generateMs };
}

/**
 * Milliseconds of silence to tolerate before this pack's endpoint counts as
 * hung: twice the expected prefill, never less than `floorMs`.
 */
export function packTimeoutMs(pack: Pack, rates?: PackRates, floorMs = 60_000): number {
  const rate = rates?.promptTokensPerSecond ?? UNMEASURED_PROMPT_TOKENS_PER_SECOND;
  const prefillMs = (pack.totalTokens / Math.max(rate, 1)) * 1000;
  return Math.max(floorMs, Math.ceil(prefillMs * 2));
}

export function renderPack(pack: Pack, rates?: PackRates): PackPreview {
  const wait = estimateWait(pack, rates);
  const table = renderTable(pack);
  const summary = renderSummary(pack, wait, rates);
  const notes = pack.adjustments.map(renderAdjustment);

  return {
    prompt: pack.prompt,
    table,
    summary,
    wait,
    text: [summary, table, ...(notes.length === 0 ? [] : [notes.join("\n")]), pack.prompt].join("\n\n"),
  };
}

function renderTable(pack: Pack): string {
  const rows = pack.slices.map((slice) => [slice.name, thousands(slice.tokens), slice.source ?? "built in"]);
  const total: string[] = ["total", thousands(pack.totalTokens), `of ${thousands(pack.budgetTokens)} budget`];
  const header = ["slice", "tokens", "source"];
  const widths = columnWidths([header, ...rows, total]);

  const line = (cells: readonly string[]): string =>
    [pad(cells[0] ?? "", widths[0] ?? 0), padStart(cells[1] ?? "", widths[1] ?? 0), cells[2] ?? ""]
      .join("  ")
      .trimEnd();

  const rule = widths.map((width, index) => "-".repeat(index === 2 ? Math.min(width, 40) : width)).join("  ");

  return [line(header), rule, ...rows.map(line), rule, line(total)].join("\n");
}

function renderAdjustment(adjustment: SliceAdjustment): string {
  const where = adjustment.source === undefined ? "" : ` (${adjustment.source})`;
  return adjustment.action === "dropped"
    ? `dropped: ${adjustment.name}${where}, ${thousands(adjustment.beforeTokens)} tokens, to fit the budget`
    : `truncated: ${adjustment.name}${where}, ${thousands(adjustment.beforeTokens)} to ` +
        `${thousands(adjustment.afterTokens)} tokens, ${thousands(adjustment.droppedTokens)} dropped`;
}

function renderSummary(pack: Pack, wait: WaitEstimate | undefined, rates: PackRates | undefined): string {
  const size =
    `${KIND_NAMES[pack.kind]} pack: ${thousands(pack.slices.length)} slices, ` +
    `${thousands(pack.totalTokens)} of ${thousands(pack.budgetTokens)} tokens` +
    (pack.withinBudget ? "" : " (OVER BUDGET)") +
    (pack.adjustments.length === 0 ? "" : `, ${pack.adjustments.length} slice(s) cut`);

  if (wait === undefined) {
    const why =
      rates === undefined
        ? "no rates given"
        : "this endpoint has not been measured yet";
    return `${size}. Estimated wait: unknown (${why}).`;
  }

  return (
    `${size}. Estimated wait: ${duration(wait.prefillMs)} reading, ` +
    `${duration(wait.generateMs)} writing ~${thousands(pack.expectedOutputTokens)} tokens, ` +
    `${duration(wait.totalMs)} total.`
  );
}

/** Locale-independent on purpose: the same pack renders the same table anywhere. */
export function thousands(value: number): string {
  const whole = Math.round(value).toString();
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function columnWidths(rows: readonly (readonly string[])[]): number[] {
  const widths = [0, 0, 0];
  for (const row of rows) {
    for (let column = 0; column < widths.length; column += 1) {
      widths[column] = Math.max(widths[column] ?? 0, (row[column] ?? "").length);
    }
  }
  return widths;
}

function pad(text: string, width: number): string {
  return text.padEnd(width, " ");
}

function padStart(text: string, width: number): string {
  return text.padStart(width, " ");
}
