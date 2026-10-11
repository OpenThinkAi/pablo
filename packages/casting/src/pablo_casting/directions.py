"""The direction grammar: one leading parenthetical per script line.

    SPEAKER: (<emotion>[, <intensity>][, <pace>]) words (laughs) more words

`emotion` is a closed vocabulary of twelve words; a small synonym table maps
the delivery words the writer model reaches for to the nearest one; sound notes
like `(reverberating)` are ignored (they describe the mix, not the voice).
Nothing is dropped silently: an unknown word is reported by `pablo check`.
Mapping a direction onto an engine is an adapter's job, never the script's.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

EMOTIONS: tuple[str, ...] = (
    "neutral", "warm", "amused", "dry", "tender", "tense",
    "urgent", "angry", "afraid", "sad", "weary", "boisterous",
)

# Delivery words the writer model uses -> the nearest vocabulary word.
SYNONYMS: dict[str, str] = {
    "dryly": "dry", "dismissive": "dry", "dismissively": "dry", "wry": "dry", "wryly": "dry", "deadpan": "dry",
    "softly": "tender", "gently": "tender", "tenderly": "tender", "fondly": "tender", "lovingly": "tender",
    "stubbornly": "tense", "tensely": "tense", "stiffly": "tense", "firmly": "tense", "nervously": "tense",
    "warmly": "warm", "kindly": "warm", "cheerfully": "warm", "cheerful": "warm",
    "amusedly": "amused", "laughing": "amused", "playfully": "amused", "playful": "amused",
    "urgently": "urgent", "hurriedly": "urgent", "anxiously": "urgent", "frantic": "urgent", "frantically": "urgent",
    "angrily": "angry", "furious": "angry", "furiously": "angry", "sharply": "angry", "bitterly": "angry",
    "fearful": "afraid", "fearfully": "afraid", "scared": "afraid", "frightened": "afraid", "terrified": "afraid",
    "sadly": "sad", "mournfully": "sad", "grieving": "sad", "somber": "sad", "sombre": "sad",
    "wearily": "weary", "tired": "weary", "exhausted": "weary",
    "boisterously": "boisterous", "jovial": "boisterous", "jovially": "boisterous", "expansive": "boisterous",
    "flatly": "neutral", "evenly": "neutral", "calmly": "neutral",
}

# Sound notes the model puts where a direction goes; they say nothing about the voice.
IGNORED: frozenset[str] = frozenset({"reverberating", "echoing", "distant", "muffled", "over the phone", "on the phone"})

INTENSITY_WORDS: dict[str, int] = {"a little": 1, "slightly": 1, "very": 3, "really": 3}
DEFAULT_INTENSITY = 2

PACE_WORDS: dict[str, str] = {"slow": "slow", "slowly": "slow", "quick": "quick", "quickly": "quick", "fast": "quick"}

# Inline non-verbals stay in the text: the engines voice them.
NONVERBALS: frozenset[str] = frozenset(
    {"laughs", "chuckle", "chuckles", "sighs", "clears throat", "coughs", "gasps", "inhales", "exhales", "sniffs", "groans"}
)

_SPACE = re.compile(r"\s+")


@dataclass(frozen=True)
class Direction:
    """A parsed direction. `status` is `ok`, `mapped` (a synonym), `ignored` (a sound note) or `unknown`."""

    raw: str
    emotion: str | None
    intensity: int
    pace: str | None
    status: str
    mapped: dict[str, str] = field(default_factory=dict)
    ignored: tuple[str, ...] = ()
    unknown: tuple[str, ...] = ()

    def as_body(self) -> dict[str, object]:
        return {
            "raw": self.raw,
            "emotion": self.emotion,
            "intensity": self.intensity,
            "pace": self.pace,
            "status": self.status,
            "mapped": self.mapped,
            "ignored": list(self.ignored),
            "unknown": list(self.unknown),
        }


def _normal(text: str) -> str:
    return _SPACE.sub(" ", text.strip().lower())


def is_nonverbal(inner: str) -> bool:
    return _normal(inner) in NONVERBALS


def parse_direction(inner: str) -> Direction:
    """Parse the inside of one leading parenthetical against the vocabulary."""
    emotion: str | None = None
    intensity = DEFAULT_INTENSITY
    pace: str | None = None
    mapped: dict[str, str] = {}
    ignored: list[str] = []
    unknown: list[str] = []

    for part in (_normal(p) for p in inner.split(",")):
        if not part:
            continue
        if part in INTENSITY_WORDS:
            intensity = INTENSITY_WORDS[part]
            continue
        if part in PACE_WORDS:
            pace = PACE_WORDS[part]
            continue
        word = part
        # "a little amused", "very tense": the intensity rides on the emotion word.
        for prefix, level in INTENSITY_WORDS.items():
            if word.startswith(prefix + " "):
                intensity, word = level, word[len(prefix) + 1 :]
                break
        if word in EMOTIONS:
            emotion = word
        elif word in SYNONYMS:
            emotion = SYNONYMS[word]
            mapped[word] = emotion
        elif word in IGNORED:
            ignored.append(word)
        else:
            unknown.append(word)

    status = "unknown" if unknown else "ignored" if ignored and emotion is None else "mapped" if mapped else "ok"
    return Direction(
        raw=inner.strip(),
        emotion=emotion,
        intensity=intensity,
        pace=pace,
        status=status,
        mapped=mapped,
        ignored=tuple(ignored),
        unknown=tuple(unknown),
    )
