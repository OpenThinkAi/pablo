/**
 * `pablo prose --format <name>` (AGT-1241): a fixed, short stanza per format —
 * length norms and shape, not a stage machine. See the design doc's "The
 * command" table (`~/saltline-digital-vault/projects/ai-terminal/prose.md`):
 * "a short stanza, not a stage machine: length norms and shape (an email has
 * a subject line; a post has a headline; a reply has no greeting)."
 *
 * Rendered as one slice in the prose pack (`ProseInputs.format`, resolved
 * here before it ever reaches `@openthink/pablo-core` — core knows nothing
 * about format names, only about the text of the slice it was given), so it
 * always shows in `--dry-run`.
 */

export const FORMAT_STANZAS: Readonly<Record<string, string>> = {
  email: [
    "Write this as an email: a subject line first, on its own line, prefixed",
    '"Subject: ". Then a short greeting, one clear ask, and a sign-off. One ask',
    "per email — cut anything that isn't it.",
  ].join("\n"),
  post: [
    "Write this as a post: a headline, then a one-line dek that earns the",
    "read, then the body in short sections with their own subheads. No",
    "email framing: no subject line, no greeting, no sign-off.",
  ].join("\n"),
  page: [
    "Write this as a page: a headline, a subhead, the body in sections, and",
    "exactly one call to action near the end. No subject line, no greeting,",
    "no sign-off.",
  ].join("\n"),
  reply: [
    "Write this as a reply: no greeting. Answer the question or make the",
    "point first, then whatever support it needs. No sign-off unless the",
    "brief specifically asks for one.",
  ].join("\n"),
  note: [
    "Write this as a note: plain paragraphs. No headline, no subject line,",
    "no greeting, no sign-off, and no bullet list unless the brief",
    "specifically asks for one.",
  ].join("\n"),
};

/** `email`, `post`, `page`, `reply`, `note` — the only values `--format` accepts, in a stable listing order. */
export const KNOWN_FORMATS: readonly string[] = Object.keys(FORMAT_STANZAS);
