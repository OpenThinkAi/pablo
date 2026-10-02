// What pablo is doing, in the author's words (AGT-1567): a tool call as a short phrase, and a duration as a short
// span. Pure and import-free (state.ts uses it for the busy line; compose.ts draws the same phrase on the tool's line).

const record = (input: unknown): Record<string, unknown> => (typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {});
const text = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
const short = (value: string, max = 40): string => { const chars = [...value]; return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : value; };
/** ` ${prefix}${value}` when the value is there, else nothing. */
const about = (prefix: string, value: unknown): string => { const v = short(text(value)); return v ? ` ${prefix}${v}` : ""; };
const chapterOf = (a: Record<string, unknown>): string => {
  if (typeof a["chapter"] === "number" || (typeof a["chapter"] === "string" && a["chapter"] !== "")) return ` chapter ${String(a["chapter"])}`;
  const file = text(a["file"]).match(/(?:^|\/)(\d+)[^/]*$/);
  return file ? ` chapter ${Number(file[1])}` : "";
};

/** A tool call as a phrase: "researching 1919 grape prices", "drafting chapter 3 on Gemma". Unknown tools show their name. */
export function activityOf(tool: string, input: unknown): string {
  const a = record(input);
  switch (tool) {
    case "resume": case "status": return "checking where the book stands";
    case "read": return `reading${about("", a["path"]) || " the work"}`;
    case "search": return `searching${about("for ", a["phrase"])}`;
    case "timeline": return `checking the timeline${about("at ", a["date"])}`;
    case "WebSearch": return `researching${about("", a["query"])}`;
    case "WebFetch": return `researching${about("", a["url"])}`;
    case "draft_chapter": case "write": return `drafting${chapterOf(a) || " prose"} on Gemma`;
    case "revise": return `revising${chapterOf(a) || " a passage"} on Gemma`;
    case "check": return "checking the prose";
    case "save": return "saving";
    case "propose": return `proposing${about("", a["stage"])}`;
    case "record_fact": return "recording a fact";
    case "save_research": return `saving research${about("", a["name"])}`;
    case "ask_author": return "asking you";
    default: return `calling ${tool}`;
  }
}

/** A duration as the activity line shows it: `340ms`, `71s`, `2m 05s` (seconds up to two minutes). */
export function spanOf(ms: number): string {
  const n = Math.max(0, Math.round(ms));
  if (n < 1000) return `${n}ms`;
  const s = Math.round(n / 1000);
  return s < 120 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
