"""The per-work pronunciation lexicon (AGT-1798).

`outputs/radio/pronounce.md` in a work: one entry per line, `word -> respelling`
(`→` works too), optionally scoped to a speaker with `SPEAKER: word -> respelling`.
Blank lines, `#` comments and a leading `- ` bullet are ignored.

    Zinfandel -> zin-fan-DELL
    CORA: reach -> reech

Entries apply to the text an engine reads, never to the script, manifest or
display text: whole word, case-insensitive, punctuation kept. The entries that
match a pass go into its take key (`params["lexicon"]`, canonical JSON), so
changing a respelling re-renders exactly the takes that use it. The words gate
compares against the original script text, so a respelling does not fail WER.

Pure Python.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from pablo_casting.outputs import output_dir

LEXICON_FILE = Path("outputs") / "radio" / "pronounce.md"
PARAM = "lexicon"

_ARROW = re.compile(r"\s*(?:->|→)\s*")
_SCOPE = re.compile(r"^([A-Z][A-Z0-9_ ]*):\s*(.+)$")
_WORDS = re.compile(r"[A-Za-z0-9]+(?:'[A-Za-z0-9]+)*")


@dataclass(frozen=True)
class Entry:
    word: str  # lower-case
    respelling: str
    speaker: str | None = None  # upper-case, None = every speaker

    def row(self) -> tuple[str, str, str]:
        return (self.speaker or "", self.word, self.respelling)


def parse(text: str) -> list[Entry]:
    entries: list[Entry] = []
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("- "):
            line = line[2:].strip()
        if not line or line.startswith("#"):
            continue
        speaker = None
        scoped = _SCOPE.match(line)
        if scoped:
            speaker, line = scoped.group(1).strip(), scoped.group(2)
        parts = _ARROW.split(line, maxsplit=1)
        if len(parts) != 2 or not parts[0].strip() or not parts[1].strip():
            continue
        entries.append(Entry(parts[0].strip().lower(), parts[1].strip(), speaker))
    return entries


def load(work: Path) -> list[Entry]:
    """The current output's lexicon: radio's `outputs/radio/pronounce.md`, narrated's `outputs/narrated/pronounce.md` (AGT-2158)."""
    path = output_dir(work) / LEXICON_FILE.name
    return parse(path.read_text(encoding="utf-8")) if path.is_file() else []


def _applies(entry: Entry, speaker: str) -> bool:
    return entry.speaker is None or entry.speaker == speaker.upper()


def params_for(entries: Sequence[Entry], lines: Iterable[tuple[str, str]]) -> Mapping[str, str]:
    """The take-key param for the entries matching any `(speaker, text)` line; empty when none match."""
    chosen: set[tuple[str, str, str]] = set()
    for speaker, text in lines:
        said = {w.lower() for w in _WORDS.findall(text)}
        for entry in entries:
            if entry.word in said and _applies(entry, speaker):
                chosen.add(entry.row())
    if not chosen:
        return {}
    return {PARAM: json.dumps(sorted(chosen), ensure_ascii=False, separators=(",", ":"))}


def apply(param: object, speaker: str, text: str) -> str:
    """Respells `text` per the take key's `lexicon` param (a no-op when absent or malformed)."""
    if not isinstance(param, str) or not param:
        return text
    try:
        rows = json.loads(param)
    except ValueError:
        return text
    for scope, word, respelling in rows:
        if scope and scope != speaker.upper():
            continue
        pattern = re.compile(r"(?<![A-Za-z0-9'])" + re.escape(word) + r"(?![A-Za-z0-9]|'[A-Za-z0-9])", re.I)
        text = pattern.sub(lambda _m, r=respelling: r, text)
    return text


def respelt_words(param: object) -> tuple[str, ...]:
    """The single-token script words a take's `lexicon` param respells (for the words gate)."""
    if not isinstance(param, str) or not param:
        return ()
    try:
        rows = json.loads(param)
    except ValueError:
        return ()
    return tuple(sorted({word for _scope, word, _respelling in rows if _WORDS.fullmatch(word)}))
