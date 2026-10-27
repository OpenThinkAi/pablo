// The CLI verbs the `o` prefix routes (AGT-2179, D-3): each command id is the argv head it runs. The layer above
// (onCommand) builds the final argv through `verbArgs`; `config set` is guarded here so the TUI never carries, prints
// or stores a key value: a `providers.<id>.key` is only ever an `env:NAME` or `keychain:service[/account]` reference.

export const VERB_ROUTES: Readonly<Record<string, readonly string[]>> = {
  "output.add": ["output", "add"],
  "output.critique": ["critique"],
  "output.check": ["check"],
  "output.publish": ["publish"],
  "voice.edit": ["voice", "edit"],
  "voice.remove": ["voice", "remove"],
  "voice.use": ["voice", "use"],
  "config.show": ["config", "show"],
  "config.set": ["config", "set"],
};

export type VerbArgs = { readonly ok: true; readonly argv: readonly string[] } | { readonly ok: false; readonly message: string };

const KEY_PATH = /^providers\.[^.]+\.key$/;
const KEY_REF = /^(env:[A-Za-z_][A-Za-z0-9_]*|keychain:[^\s/]+(\/[^\s/]+)?)$/;

/** The argv for a routed command id and its extra arguments; refuses an unknown id, and a `config set` of a key that is not a reference (the message never repeats the value). */
export function verbArgs(id: string, extra: readonly string[] = []): VerbArgs {
  const head = VERB_ROUTES[id];
  if (!head) return { ok: false, message: `No verb is routed for ${id}.` };
  if (id === "config.set") {
    const [path, value] = extra;
    if (path === undefined || value === undefined) return { ok: false, message: "config set needs a path and a value." };
    if (KEY_PATH.test(path) && !KEY_REF.test(value)) return { ok: false, message: "A key is set as a reference (env:NAME or keychain:service/account), never as the key itself." };
  }
  return { ok: true, argv: [...head, ...extra] };
}

/** What a routed verb asks for before it runs: nothing (it runs at once), or one line of arguments, with a hint. `masked`: the value after the first word is never drawn. */
export interface VerbAsk { readonly title: string; readonly hint: string; readonly masked?: true }
export const VERB_ASKS: Readonly<Record<string, VerbAsk>> = {
  "output.add": { title: "Add an output", hint: "the type (and for narrated: narrated --from <output>)" },
  "voice.edit": { title: "Edit a voice rule", hint: "the rule id, then the new text" },
  "voice.remove": { title: "Remove a voice rule", hint: "the rule id" },
  "voice.use": { title: "Use a voice", hint: "the voice's name" },
  "config.set": { title: "Set a config path", hint: "path value (a key is env:NAME or keychain:service/account; the value is not shown)", masked: true },
};

/** The typed line as extra argv: split on spaces, the rule text of `voice edit` kept whole after its id. */
export function verbExtra(id: string, line: string): string[] {
  const words = line.trim().split(/\s+/).filter(Boolean);
  if (id === "voice.edit" && words.length > 2) return [words[0]!, words.slice(1).join(" ")];
  return words;
}
