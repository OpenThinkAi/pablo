"""The words and tail gates: what Whisper heard against the script line.

Ported from the radio prototype's `check_take` (`radio/produce.py:243-296` in
the Valley's Shadow sandbox), then made spelling-blind (AGT-1789). The
prototype compared Whisper's spelling to the script's, so a line whose last
words Whisper writes its own way failed the tail check on every take, whatever
the audio did: "a piece" heard as "apiece", "two thousand" as "2,000", a name
heard as a homophone ("Kora", "Quora") or run together ("Montesiena"). Now both
sides are normalised before they are aligned:

- **case and punctuation**: lower-cased; bracketed direction dropped; hyphens
  and dashes split words; apostrophes kept inside a word only;
- **numbers**: digits and number words become one canonical value either way
  ("2,000" = "two thousand", "a hundred and fifty" = "150", "1917" =
  "nineteen seventeen"), and count as the one word they are;
- **spelling**: words are compared by a sound-alike key (c/k/q, ph/f, x/ks,
  z/s, doubled letters), so "Pells"/"Pels" and "Sienna"/"Siena" are one word;
- **compounds**: inside a mismatch, two or three words on one side may equal
  one on the other when their keys joined are equal ("a piece" = "apiece");
- **names**: a script word written with a capital is a likely name, and may
  also match a heard word whose key is close (`difflib` ratio >= 0.75, four
  letters or more): Whisper's guess at a name it has never seen.

What it measures (the judgement is `gates.py`'s, with thresholds from the
card): the word error rate (edit distance over the script's word count, after
the matches above), the longest run of inserted words, whether the last two
script words were heard (`tail_ok`), and where Whisper heard the last script
word end (`word_end`; the take's finishing, `ending.py`, never cuts before it).

Pure Python: no model, no numpy, so the default test run covers it.
"""

from __future__ import annotations

import difflib
import re
from collections.abc import Sequence
from dataclasses import dataclass

UNITS = {
    w: n
    for n, w in enumerate(
        "zero one two three four five six seven eight nine ten eleven twelve thirteen "
        "fourteen fifteen sixteen seventeen eighteen nineteen".split()
    )
}
TENS = {w: 10 * n for n, w in enumerate("twenty thirty forty fifty sixty seventy eighty ninety".split(), start=2)}
SCALES = {"hundred": 100, "thousand": 1000, "million": 1_000_000}
NAME_RATIO = 0.75
NAME_MIN_LETTERS = 4


@dataclass(frozen=True)
class Heard:
    """One word Whisper heard, with its timing in seconds."""

    word: str
    start: float
    end: float


@dataclass(frozen=True)
class Token:
    """One normalised word: its text, sound-alike key, whether the script capitalised it, and its source index."""

    text: str
    key: str
    name: bool = False
    source: int = 0


def _raw_words(text: str) -> list[tuple[str, bool]]:
    """(lower-cased word, capitalised) pairs: direction dropped, digit groups joined, hyphens split."""
    text = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", text)
    text = re.sub(r"(?<=\d),(?=\d{3}\b)", "", text)
    text = re.sub(r"[-‐-―]", " ", text)
    out: list[tuple[str, bool]] = []
    for word in re.findall(r"[^\W_]+(?:['’][^\W_]+)*", text):
        lower = word.lower().replace("’", "'")
        out.append((lower, word[0].isupper() and lower != "i"))
    return out


def _is_number_word(words: Sequence[tuple[str, bool]], k: int) -> bool:
    word = words[k][0]
    if word in UNITS or word in TENS or word in SCALES:
        return True
    nxt = words[k + 1][0] if k + 1 < len(words) else ""
    prev = words[k - 1][0] if k > 0 else ""
    if word == "a" and nxt in SCALES:
        return True
    if word == "and" and (prev in UNITS or prev in TENS or prev in SCALES) and (nxt in UNITS or nxt in TENS):
        return True
    return False


def _number_values(run: Sequence[str]) -> list[int]:
    """The value(s) a run of number words says: one number, a year ("nineteen seventeen"), or several in a row."""
    if any(w in SCALES for w in run):
        total, current = 0, 0
        for w in run:
            if w == "a":
                current = 1
            elif w in UNITS or w in TENS:
                current += UNITS.get(w, TENS.get(w, 0))
            elif w == "hundred":
                current = max(current, 1) * 100
            elif w in SCALES:
                total += max(current, 1) * SCALES[w]
                current = 0
        return [total + current]
    groups: list[int] = []
    for w in run:
        if w == "and":
            continue
        value = UNITS.get(w, TENS.get(w, 0))
        if groups and w in UNITS and value < 10 and groups[-1] % 10 == 0 and 20 <= groups[-1] < 100:
            groups[-1] += value  # "twenty" "six" -> 26
        else:
            groups.append(value)
    if len(groups) == 2 and 10 <= groups[0] < 100 and groups[1] < 100 and groups[1] != 0:
        return [groups[0] * 100 + groups[1]]  # a year: "nineteen seventeen"
    return groups


def sound_key(word: str) -> str:
    """A sound-alike key: c/k/q, ph/f, x/ks, z/s and doubled letters folded; numbers as they are."""
    s = word.replace("'", "")
    if s.isdigit():
        return s
    s = s.replace("ph", "f").replace("qu", "k").replace("ck", "k").replace("wh", "w")
    s = re.sub(r"c(?=[eiy])", "s", s).replace("c", "k")
    s = s.replace("x", "ks").replace("z", "s")
    return re.sub(r"(.)\1+", r"\1", s)


def tokens(text: str) -> list[Token]:
    """The normalised words of `text`, numbers canonical (see the module docstring)."""
    return _tokenise(_raw_words(text))


def _tokenise(words: Sequence[tuple[str, bool]]) -> list[Token]:
    """Tokens from raw words; a token's `source` is the index of the last raw word it came from."""
    out: list[Token] = []
    k = 0
    while k < len(words):
        if _is_number_word(words, k):
            j = k
            while j < len(words) and _is_number_word(words, j):
                j += 1
            for value in _number_values([w for w, _ in words[k:j]]):
                out.append(Token(str(value), str(value), False, j - 1))
            k = j
            continue
        word, cap = words[k]
        if word.isdigit() and len(word) > 1:
            word = str(int(word))
        out.append(Token(word.strip("'"), sound_key(word.strip("'")), cap, k))
        k += 1
    return out


def norm_words(text: str) -> list[str]:
    """The normalised words of `text` (direction dropped, numbers canonical)."""
    return [t.text for t in tokens(text)]


def script_word_count(text: str) -> int:
    """Words a reader says, for pace: bracketed direction dropped, numbers counted."""
    return len(re.sub(r"\([^)]*\)", " ", text).split())


def _same(expected: Sequence[Token], said: Sequence[Token]) -> bool:
    """Whether a span of script words and a span of heard words are the same words (see the module docstring)."""
    left = "".join(t.key for t in expected)
    right = "".join(t.key for t in said)
    if left == right:
        return True
    if any(t.name for t in expected) and len(left) >= NAME_MIN_LETTERS and len(right) >= NAME_MIN_LETTERS - 1:
        if not left.isdigit() and not right.isdigit():
            return difflib.SequenceMatcher(None, left, right, autojunk=False).ratio() >= NAME_RATIO
    return False


_SPANS = ((1, 1), (2, 1), (1, 2), (3, 1), (1, 3), (2, 2))


def _resolve(expected: Sequence[Token], said: Sequence[Token]) -> list[tuple[list[int], list[int]]]:
    """Matches inside one mismatched block: greedy, left to right, one-to-one before compounds."""
    groups: list[tuple[list[int], list[int]]] = []
    i = j = 0
    while i < len(expected) and j < len(said):
        for a, b in _SPANS:
            if i + a <= len(expected) and j + b <= len(said) and _same(expected[i : i + a], said[j : j + b]):
                groups.append((list(range(i, i + a)), list(range(j, j + b))))
                i, j = i + a, j + b
                break
        else:
            left, right = len(expected) - i, len(said) - j
            if left > right:
                i += 1
            elif right > left:
                j += 1
            else:
                i, j = i + 1, j + 1
    return groups


def _edit_distance(a: Sequence[str], b: Sequence[str]) -> int:
    previous = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        current = [i]
        for j, y in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (x != y)))
        previous = current
    return previous[-1]


def _join_digit_groups(heard: Sequence[Heard]) -> list[Heard]:
    """Whisper splits "2,000" into " 2" and ",000": one heard word again, spanning both."""
    out: list[Heard] = []
    for h in heard:
        if out and re.match(r"^\s*[,.]\d", h.word) and re.search(r"\d\s*$", out[-1].word):
            prev = out.pop()
            h = Heard(prev.word.rstrip() + h.word.strip(), prev.start, h.end)
        out.append(h)
    return out


def words_check(line: str, heard: Sequence[Heard]) -> dict[str, object]:
    """Measures `heard` against the script `line`.

    Returns `wer` (0.0 is perfect; can exceed 1.0 on a runaway take),
    `inserted_span` (the longest run of heard words the script does not have),
    `tail_ok` (the last two script words were heard), `word_end` (seconds:
    where the last script word ends, or `None` when it was not heard) and
    `ratio` (`SequenceMatcher` over the normalised words, for comparison).
    """
    expected = tokens(line)
    # Heard words are tokenised as one run, so a number Whisper wrote as words across several is one value.
    joined = _join_digit_groups(heard)
    raw: list[tuple[str, bool]] = []
    owner: list[int] = []
    for index, h in enumerate(joined):
        for word in _raw_words(h.word):
            raw.append(word)
            owner.append(index)
    said = _tokenise(raw)
    spans = [joined[owner[t.source]] for t in said]
    if not expected:
        return {"wer": 0.0, "inserted_span": len(said), "tail_ok": True, "word_end": None, "ratio": 1.0}

    matcher = difflib.SequenceMatcher(None, [t.key for t in expected], [t.key for t in said], autojunk=False)
    groups: list[tuple[list[int], list[int]]] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            groups.extend(([i1 + k], [j1 + k]) for k in range(i2 - i1))
        elif tag == "replace":
            for es, ss in _resolve(expected[i1:i2], said[j1:j2]):
                groups.append(([i1 + e for e in es], [j1 + s for s in ss]))

    # What was heard, with every matched span spelled as the script spells it.
    match: dict[int, int] = {}
    first_of: dict[int, list[int]] = {}
    absorbed: set[int] = set()
    for es, ss in groups:
        for e in es:
            match[e] = ss[-1]
        first_of[ss[0]] = es
        absorbed.update(ss[1:])
    heard_as: list[str] = []
    for j, token in enumerate(said):
        if j in first_of:
            heard_as.extend(expected[e].key for e in first_of[j])
        elif j not in absorbed:
            heard_as.append(token.key)
    want = [t.key for t in expected]

    inserted = 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, want, heard_as, autojunk=False).get_opcodes():
        if tag == "insert":
            inserted = max(inserted, j2 - j1)
        elif tag == "replace":
            inserted = max(inserted, (j2 - j1) - (i2 - i1))

    last = len(expected) - 1
    tail_ok = all(i in match for i in range(max(0, len(expected) - 2), len(expected)))
    return {
        "wer": round(_edit_distance(want, heard_as) / len(expected), 4),
        "inserted_span": inserted,
        "tail_ok": tail_ok,
        "word_end": round(spans[match[last]].end, 3) if last in match else None,
        "ratio": round(difflib.SequenceMatcher(None, want, heard_as, autojunk=False).ratio(), 4),
    }
