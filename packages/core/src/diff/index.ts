export { countLines, parseDiff } from "./parse";
export type { DiffLine, FileDiff, Hunk } from "./parse";
export { detectMoves } from "./moves";
export type { Move, MoveEnd } from "./moves";
export { markWords, stitch, tokenize } from "./stitch";
export type { Edit, EditLine, LineRef, Seg, Stitcher } from "./stitch";
