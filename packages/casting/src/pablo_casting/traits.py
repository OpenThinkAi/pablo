"""Normalise a `CAST:` role description into the cards' `traits` vocabulary.

A small deterministic mapper: gender comes from the `CAST:` entry (`=f`), the
rest from the words of the quoted description. Fields (a fixed vocabulary, so
matching is comparable): gender, age, pitch, energy, warmth, register, era,
roles. Phrases that map to nothing are returned as `free_text`, left for the
harness (a later ticket) to normalise; they are never guessed at here.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

AGE_BANDS = ("child", "teen", "20s", "30s", "40s", "50s", "60s", "70s")

_AGE_WORDS: dict[str, str] = {
    "child": "child", "kid": "child", "boy": "child", "girl": "child",
    "teen": "teen", "teenage": "teen", "teenager": "teen", "adolescent": "teen",
    "twenties": "20s", "thirties": "30s", "forties": "40s", "fifties": "50s", "sixties": "60s",
    "seventies": "70s", "eighties": "70s", "young": "20s", "middle-aged": "50s",
    "elderly": "70s", "old": "70s", "aged": "70s",
}

# vocabulary -> the words (or phrases) that mean it. First match in the text wins per field.
_PITCH: dict[str, tuple[str, ...]] = {
    "low-medium": ("low-medium", "low medium"),
    "low": ("low", "deep", "bass", "baritone", "gravelly"),
    "medium-high": ("medium-high", "medium high"),
    "high": ("high", "reedy", "shrill", "bright"),
    "medium": ("medium", "mid"),
}
_ENERGY: dict[str, tuple[str, ...]] = {
    "subdued": ("subdued", "quiet", "soft-spoken", "hushed", "calm"),
    "measured": ("measured", "steady", "deliberate", "even"),
    "lively": ("lively", "energetic", "animated", "expansive", "boisterous", "exuberant", "bouncy"),
    "intense": ("intense", "fierce", "forceful", "commanding"),
}
_WARMTH: dict[str, tuple[str, ...]] = {
    "warm": ("warm", "warmth", "kind", "gentle", "friendly"),
    "cool": ("cool", "cold", "distant", "aloof", "icy"),
}
_REGISTER: dict[str, tuple[str, ...]] = {
    "dry": ("dry", "wry", "deadpan"),
    "formal": ("formal", "exact", "precise", "proper", "prim"),
    "folksy": ("folksy", "homespun", "rustic", "country", "down-to-earth"),
    "theatrical": ("theatrical", "grand", "booming", "orotund"),
    "plain": ("plain", "plainspoken", "blunt", "direct"),
    "gruff": ("gruff", "rough", "curt"),
}
_ERA: dict[str, tuple[str, ...]] = {
    "period": ("period", "vintage", "old-fashioned", "antique"),
    "modern": ("modern", "contemporary"),
}
_ROLE_KINDS: tuple[str, ...] = ("lead", "villain", "sidekick", "mentor", "narrator", "announcer")

_TABLES: dict[str, dict[str, tuple[str, ...]]] = {
    "pitch": _PITCH,
    "energy": _ENERGY,
    "warmth": _WARMTH,
    "register": _REGISTER,
    "era": _ERA,
}

_DECADE = re.compile(r"\b([1-9]0)s\b")
_YEAR = re.compile(r"\b(1[89]\d\d|19[0-6]\d)\b")


def _has(text: str, word: str) -> bool:
    return re.search(rf"(?<![\w-]){re.escape(word)}(?![\w-])", text) is not None


def _first(text: str, table: dict[str, tuple[str, ...]]) -> str | None:
    """The vocabulary word whose earliest alias appears first in `text` (longer aliases win at a tie)."""
    best: tuple[int, int, str] | None = None
    for value, aliases in table.items():
        for alias in aliases:
            match = re.search(rf"(?<![\w-]){re.escape(alias)}(?![\w-])", text)
            if match is None:
                continue
            candidate = (match.start(), -len(alias), value)
            if best is None or candidate < best:
                best = candidate
    return None if best is None else best[2]


def _age(text: str) -> str | None:
    best: tuple[int, str] | None = None
    for match in _DECADE.finditer(text):
        band = f"{match.group(1)}s"
        if band in AGE_BANDS and (best is None or match.start() < best[0]):
            best = (match.start(), band)
    for word, band in _AGE_WORDS.items():
        match = re.search(rf"(?<![\w-]){re.escape(word)}(?![\w-])", text)
        if match is not None and (best is None or match.start() < best[0]):
            best = (match.start(), band)
    return None if best is None else best[1]


@dataclass(frozen=True)
class Traits:
    traits: dict[str, object]
    free_text: tuple[str, ...] = field(default_factory=tuple)

    def as_body(self) -> dict[str, object]:
        return {"traits": self.traits, "free_text": list(self.free_text)}


def _phrase_maps(phrase: str) -> bool:
    """Whether `phrase` says anything the vocabulary knows (so it is not free text)."""
    if _age(phrase) is not None or _DECADE.search(phrase) or _YEAR.search(phrase):
        return True
    if any(_first(phrase, table) is not None for table in _TABLES.values()):
        return True
    return any(_has(phrase, kind) for kind in _ROLE_KINDS)


def normalise(role: str, gender: str | None, description: str | None) -> Traits:
    """`CAST: CORA=f "thirties, dry, exact"` -> gender f, age 30s, register dry. A bare `CORA=f` is gender only."""
    traits: dict[str, object] = {}
    if gender in ("m", "f"):
        traits["gender"] = gender
    kinds: list[str] = []
    if role.strip().lower() in ("narrator", "announcer"):
        kinds.append(role.strip().lower())
    free: list[str] = []

    text = (description or "").strip().lower()
    if text:
        age = _age(text)
        if age is not None:
            traits["age"] = age
        for name, table in _TABLES.items():
            value = _first(text, table)
            if value is not None:
                traits[name] = value
        if "era" not in traits and _YEAR.search(text):
            traits["era"] = "period"
        for kind in _ROLE_KINDS:
            if _has(text, kind) and kind not in kinds:
                kinds.append(kind)
        free = [phrase for phrase in (p.strip() for p in text.split(",")) if phrase and not _phrase_maps(phrase)]
    if kinds:
        traits["roles"] = kinds
    return Traits(traits=traits, free_text=tuple(free))
