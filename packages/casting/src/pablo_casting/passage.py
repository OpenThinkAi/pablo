"""The shared audition passage every candidate voice reads.

One fixed text, about 25-30 s at a radio pace (2.7-3.0 words/s), with a
neutral, a dry, a warm and an urgent sentence so a voice is heard across
registers, then a quiet close (design: "Casting flow"). Every candidate of
every role reads the same words, so candidates and library voices are
comparable, and the card's `reference.txt` is this text.

The passage is part of a card's provenance: changing a word changes
`PASSAGE_SHA256`, which every audition records.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

PASSAGE_ID = "audition-v1"

PASSAGE = (
    "The morning train left the valley at a quarter past six, as it does every day. "
    "I counted the crates twice, and the numbers were still wrong; they usually are. "
    "Come in out of the cold, sit by the stove, and tell me everything that happened. "
    "Listen to me: the bridge is going, and we have five minutes to get everyone across! "
    "When it was over, the river was quiet again, and the lamps came on along the road."
)

PASSAGE_SHA256 = hashlib.sha256(PASSAGE.encode("utf-8")).hexdigest()

DEFAULT_LANGUAGE = "en"

PASSAGE_ES = (
    "El tren de la mañana salió del valle a las seis y cuarto, como todos los días. "
    "Conté las cajas dos veces y los números seguían mal; casi siempre lo están. "
    "Pase, salga del frío, siéntese junto a la estufa y cuénteme todo lo que pasó. "
    "Escúcheme: el puente se está cayendo y tenemos cinco minutos para cruzar a todos. "
    "Cuando terminó, el río volvió a quedarse quieto y se encendieron las lámparas del camino."
)


@dataclass(frozen=True)
class Passage:
    language: str
    id: str
    text: str

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.text.encode("utf-8")).hexdigest()


PASSAGES: dict[str, Passage] = {
    "en": Passage("en", PASSAGE_ID, PASSAGE),
    "es": Passage("es", "audition-v1-es", PASSAGE_ES),
}
"""One audition passage per language; a voice designed reading its own language keeps that accent when cloned."""


def passage_for(language: str) -> Passage:
    return PASSAGES[language]


def passage_by_sha(sha256: object) -> Passage | None:
    """The known passage with this hash, or None (an unknown passage is never a card's reference)."""
    return next((p for p in PASSAGES.values() if p.sha256 == sha256), None)


def passage_words(text: str = PASSAGE) -> list[str]:
    """The passage's words, lowercased and stripped of punctuation (what an aligner matches)."""
    return [word for word in re.findall(r"[a-z0-9']+", text.lower())]
