import { expect, test } from "bun:test";
import { screenVerb } from "../src/screen-verb";

test("screenVerb runs argv in the dir, adds --project except for config, and says a failure as the verb did", async () => {
  const echo = [process.execPath, "-e", "console.log(process.argv.slice(1).join(' '))"];
  expect(await screenVerb(process.cwd(), "ice", echo)(["check"])).toEqual({ ok: true, lines: ["check --project ice"] });
  expect(await screenVerb(process.cwd(), "ice", echo)(["config", "show"])).toEqual({ ok: true, lines: ["config show"] });
  const fail = [process.execPath, "-e", "console.error('refused'); process.exit(1)", "--"];
  expect(await screenVerb(process.cwd(), undefined, fail)(["publish"])).toEqual({ ok: false, message: "refused" });
  const silent = [process.execPath, "-e", "process.exit(3)"];
  expect(await screenVerb(process.cwd(), undefined, silent)(["publish"])).toEqual({ ok: false, message: "pablo publish stopped (exit 3) without saying why." });
});
