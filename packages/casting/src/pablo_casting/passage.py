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

PASSAGE_ID = "audition-v1"

PASSAGE = (
    "The morning train left the valley at a quarter past six, as it does every day. "
    "I counted the crates twice, and the numbers were still wrong; they usually are. "
    "Come in out of the cold, sit by the stove, and tell me everything that happened. "
    "Listen to me: the bridge is going, and we have five minutes to get everyone across! "
    "When it was over, the river was quiet again, and the lamps came on along the road."
)

PASSAGE_SHA256 = hashlib.sha256(PASSAGE.encode("utf-8")).hexdigest()


def passage_words(text: str = PASSAGE) -> list[str]:
    """The passage's words, lowercased and stripped of punctuation (what an aligner matches)."""
    return [word for word in re.findall(r"[a-z0-9']+", text.lower())]
