"""The pronounce gate (AGT-2307): were the acronyms and respellings actually said?

Whisper writes "AI" whether the take said "ay eye", "eye" or "uh eye", so the
words gate passes all three. A phoneme recogniser hears the difference: its
transcription of a good take reads `ð æ t eɪ aɪ k ə d` ("that AI could"), of a
bad one `ð æ t aɪ k ə d`.

What a take must contain comes from its own inputs (`expectations`): every
acronym the engine was given as letters (`engines.normalise_caps` in acronym
mode, `AI` -> `A I`) is expected as its letter names (`LETTER_NAMES`, espeak
style: A `eɪ`, I `aɪ`, J `dʒ eɪ` ...), and every lexicon respelling with an IPA
field in `pronounce.md` (`AJ -> A J /eɪ dʒ eɪ/`) as that IPA. A respelling
without one is checked only when it is itself spelled letters (`A J`, `A.J.`);
otherwise nothing is expected of it (there is no grapheme-to-phoneme model here).

Matching (`check`) is tolerant on purpose and compares vowel nuclei: consonants
blur across letter boundaries and the recogniser drops or swaps them freely,
while the vowels are what tells "ay eye" from "eye". Each expected vowel must be
heard in order as a vowel of its class (`eɪ` accepts `e`, `eː`, `ɛɪ`; `iː`
accepts `i`, `ɪ` ...), with only consonants between consecutive vowels and no
more of them than the letter names have, plus one. A schwa (`ə`, `ɐ`, `ɚ`) never
stands in for a letter's vowel: "uh jay" (`ɐ dʒ eɪ`) is a miss for `AJ`. An
acronym used n times in a pass must be heard n times.

Pure Python: the recogniser is `scorers.PhonemeScorer`, behind the `Scorer`
interface, and the tests use a fake one.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass

from pablo_casting.engines import ACRONYMS_PARAM, ACRONYMS_VERSION, LEXICON_PARAM, as_letters, read_text

LETTER_NAMES: dict[str, str] = {
    "A": "eɪ", "B": "b iː", "C": "s iː", "D": "d iː", "E": "iː", "F": "ɛ f", "G": "dʒ iː", "H": "eɪ tʃ",
    "I": "aɪ", "J": "dʒ eɪ", "K": "k eɪ", "L": "ɛ l", "M": "ɛ m", "N": "ɛ n", "O": "oʊ", "P": "p iː",
    "Q": "k j uː", "R": "ɑːɹ", "S": "ɛ s", "T": "t iː", "U": "j uː", "V": "v iː", "W": "d ʌ b əl j uː",
    "X": "ɛ k s", "Y": "w aɪ", "Z": "z iː",
}  # fmt: skip
"""Each letter's name in the recogniser's (espeak's) IPA, US English."""

# Letters whose names have unstressed middle syllables a reader drops ("dub-yoo"): only the first and last vowel are
# required, with anything in between.
_LOOSE = frozenset({"W"})

_VOWEL_CHARS = "aeiouyæɐɑɒɔəɘɚɛɜɝɞɤɨɪʉʊʌøœɵᵻä"
_NUCLEUS = re.compile(f"[{_VOWEL_CHARS}][{_VOWEL_CHARS}ːˑ̃]*")
_MARKS = re.compile("[ˈˌ/\\[\\]0-9.]")

# Vowel classes: a nucleus (length and nasality stripped) -> its class.
_CLASSES: dict[str, str] = {
    **dict.fromkeys(("eɪ", "e", "ɛɪ", "ei", "e̞"), "EY"),
    **dict.fromkeys(("aɪ", "ai", "ɑɪ", "ʌɪ", "äɪ", "a", "ä", "aɪə", "aɪɚ"), "AY"),
    **dict.fromkeys(("i", "ɪ", "iə", "ie", "y"), "EE"),
    **dict.fromkeys(("ɛ", "æ", "ɛə"), "EH"),
    **dict.fromkeys(("oʊ", "o", "əʊ", "o̞", "ou"), "OH"),
    **dict.fromkeys(("u", "ʊ", "ʉ", "ju", "uə", "ʊə"), "OO"),
    **dict.fromkeys(("ɑ", "ɒ", "ɑɹ"), "AH"),
    **dict.fromkeys(("ɔ", "ɔɹ"), "AW"),
    **dict.fromkeys(("ə", "ɐ", "ɚ", "ɜ", "ɝ", "ʌ", "ɨ", "ᵻ", "ɘ", "əl"), "UH"),
    "ɔɪ": "OY",
    "aʊ": "OW",
}
# What a heard class may stand for: the class itself, plus a near neighbour where the recogniser wavers. A schwa (UH)
# stands only for an expected UH (the W's "dub"), never for a letter's full vowel.
_ACCEPTS: dict[str, frozenset[str]] = {
    "EH": frozenset({"EH", "EY"}),
    "OH": frozenset({"OH", "AW"}),
    "AH": frozenset({"AH", "AW"}),
}


def vowel_class(nucleus: str) -> str:
    """The class of a vowel nucleus (`eː` -> `EY`, `ɐ` -> `UH`); an unknown vowel is its own class."""
    bare = nucleus.replace("ː", "").replace("ˑ", "").replace("̃", "")
    return _CLASSES.get(bare, bare)


def _accepts(expected: str, heard: str) -> bool:
    return heard in _ACCEPTS.get(expected, frozenset({expected}))


@dataclass(frozen=True)
class Expectation:
    """One acronym or respelling a take must be heard to say: the script `token`, its `kind` and the IPA expected."""

    token: str
    kind: str  # "acronym" | "respelling"
    ipa: str
    letters: str | None = None  # the acronym's letters (`AI` for `AI's`), when it is one

    def as_body(self) -> dict[str, object]:
        return {"token": self.token, "kind": self.kind, "ipa": self.ipa}


def letters_ipa(letters: str) -> str:
    """The letter names of `letters` (`AJ` -> `eɪ dʒ eɪ`)."""
    return " ".join(LETTER_NAMES[c] for c in letters.upper() if c in LETTER_NAMES)


_SPELLED = re.compile(r"[A-Z](?:[\s.]+[A-Z])*\.?")


def _spelled_letters(respelling: str) -> str | None:
    """`A J` / `A.J.` -> `AJ`: a respelling that is itself spelled letters, else None."""
    text = respelling.strip()
    if _SPELLED.fullmatch(text) is None:
        return None
    letters = "".join(c for c in text if c.isalpha())
    return letters if len(letters) >= 2 else None


def ipa_map(entries: Iterable[object]) -> dict[tuple[str, str], str]:
    """`(speaker or "", word)` -> the IPA field of each lexicon entry that has one (`lexicon.Entry.ipa`)."""
    out: dict[tuple[str, str], str] = {}
    for entry in entries:
        ipa = getattr(entry, "ipa", None)
        if ipa:
            out[(getattr(entry, "speaker", None) or "", str(getattr(entry, "word", "")))] = str(ipa)
    return out


def _lexicon_rows(param: object) -> list[tuple[str, str, str]]:
    if not isinstance(param, str) or not param:
        return []
    try:
        rows = json.loads(param)
    except ValueError:
        return []
    return [(str(r[0]), str(r[1]), str(r[2])) for r in rows if isinstance(r, list) and len(r) == 3] if isinstance(rows, list) else []


def expectations(
    lines: Iterable[tuple[str, str]],
    params: Mapping[str, object],
    ipa: Mapping[tuple[str, str], str] | None = None,
) -> list[Expectation]:
    """What a take with these `(speaker, text)` lines and take-key `params` must be heard to say, in line order.

    Acronyms come from the pass's own engine input (`engines.read_text` with the take key's `acronyms` and
    `lexicon` params), so a take is held only to the letters its engine was actually given.
    """
    lexicon = params.get(LEXICON_PARAM)
    acronyms = params.get(ACRONYMS_PARAM) == ACRONYMS_VERSION
    rows = _lexicon_rows(lexicon)
    ipa = ipa or {}
    out: list[Expectation] = []
    for speaker, text in lines:
        changes: list[tuple[str, str]] = []
        read_text(text, speaker, lexicon, acronyms, changes)
        respellings = {(word, respelling): scope for scope, word, respelling in rows if not scope or scope == speaker.upper()}
        for before, after in changes:
            if acronyms and as_letters(before) == after:
                letters = re.match(r"[A-Z]+", before).group(0)  # type: ignore[union-attr]
                out.append(Expectation(before, "acronym", letters_ipa(letters), letters))
                continue
            scope = respellings.get((before.lower(), after))
            if scope is None:
                continue
            given = ipa.get((scope, before.lower())) or ipa.get(("", before.lower()))
            # The caps rule may have re-cased the word before the lexicon saw it (`AJ` -> `Aj`): name it as written.
            written = re.search(r"(?<![A-Za-z0-9'])" + re.escape(before) + r"(?![A-Za-z0-9])", text, re.I)
            token = written.group(0) if written else before
            if given:
                out.append(Expectation(token, "respelling", given))
            elif (spelled := _spelled_letters(after)) is not None:
                out.append(Expectation(token, "respelling", letters_ipa(spelled), spelled))
    return out


# --- matching -----------------------------------------------------------------------------


@dataclass(frozen=True)
class _Step:
    cls: str
    max_gap: int  # tokens allowed between the previous step's vowel and this one
    loose: bool  # the gap may hold vowels too (inside a loose letter)


def _tokens(ipa: str) -> list[str]:
    return [t for t in _MARKS.sub(" ", ipa).split() if t]


def _nucleus(token: str) -> str | None:
    found = _NUCLEUS.search(token)
    return found.group(0) if found else None


def _steps(expectation: Expectation) -> list[_Step]:
    """The vowels an expectation requires, each with how many tokens may sit between it and the one before."""
    if expectation.letters:
        units = [(_tokens(LETTER_NAMES[c]), c in _LOOSE) for c in expectation.letters.upper() if c in LETTER_NAMES]
    else:
        units = [(_tokens(expectation.ipa), False)]
    steps: list[_Step] = []
    gap = 0  # consonant tokens since the last required vowel
    for tokens, loose in units:
        vowels = [k for k, t in enumerate(tokens) if _nucleus(t) is not None]
        required = [vowels[0], vowels[-1]] if loose and len(vowels) > 1 else vowels
        last = -1
        for k, token in enumerate(tokens):
            if k in required:
                inner = loose and last >= 0
                steps.append(_Step(vowel_class(_nucleus(token) or token), gap + 1, inner))
                gap, last = 0, k
            else:
                gap += 1
    return steps


def heard_tokens(phonemes: str) -> list[str | None]:
    """The recogniser's transcription as a sequence of vowel classes, None for each consonant."""
    out: list[str | None] = []
    for token in phonemes.split():
        nucleus = _nucleus(token)
        out.append(None if nucleus is None else vowel_class(nucleus))
    return out


def _match_at(heard: Sequence[str | None], start: int, steps: Sequence[_Step]) -> int | None:
    """The index of the last vowel of a match whose first vowel is `heard[start]`, else None."""
    if not steps or heard[start] is None or not _accepts(steps[0].cls, heard[start]):  # type: ignore[arg-type]
        return None
    at = start
    for step in steps[1:]:
        found = None
        for k in range(at + 1, min(len(heard), at + 1 + step.max_gap + 1)):
            cls = heard[k]
            if cls is None:
                continue
            if _accepts(step.cls, cls):
                found = k
                break
            if not step.loose:
                return None  # a vowel that is not this step's: the letters were not said in a row
        if found is None:
            return None
        at = found
    return at


def count(phonemes: str, expectation: Expectation) -> int:
    """How many times, without overlap, the transcription holds the expectation."""
    heard = heard_tokens(phonemes)
    steps = _steps(expectation)
    if not steps:
        return 0
    found, k = 0, 0
    while k < len(heard):
        end = _match_at(heard, k, steps)
        if end is None:
            k += 1
        else:
            found += 1
            k = end + 1
    return found


def check(expected: Sequence[Expectation], phonemes: str) -> dict[str, object]:
    """The pronounce gate's measures for a transcription: each distinct expectation, how often it was needed and
    heard, and the tokens missed (`pronounce_missed`, empty when every one was heard often enough)."""
    groups: dict[str, list[Expectation]] = {}
    for item in expected:
        groups.setdefault(item.ipa, []).append(item)
    checked: list[dict[str, object]] = []
    missed: list[str] = []
    for ipa, items in groups.items():
        need, heard = len(items), count(phonemes, items[0])
        tokens = list(dict.fromkeys(item.token for item in items))
        checked.append({"token": "/".join(tokens), "kind": items[0].kind, "ipa": ipa, "need": need, "heard": heard})
        if heard < need:
            missed.append("/".join(tokens))
    return {"phonemes": phonemes, "pronounce": checked, "pronounce_missed": missed}
