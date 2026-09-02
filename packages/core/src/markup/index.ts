export type { Block, BlockKind, Mark, MarkKind, MarkupDocument, Violation } from "./types";
export { flattenMarks, parse } from "./parse";
export { serialize } from "./serialize";
export type { Decision, Granularity, Selection } from "./spans";
export { expand, insertAt, replaceSpan, resolveAll, resolveMark, shrink } from "./spans";
export type { ValidationResult } from "./validate";
export { validateProposal } from "./validate";
