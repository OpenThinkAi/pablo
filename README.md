# draft

AI-native terminal tool for writing and composition. Not a text editor.

`draft` opens a manuscript from a plain markdown vault, lets you select a span and
tag it, prompt on it, or replace it by hand, and reviews the model's proposals as
inline CriticMarkup you accept, reject, or edit in place. Context for a long
manuscript is retrieved by walking a map of the book (structure, entities, facts
with story-time and provenance), not by dumping the book into the prompt.

**The model has no write tool.** It proposes; the app applies.

Local models are the default (no key required). OpenAI and Anthropic are a key and
a toggle away.

Design doc (canonical, decisions table, build order):
`saltline-digital-vault/projects/ai-terminal/README.md`.

Status: design complete 2026-09-01, P0 in tickets. Nothing runs yet.

## License

MIT
