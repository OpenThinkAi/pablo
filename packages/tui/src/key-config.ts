// The author's key overrides: the `keys` object of ~/.config/pablo/config.json, laid over the defaults. The file is
// core's (providers, intents); this reads only its `keys` and leaves the rest to core's own parser.
//
//   { "keys": { "rail.down": "n", "main.page_down": { "primary": "pgdn", "secondary": "" } } }

import { readFileSync } from "node:fs";
import { configPath } from "@openthink/pablo-core";
import { effectiveKeys, KeysError, DEFAULT_KEYMAP, type Binding, type Keymap } from "./keys";

/** The overrides in a config file's text; none when the file has no `keys`. A malformed one throws a KeysError. */
export function parseKeys(text: string, source = "the config file"): Record<string, Binding> {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (error) { throw new KeysError(`keys: ${source} is not valid JSON (${(error as Error).message})`); }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new KeysError(`keys: ${source} must contain a JSON object`);
  const keys = (raw as Record<string, unknown>)["keys"];
  if (keys === undefined) return {};
  if (typeof keys !== "object" || keys === null || Array.isArray(keys)) throw new KeysError(`keys: "keys" in ${source} must be an object`);
  const out: Record<string, Binding> = {};
  for (const [id, v] of Object.entries(keys)) {
    if (typeof v === "string") { out[id] = { primary: v }; continue; }
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new KeysError(`keys: ${id} must be a key or { "primary", "secondary" }`);
    const { primary, secondary, ...rest } = v as Record<string, unknown>;
    if (Object.keys(rest).length) throw new KeysError(`keys: ${id} has unknown field "${Object.keys(rest)[0]}" (expected primary, secondary)`);
    for (const [slot, val] of [["primary", primary], ["secondary", secondary]] as const) {
      if (val !== undefined && typeof val !== "string") throw new KeysError(`keys: ${id} ${slot} must be a string`);
    }
    out[id] = { ...(primary === undefined ? {} : { primary: primary as string }), ...(secondary === undefined ? {} : { secondary: secondary as string }) };
  }
  return out;
}

export interface LoadKeymapOptions {
  readonly env?: Record<string, string | undefined>;
  /** Injected so tests never read the real file. Returns undefined when there is none. */
  readonly readFile?: (path: string) => string | undefined;
}

/** The keymap for this machine: the defaults, or with the config file's overrides laid over them. Throws a KeysError on a bad or conflicting binding. */
export function loadKeymap(options: LoadKeymapOptions = {}): Keymap {
  const path = configPath(options.env ?? process.env);
  const read = options.readFile ?? ((p: string) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } });
  const text = read(path);
  return text === undefined ? DEFAULT_KEYMAP : effectiveKeys(parseKeys(text, path));
}
