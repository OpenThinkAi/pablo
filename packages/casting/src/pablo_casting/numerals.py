"""Numerals spelled out for the engines (AGT-1789).

A TTS engine reads "1917" however its tokenizer splits it, and Turbo has been
heard stumbling on one at the end of a line. The script keeps its digits; only
the engine's input is spelled: years the way a year is said ("1917" ->
"nineteen seventeen", "1905" -> "nineteen oh five", "1900" -> "nineteen
hundred"), other whole numbers as cardinals ("2,000" -> "two thousand"),
ordinals ("3rd" -> "third"), decimals ("1.5" -> "one point five"), dollars
("$40" -> "forty dollars") and percentages ("50%" -> "fifty percent").

Pure Python, no model.
"""

from __future__ import annotations

import re

_ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
_SCALES = ((1_000_000_000, "billion"), (1_000_000, "million"), (1000, "thousand"))
_ORDINAL = {
    "one": "first", "two": "second", "three": "third", "five": "fifth", "eight": "eighth",
    "nine": "ninth", "twelve": "twelfth",
}


def _under_hundred(n: int) -> str:
    if n < 20:
        return _ONES[n]
    tens, ones = divmod(n, 10)
    return _TENS[tens] + (f"-{_ONES[ones]}" if ones else "")


def _under_thousand(n: int) -> str:
    hundreds, rest = divmod(n, 100)
    parts = [f"{_ONES[hundreds]} hundred"] if hundreds else []
    if rest or not parts:
        parts.append(_under_hundred(rest))
    return " ".join(parts)


def cardinal(n: int) -> str:
    """`n` in words: 2000 -> "two thousand", 150 -> "one hundred fifty"."""
    if n < 0:
        return "minus " + cardinal(-n)
    if n < 1000:
        return _under_thousand(n)
    parts: list[str] = []
    for value, name in _SCALES:
        if n >= value:
            count, n = divmod(n, value)
            parts.append(f"{cardinal(count)} {name}")
    if n:
        parts.append(_under_thousand(n))
    return " ".join(parts)


def year(n: int) -> str:
    """A year as said: 1917 -> "nineteen seventeen", 1905 -> "nineteen oh five", 1900 -> "nineteen hundred"."""
    high, low = divmod(n, 100)
    if low == 0:
        return f"{_under_hundred(high)} hundred"
    if low < 10:
        return f"{_under_hundred(high)} oh {_ONES[low]}"
    return f"{_under_hundred(high)} {_under_hundred(low)}"


def ordinal(n: int) -> str:
    words = cardinal(n)
    head, _, last = words.rpartition(" ")
    hyphen_head, dash, last_part = last.rpartition("-")
    if last_part in _ORDINAL:
        spoken = _ORDINAL[last_part]
    elif last_part.endswith("y"):
        spoken = last_part[:-1] + "ieth"
    else:
        spoken = last_part + "th"
    last = f"{hyphen_head}{dash}{spoken}"
    return f"{head} {last}".strip()


def _is_year(digits: str) -> bool:
    n = int(digits)
    return len(digits) == 4 and (1100 <= n <= 1999 or 2010 <= n <= 2099)


_NUMBER = re.compile(r"(?<![\w.])(\$)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(st|nd|rd|th)?(%)?(?![\w])")


def spell_numbers(text: str) -> str:
    """`text` with every numeral spelled out (see the module docstring)."""

    def spell(match: re.Match[str]) -> str:
        dollar, whole, fraction, suffix, percent = match.groups()
        digits = whole.replace(",", "")
        n = int(digits)
        if suffix and not fraction:
            words = ordinal(n)
        elif fraction:
            words = f"{cardinal(n)} point {' '.join(_ONES[int(d)] for d in fraction)}"
        elif "," not in whole and not dollar and not percent and _is_year(digits):
            words = year(n)
        else:
            words = cardinal(n)
        if dollar:
            words += " dollar" if n == 1 and not fraction else " dollars"
        if percent:
            words += " percent"
        return words

    return _NUMBER.sub(spell, text)
