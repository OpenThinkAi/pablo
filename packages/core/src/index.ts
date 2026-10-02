export type { Document, Span } from "./document";
export { isWithin, locatePassage, selectionText } from "./document";
export * from "./markup";
export * from "./pack";
export * from "./providers";
export * from "./diff";
export { joinManuscript, joinParagraphs, joinSentences, splitManuscript, splitSentences } from "./sentences";
export type { FactEntry, FactLine, FactScan, Provenance } from "./facts";
export { formatFactLine, formatProvenance, parseFactLine, scanFacts, withProvenance } from "./facts";
