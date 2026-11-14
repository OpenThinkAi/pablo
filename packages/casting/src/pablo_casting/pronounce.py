"""`pronounce`: what the engine will say for an output's script lines (AGT-2302). Read-only, no model.

`python -m pablo_casting pronounce --work W [--episode N] [--output radio|narrated]`
(the pablo CLI's `pablo pronounce`) reads the output's scripts (radio's
`outputs/radio/episodes/`, narrated's `outputs/narrated/readings/`) and, for
every spoken line whose engine input differs from its text, reports the line
number, the speaker, each token the normalisers changed (`"10-20%" -> "ten to
twenty percent"`, `"AI" -> "A I"`, a lexicon respelling) and the whole text
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

By default (AGT-2304) the capitalised and ALL-CAPS words that also appear in lower case elsewhere in the output, month
and weekday names, common English words and common first names (`noise.py`) are left out and counted in
`unresolvedHidden`; the rest is ranked mixed-case tokens (`ChatGPT`), then words with unusual letter patterns, then the
others. `--all` lists every word in the order of count, as before.

For `pronounce --suggest` (AGT-2303) each unresolved token also carries the speaker and sentence of its first
occurrence, and `heteronyms` lists, per line, the words of `HETERONYMS` (common English words whose sound depends on
the sense: read, lead, live, close, tear, wind ...) the lexicon does not already decide for that speaker, each with its
sentence. The pablo CLI sends those to the `plan` model; nothing here does.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Sequence
from pathlib import Path

from pablo_casting import outputs
from pablo_casting.binding import episode_files
from pablo_casting.engines import ACRONYMS_PARAM, ACRONYMS_VERSION, LEXICON_PARAM, as_letters, chatterbox_text, is_shouted, spoken_params, turbo_text
from pablo_casting.lexicon import Entry, acronym_mode, lexicon_path, load
from pablo_casting.manifest import read_version, versions
from pablo_casting.noise import is_common, rank
from pablo_casting.script import parse_script
from pablo_casting.spoken import mask, undecided
from pablo_casting.stale import stale_lines

Result = tuple[dict[str, object], int]

_WORD = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)*")
_SENTENCES = re.compile(r"(?<=[.!?])\s+")

# Common English heteronyms: spelled alike, sounded differently by sense. The engine reads one default; whether a line
# means the other is a judgement for the model and the author (`pronounce --suggest`).
HETERONYMS = frozenset(
    "bass bow close content converse desert does dove entrance invalid lead live minute moderate object permit "
    "polish present produce project read record refuse resume row separate sewer sow subject tear wind wound".split()
)
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


def _sentence(text: str, token: str) -> str:
    """The sentence of `text` that holds `token` as a word (the whole text when none does)."""
    word = re.compile(rf"(?<![A-Za-z0-9']){re.escape(token.rstrip('.'))}(?![A-Za-z0-9'])")
    for sentence in _SENTENCES.split(text.strip()):
        if word.search(sentence):
            return sentence
    return text.strip()


def _heteronyms(text: str, speaker: str, entries: Sequence[Entry]) -> list[str]:
    """The `HETERONYMS` in a line, once each in order, that no lexicon entry for this speaker decides."""
    known = _known(entries, speaker)
    masked, _links = mask(text)
    found: list[str] = []
    for match in _WORD.finditer(masked):
        word = match.group(0).lower()
        if word in HETERONYMS and word not in known and word not in found:
            found.append(word)
    return found


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
        if letters_on and as_letters(word) is not None:
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


_WORD_KINDS = ("caps", "capitalised")


def _lower_case_words(work: Path) -> set[str]:
    """Every word the output's scripts spell all in lower case somewhere (all units, not only the one asked for)."""
    seen: set[str] = set()
    for _n, path in episode_files(work):
        for spoken in parse_script(path.read_text(encoding="utf-8")).lines:
            seen.update(w for w in _WORD.findall(mask(spoken.text)[0]) if w == w.lower())
    return seen


def cmd_pronounce(work: Path, episode: int | None, everything: bool = False) -> Result:
    output = outputs.current()
    entries = load(work)
    acronyms = acronym_mode(work)
    files = [(n, path) for n, path in episode_files(work) if episode is None or n == episode]
    where = outputs.scripts_dir(work).relative_to(work)
    if not files:
        missing = f"{output} unit {episode}" if episode is not None else f"scripts in {where}/"
        have = [n for n, _path in episode_files(work)]
        hint = f"; its units are {', '.join(str(n) for n in have)}" if have else f"; {where}/ holds no script with a CAST: line"
        return {"ok": False, "code": 2, "message": f"pronounce: no {missing} in {work}{hint}", "missing": [missing], "units": have}, 2
    units: list[dict[str, object]] = []
    counts: Counter[str] = Counter()
    first: dict[str, tuple[str, int, int]] = {}  # token -> (kind, unit, line)
    where: dict[str, tuple[str, str]] = {}  # token -> (speaker, sentence) of its first occurrence
    heteronyms: list[dict[str, object]] = []
    changed = 0
    stale_total = 0
    for number, path in files:
        script = parse_script(path.read_text(encoding="utf-8"))
        lines: list[dict[str, object]] = []
        for spoken in script.lines:
            params = spoken_params([(spoken.speaker, spoken.text)], entries, acronyms)
            respelt = params.get(LEXICON_PARAM)
            letters = params.get(ACRONYMS_PARAM) == ACRONYMS_VERSION
            changes: list[tuple[str, str]] = []
            read = chatterbox_text if spoken.drama else turbo_text  # a [DRAMA] scene's engine
            engine = read(spoken.text, spoken.speaker, respelt, letters, changes)
            for word, kind in _unresolved(spoken.text, spoken.speaker, entries, acronyms, changes):
                counts[word] += 1
                first.setdefault(word, (kind, number, spoken.line))
                where.setdefault(word, (spoken.speaker, _sentence(spoken.text, word)))
            for word in _heteronyms(spoken.text, spoken.speaker, entries):
                heteronyms.append({"word": word, "unit": number, "line": spoken.line, "speaker": spoken.speaker, "sentence": _sentence(spoken.text, word)})
            if engine == spoken.text:
                continue
            changed += 1
            lines.append({"line": spoken.line, "speaker": spoken.speaker, "text": spoken.text, "engine": engine, "changes": _in_order(spoken.text, _collapse(changes))})
        unit: dict[str, object] = {"unit": number, "file": str(path.relative_to(work)), "lines": lines}
        found = versions(work, number)
        if found:  # AGT-2305: performed lines whose take no longer matches how they are spoken
            manifest = read_version(work, number, found[-1])
            stale = stale_lines(work, [line for line in manifest.get("lines", []) if isinstance(line, dict)], entries, acronyms)  # type: ignore[union-attr]
            unit.update({"version": found[-1], "stale": stale})
            stale_total += len(stale)
        units.append(unit)
    lexicon = lexicon_path(work)
    # A word also written in lower case elsewhere, a month or weekday, a common English word or first name is noise: left
    # out unless `everything`. The rest ranks mixed-case tokens, then unusual letter patterns, then the others.
    lower = set() if everything else _lower_case_words(work)
    rows: list[tuple[str, int]] = []
    hidden = 0
    for token in counts:
        kind = first[token][0]
        if not everything and kind in _WORD_KINDS and (token.lower() in lower or is_common(token)):
            hidden += 1
            continue
        rows.append((token, rank(token) if kind in _WORD_KINDS else 1))
    if everything:
        ordered = sorted(counts, key=lambda t: (-counts[t], t))
    else:
        ordered = [t for t, r in sorted(rows, key=lambda item: (item[1], -counts[item[0]], item[0]))]
    return {
        "ok": True,
        "output": output,
        "acronyms": acronyms,
        "lexicon": str(lexicon.relative_to(work)),
        "lexiconEntries": len(entries),
        "units": units,
        "changedLines": changed,
        "staleLines": stale_total,
        "unresolved": [
            {
                "token": token,
                "kind": first[token][0],
                "count": counts[token],
                "first": {"unit": first[token][1], "line": first[token][2]},
                "speaker": where[token][0],
                "sentence": where[token][1],
            }
            for token in ordered
        ],
        "unresolvedHidden": hidden,
        "heteronyms": heteronyms,
    }, 0
