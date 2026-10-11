"""Normalise a `CAST:` role description into the cards' `traits` vocabulary.

A small deterministic mapper: gender comes from the `CAST:` entry (`=f`), the
rest from the words of the quoted description. Fields (a fixed vocabulary, so
matching is comparable): gender, age, pitch, energy, warmth, register, era,
roles. Phrases that map to nothing are returned as `free_text`, left for the
harness (a later ticket) to normalise; they are never guessed at here.

`parse_traits` (AGT-1679) validates a card's `traits` block against the same
vocabulary (`TRAIT_VOCABULARY`, derived from the mapper's tables), so what
the mapper produces is always a valid card block.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
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


# ---------------------------------------------------------------------------
# Validation (AGT-1679): the vocabulary a card's `traits` block must use.
# Derived from the mapper's own tables above, so a mapped description always
# validates and there is one vocabulary, not two.
# ---------------------------------------------------------------------------

TRAIT_VOCABULARY: dict[str, tuple[str, ...]] = {
    "gender": ("f", "m", "x"),
    "age": AGE_BANDS,
    **{name: tuple(table) for name, table in _TABLES.items()},
}
"""Closed fields and their allowed values, in card order."""

TRAIT_ORDER = (*TRAIT_VOCABULARY.keys(), "roles")
_ROLE_KIND = re.compile(r"^[a-z][a-z0-9-]{0,31}$")


class TraitsError(ValueError):
    """A traits block outside the vocabulary; a refusal naming the field."""


def parse_traits(raw: str | Mapping[str, object] | None) -> dict[str, object]:
    """Validates a traits block (a JSON string or a mapping) and returns it in card order.

    `roles` is the one open field: short lowercase role kinds ("lead",
    "bookkeeper"), weighed lightly by the matcher; every other field is closed.
    """
    if raw is None:
        return {}
    if isinstance(raw, str):
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as error:
            raise TraitsError(f"--traits is not valid JSON: {error}") from error
    else:
        value = dict(raw)
    if not isinstance(value, dict):
        raise TraitsError("--traits must be a JSON object")

    unknown = sorted(set(value) - set(TRAIT_ORDER))
    if unknown:
        raise TraitsError(f"unknown trait {', '.join(unknown)}; the fields are {', '.join(TRAIT_ORDER)}")

    traits: dict[str, object] = {}
    for name in TRAIT_ORDER:
        if name not in value:
            continue
        given = value[name]
        if name == "roles":
            if not isinstance(given, list) or not all(isinstance(r, str) and _ROLE_KIND.match(r) for r in given):
                raise TraitsError('trait roles must be a list of short lowercase role kinds, e.g. ["lead", "bookkeeper"]')
            traits[name] = list(given)
            continue
        allowed = TRAIT_VOCABULARY[name]
        if given not in allowed:
            raise TraitsError(f"trait {name} must be one of {', '.join(allowed)} (got {json.dumps(given)})")
        traits[name] = given
    return traits


def require_gender(traits: Mapping[str, object]) -> None:
    if "gender" not in traits:
        raise TraitsError('a card\'s traits need at least a gender (matching filters on it): pass --traits \'{"gender": "f", ...}\'')


# ---------------------------------------------------------------------------
# Traits -> a designer instruct (AGT-1699): the reverse of the mapper above.
# Design on demand describes a voice to the designer from its traits block, so
# the instruct is written in the same vocabulary the card will carry. Two
# phrasings: the first round uses variant 0, the retry re-phrases (variant 1).
# ---------------------------------------------------------------------------

_GENDER_NOUN = {"f": ("woman", "her", "female"), "m": ("man", "his", "male"), "x": ("person", "their", "androgynous")}
_AGE_PHRASE = {
    "teen": "in {pos} teens",
    "20s": "in {pos} twenties",
    "30s": "in {pos} thirties",
    "40s": "in {pos} forties",
    "50s": "in {pos} fifties",
    "60s": "in {pos} sixties",
    "70s": "in {pos} seventies",
}
_AGE_ADJECTIVE = {
    "child": "child's", "teen": "teenage", "20s": "young", "30s": "thirty-something",
    "40s": "forty-something", "50s": "middle-aged", "60s": "older", "70s": "elderly",
}  # fmt: skip
_ERA_PHRASE = {"period": "an old-fashioned, period manner", "modern": "a contemporary manner"}

INSTRUCT_VARIANTS = 2
"""How many phrasings `describe_traits` has: one per design round (the first try and the one retry)."""


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def describe_traits(traits: Mapping[str, object], free_text: tuple[str, ...] | list[str] = (), variant: int = 0) -> str:
    """A designer instruct from a traits block, in plain words. Deterministic; `variant` re-phrases.

    Free-text phrases the mapper could not normalise are carried through as they
    were written, so nothing the writer asked for is dropped.
    """
    noun, pos, adjective = _GENDER_NOUN.get(str(traits.get("gender") or "x"), _GENDER_NOUN["x"])
    age, pitch, energy = _text(traits.get("age")), _text(traits.get("pitch")), _text(traits.get("energy"))
    warmth, register, era = _text(traits.get("warmth")), _text(traits.get("register")), _text(traits.get("era"))
    raw_roles = traits.get("roles")
    roles = [r for r in raw_roles if isinstance(r, str) and r] if isinstance(raw_roles, list) else []
    extra = [phrase.strip() for phrase in free_text if phrase.strip()]

    if variant % INSTRUCT_VARIANTS == 0:
        head = "A child" if age == "child" else f"A {noun}" + (f" {_AGE_PHRASE[age].format(pos=pos)}" if age in _AGE_PHRASE else "")
        parts = [head + (f", with a {pitch}-pitched voice" if pitch else "")]
        manner = [v for v in (energy, warmth) if v] + ([f"{register} in delivery"] if register else [])
        if manner:
            parts.append(", ".join(manner))
        if era in _ERA_PHRASE:
            parts.append(_ERA_PHRASE[era])  # type: ignore[index]
        if roles:
            parts.append(f"suited to a {' or '.join(roles)}")
        parts.extend(extra)
        return "; ".join(parts) + "."

    # The re-phrase: a different order and different words over the same vocabulary.
    lead = " ".join(w for w in (_AGE_ADJECTIVE.get(age or "", ""), adjective, "voice") if w)
    sentences = [lead[0].upper() + lead[1:] + (f", {pitch} in pitch" if pitch else "") + "."]
    how = ([f"a {register} delivery"] if register else []) + ([f"{warmth} in tone"] if warmth else []) + ([f"{energy} in pace"] if energy else [])
    if how:
        sentences.append("Speaks " + ("with " if register else "") + ", ".join(how) + ".")
    if era is not None:
        sentences.append("Sounds of another era." if era == "period" else "Sounds of today.")
    if roles:
        sentences.append(f"Cast as the {' and '.join(roles)}.")
    sentences.extend(phrase[0].upper() + phrase[1:] + ("" if phrase.endswith(".") else ".") for phrase in extra)
    return " ".join(sentences)


def vocabulary_body() -> dict[str, object]:
    """The traits vocabulary as the harness's `describe_voice` tool returns it: the closed fields and the one open one."""
    return {
        **{name: list(values) for name, values in TRAIT_VOCABULARY.items()},
        "roles": "open: short lowercase role kinds, e.g. lead, bookkeeper",
    }
