"""The words and tail gates: what Whisper heard against the script line.

Ported from the radio prototype's `check_take` (`radio/produce.py:243-296` in
the Valley's Shadow sandbox): the same normalisation (lower-case, bracketed
direction dropped, hyphens split, numbers ignored because Whisper returns them
as digits or words either way), the same `difflib` alignment for the tail check
and the cut point. What changed from the prototype:

- the pass/fail judgement moved to `gates.py`, with thresholds from the card;
  this module only measures;
- the text match is reported as a word error rate (edit distance over the
  script's word count) rather than `SequenceMatcher.ratio()`, because the
  design's gate is "WER <= 5%";
- the longest run of inserted words is measured, for "no inserted span > 2
  words";
- only one line is judged at a time (turn starts are the perform ticket's).

Pure Python: no model, no numpy, so the default test run covers it.
"""

from __future__ import annotations

import difflib
import re
from collections.abc import Sequence
from dataclasses import dataclass

NUMBERISH = re.compile(
    r"^(\d[\d,.]*|one|two|three|four|five|six|seven|eight|nine|ten|"
    r"eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|"
    r"eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|"
    r"eighty|ninety|hundred|thousand|and)$"
)

# Seconds of air kept after the last scripted word when trimming a take.
TAIL_AIR = 0.18


def norm_words(text: str) -> list[str]:
    """The prototype's normalisation: bracketed direction dropped, numbers ignored."""
    text = re.sub(r"\([^)]*\)", " ", text.lower())
    words = re.findall(r"[a-z0-9']+", text.replace("-", " "))
    return [w.strip("'") for w in words if not NUMBERISH.match(w)]


def script_word_count(text: str) -> int:
    """Words a reader says, for pace: bracketed direction dropped, numbers counted."""
    return len(re.sub(r"\([^)]*\)", " ", text).split())


@dataclass(frozen=True)
class Heard:
    """One word Whisper heard, with its timing in seconds."""

    word: str
    start: float
    end: float


def _edit_distance(a: Sequence[str], b: Sequence[str]) -> int:
    previous = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        current = [i]
        for j, y in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (x != y)))
        previous = current
    return previous[-1]


def words_check(line: str, heard: Sequence[Heard]) -> dict[str, object]:
    """Measures `heard` against the script `line`.

    Returns `wer` (0.0 is perfect; can exceed 1.0 on a runaway take),
    `inserted_span` (the longest run of heard words the script does not have),
    `tail_ok` (the last two script words were heard), `cut` (seconds: the end
    of the last script word plus `TAIL_AIR`, or `None` when it was not heard),
    and `ratio` (the prototype's `SequenceMatcher` ratio, kept for comparison).
    """
    expected = norm_words(line)
    tokens: list[Heard] = [Heard(tok, h.start, h.end) for h in heard for tok in norm_words(h.word)]
    said = [h.word for h in tokens]
    if not expected:
        return {"wer": 0.0, "inserted_span": len(said), "tail_ok": True, "cut": None, "ratio": 1.0}

    matcher = difflib.SequenceMatcher(None, expected, said, autojunk=False)
    match: dict[int, int] = {}
    for a, b, size in matcher.get_matching_blocks():
        for j in range(size):
            match[a + j] = b + j

    inserted = 0
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "insert":
            inserted = max(inserted, j2 - j1)
        elif tag == "replace":
            inserted = max(inserted, (j2 - j1) - (i2 - i1))

    last = len(expected) - 1
    tail_ok = all(i in match for i in range(max(0, len(expected) - 2), len(expected)))
    cut = round(tokens[match[last]].end + TAIL_AIR, 3) if last in match else None
    return {
        "wer": round(_edit_distance(expected, said) / len(expected), 4),
        "inserted_span": inserted,
        "tail_ok": tail_ok,
        "cut": cut,
        "ratio": round(matcher.ratio(), 4),
    }
