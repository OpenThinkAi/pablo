"""`pronounce`: what the engine will say for an output's script lines (AGT-2302). Read-only, no model.

`python -m pablo_casting pronounce --work W [--episode N] [--output radio|narrated]`
(the pablo CLI's `pablo pronounce`) reads the output's scripts (radio's
`outputs/radio/episodes/`, narrated's `outputs/narrated/readings/`) and, for
every spoken line whose engine input differs from its text, reports the line
number, the speaker, each token the normalisers changed (`"10-20%" -> "ten to
twenty percent"`, `"AI" -> "A.I."`, a lexicon respelling) and the whole text
the engine reads. The engine text is built exactly as `perform` builds it
(`engines.spoken_params` then `turbo_text`, or `chatterbox_text` inside a
`[DRAMA]` scene), with the output's lexicon (`lexicon.lexicon_path`) and the
work's acronym mode (`lexicon.acronym_mode`: on for a nonfiction work).

It also lists `unresolved` tokens: capitalised or ALL-CAPS words with no
lexicon entry that the rules left as words (a sentence's first word excepted),
which the author may want to add to `pronounce.md`, and what the shorthand
rules (`spoken.py`) saw but could not decide: links (URLs and email addresses,
read as written, to rewrite by hand), abbreviation-like words ending in a full
stop that is not a sentence's end, and letters stuck to a number that are no
known unit. Nothing is written.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from pathlib import Path

from pablo_casting import outputs
from pablo_casting.binding import episode_files
from pablo_casting.engines import LEXICON_PARAM, chatterbox_text, dotted, is_shouted, spoken_params, turbo_text
from pablo_casting.lexicon import Entry, acronym_mode, lexicon_path, load
from pablo_casting.script import parse_script
from pablo_casting.spoken import mask, undecided

Result = tuple[dict[str, object], int]

_WORD = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)*")
_SENTENCE_END = re.compile(r"(?:^|[.!?:])[\s\"'“”‘’()\[\]—–-]*$")


def _collapse(changes: Sequence[tuple[str, str]]) -> list[dict[str, str]]:
    """The changes as `{from, to}`, a chain through the stages (`NASA` -> `Nasa` -> `nasa`) as one."""
    out: list[dict[str, str]] = []
    for before, after in changes:
        for prior in reversed(out):
            if prior["to"] == before:
                prior["to"] = after
                break
        else:
            out.append({"from": before, "to": after})
    return [c for c in out if c["from"] != c["to"]]


def _in_order(text: str, changes: list[dict[str, str]]) -> list[dict[str, str]]:
    """The changes in the order their tokens appear in the line (the stages record numbers before words)."""
    at = [text.find(c["from"]) for c in changes]
    order = sorted(range(len(changes)), key=lambda k: (at[k] < 0, at[k], k))
    return [changes[k] for k in order]


def _known(entries: Sequence[Entry], speaker: str) -> set[str]:
    return {e.word for e in entries if e.speaker is None or e.speaker == speaker.upper()}


def _unresolved(text: str, speaker: str, entries: Sequence[Entry], acronyms: bool, changes: Sequence[tuple[str, str]] = ()) -> list[tuple[str, str]]:
    """`(token, kind)` for the capitalised (`capitalised`) and ALL-CAPS (`caps`) words the rules left as words, then
    what the shorthand rules saw but could not decide (`spoken.undecided`: `link`, `abbreviation`, `unit`)."""
    known = _known(entries, speaker)
    # A word a rule turned into something else is decided; one only re-cased (`AI` -> `Ai`) is still a word.
    decided = {w for before, after in changes if before.lower() != after.lower() for w in _WORD.findall(before)}
    letters_on = acronyms and not is_shouted(text)
    found: list[tuple[str, str]] = []
    masked, _links = mask(text)
    for match in _WORD.finditer(masked):
        word = match.group(0)
        if not any(c.isupper() for c in word) or word.lower() in known or word in decided:
            continue
        if word.split("'")[0] == "I":  # I, I'm, I'll
            continue
        if letters_on and dotted(word) is not None:
            continue  # read as letters
        letters = [c for c in word if c.isalpha()]
        caps = len(letters) > 1 and all(c.isupper() for c in letters)
        if not caps and len(letters) < 2:
            continue
        if not caps and word[1:] == word[1:].lower() and _SENTENCE_END.search(masked[: match.start()]):
            continue  # a sentence's first word
        found.append((word, "caps" if caps else "capitalised"))
    shorthand = [(token, kind) for token, kind in undecided(text) if token.rstrip(".").lower() not in known]
    abbreviations = {token.rstrip(".") for token, kind in shorthand if kind == "abbreviation"}
    return [(w, k) for w, k in found if w not in abbreviations] + shorthand


def cmd_pronounce(work: Path, episode: int | None) -> Result:
    output = outputs.current()
    entries = load(work)
    acronyms = acronym_mode(work)
    files = [(n, path) for n, path in episode_files(work) if episode is None or n == episode]
    where = outputs.scripts_dir(work).relative_to(work)
    if not files:
        missing = f"{output} unit {episode}" if episode is not None else f"scripts in {where}/"
        return {"ok": False, "code": 2, "message": f"pronounce: no {missing} in {work}", "missing": [missing]}, 2
    units: list[dict[str, object]] = []
    tally: dict[str, dict[str, object]] = {}
    changed = 0
    for number, path in files:
        script = parse_script(path.read_text(encoding="utf-8"))
        lines: list[dict[str, object]] = []
        for spoken in script.lines:
            params = spoken_params([(spoken.speaker, spoken.text)], entries, acronyms)
            respelt = params.get(LEXICON_PARAM)
            letters = params.get("acronyms") is True
            changes: list[tuple[str, str]] = []
            if spoken.drama:
                engine = chatterbox_text(spoken.text, spoken.speaker, respelt, letters)
                turbo_text(spoken.text, spoken.speaker, respelt, letters, changes)  # the same normalisers, for the changes
            else:
                engine = turbo_text(spoken.text, spoken.speaker, respelt, letters, changes)
            for word, kind in _unresolved(spoken.text, spoken.speaker, entries, acronyms, changes):
                row = tally.setdefault(word, {"token": word, "kind": kind, "count": 0, "first": {"unit": number, "line": spoken.line}})
                row["count"] = int(row["count"]) + 1  # type: ignore[call-overload]
            if engine == spoken.text:
                continue
            changed += 1
            lines.append({"line": spoken.line, "speaker": spoken.speaker, "text": spoken.text, "engine": engine, "changes": _in_order(spoken.text, _collapse(changes))})
        units.append({"unit": number, "file": str(path.relative_to(work)), "lines": lines})
    lexicon = lexicon_path(work)
    return {
        "ok": True,
        "output": output,
        "acronyms": acronyms,
        "lexicon": str(lexicon.relative_to(work)),
        "lexiconEntries": len(entries),
        "units": units,
        "changedLines": changed,
        "unresolved": sorted(tally.values(), key=lambda r: (-int(r["count"]), str(r["token"]))),  # type: ignore[call-overload]
    }, 0
