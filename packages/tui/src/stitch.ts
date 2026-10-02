// The stitcher lives in core (packages/core/src/diff/stitch.ts): pure, and the CLI's accept/reject needs the same edits
// the screen shows. Re-exported here so review mode's modules keep one import path; there is one stitcher, not two.

export { markWords, stitch } from "@openthink/pablo-core";
export type { Edit, EditLine, LineRef, Seg, Stitcher } from "@openthink/pablo-core";
