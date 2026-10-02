import { expect, test } from "bun:test";
import { DROP_ORDER, GAP, fieldWidth, fitFields, statusFields, type StatusInput } from "../src/status";

const input: StatusInput = { format: "novel", drafted: 2, total: 24, branch: "draft/ch03", comments: { continuity: 3, tells: 2 } };
const text = (fs: ReturnType<typeof statusFields>) => fs.map((f) => (f.label ? `${f.label} ` : "") + f.value).join(GAP);

test("the fields: format, progress, branch and comment counts by kind", () => {
  expect(text(statusFields(input))).toBe("novel   ch 2 of 24 drafted   branch draft/ch03   comments ▲ 3 continuity · 2 tells");
});

test("no comments reads as none; zero kinds are left out", () => {
  expect(statusFields({ ...input, comments: {} }).find((f) => f.key === "comments")?.value).toBe("none");
  expect(statusFields({ ...input, comments: { continuity: 0, check: 1 } }).find((f) => f.key === "comments")?.value).toBe("▲ 1 check");
});

test("a narrow line drops whole fields in DROP_ORDER and keeps the progress", () => {
  const fields = statusFields(input);
  expect(fitFields(fields, 200)).toEqual(fields);
  expect(fitFields(fields, 70).map((f) => f.key)).toEqual(["format", "progress", "comments"]);
  expect(fitFields(fields, 20).map((f) => f.key)).toEqual(["progress"]);
  expect(fitFields(fields, 1).map((f) => f.key)).toEqual(["progress"]);
  expect(DROP_ORDER).not.toContain("progress");
  expect(fieldWidth({ key: "branch", label: "branch", value: "main" })).toBe(11);
});
