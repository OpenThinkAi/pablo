/**
 * The doorbell (AGT-1589): a native macOS notification that a round is waiting,
 * through `osascript` (zero dependencies, on every Mac); the pattern is
 * insieme's `notify.ts`. Known cost: the banner attributes to Script Editor and
 * its click cannot open anything; the menu-bar menu is how a round is opened.
 *
 * The notifier is the injected seam: tests pass a fake, so no suite ever raises
 * a real banner. The text comes off GitHub (a PR title and a login), so it is
 * passed to osascript as `argv`, never concatenated into the script: the script
 * text is a constant with no user data in it.
 */

import type { ReaderRound } from "../read";

/** What a notification may say: who sent it and the round's title. No chapter text is ever in scope here. */
export interface RoundEvent {
  readonly ref: string;
  readonly sender: string;
  readonly title: string;
}

/** The seam: substituted in tests. Throws when the banner could not be raised, so the round is announced again next poll. */
export interface Notifier {
  notify(event: RoundEvent): Promise<void>;
}

export const NOTIFICATION_TITLE = "pablo";

/** A string off the wire, made safe to show: control characters out, whitespace collapsed, bounded. */
export function safeText(value: string | null | undefined, fallback: string, max = 80): string {
  const cleaned = (value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return fallback;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export function notificationBody(event: RoundEvent): string {
  return `${safeText(event.sender, "Matt", 40)} sent you a round to read: ${safeText(event.title, "a new round")}`;
}

export const roundEvent = (round: ReaderRound): RoundEvent => ({ ref: round.ref, sender: round.sender, title: round.title });

/** The AppleScript as a constant that reads its inputs from `argv`; `--` ends option parsing. */
export function osascriptArgs(event: RoundEvent): string[] {
  return [
    "-e",
    "on run argv",
    "-e",
    "display notification (item 1 of argv) with title (item 2 of argv)",
    "-e",
    "end run",
    "--",
    notificationBody(event),
    NOTIFICATION_TITLE,
  ];
}

const OSASCRIPT_TIMEOUT_MS = 10_000;

/** The real notifier. Never constructed by a test. */
export function osascriptNotifier(): Notifier {
  return {
    async notify(event: RoundEvent): Promise<void> {
      const proc = Bun.spawn(["osascript", ...osascriptArgs(event)], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const timer = setTimeout(() => proc.kill(), OSASCRIPT_TIMEOUT_MS);
      let code: number;
      try {
        code = await proc.exited;
      } finally {
        clearTimeout(timer);
      }
      if (code !== 0) throw new Error(`could not raise a notification (osascript exited ${code}); check System Settings > Notifications`);
    },
  };
}
