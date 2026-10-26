export type { Document, Span } from "./document";
export { isWithin, locatePassage, selectionText } from "./document";
export * from "./markup";
export * from "./pack";
export * from "./providers";
export * from "./diff";
export * from "./web";
export { joinManuscript, joinParagraphs, joinSentences, splitManuscript, splitSentences } from "./sentences";
export type { FactEntry, FactLine, FactScan, Provenance } from "./facts";
export { establishedByOf, formatFactLine, formatProvenance, parseFactLine, scanFacts, unitTag, withProvenance } from "./facts";
export * from "./review-map";
export {
  BEATS_FILE,
  FACTS_FILE,
  LEGACY_BEATS_FILE,
  LEGACY_CONTINUITY_FILE,
  LEGACY_WORK_RULES_FILE,
  NOVEL_CONTINUITY_FILE,
  WORK_RULES_FILE,
  beatsFile,
  continuityFile,
  outputContinuityFile,
  workRulesFile,
} from "./work-paths";
export * from "./web/fetch";
