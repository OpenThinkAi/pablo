"""Numerals spelled out for the engines (AGT-1789).

A TTS engine reads "1917" however its tokenizer splits it, and Turbo has been
heard stumbling on one at the end of a line. The script keeps its digits; only
the engine's input is spelled: years the way a year is said ("1917" ->
"nineteen seventeen", "1905" -> "nineteen oh five", "1900" -> "nineteen
hundred"), other whole numbers as cardinals ("2,000" -> "two thousand"),
ordinals ("3rd" -> "third"), decimals ("1.5" -> "one point five"), dollars
("$40" -> "forty dollars") and percentages ("50%" -> "fifty percent").

Spoken forms (AGT-2302), applied before single numerals:

- Ranges: `a-b` or `a–b` (hyphen or en dash, optional spaces) between two
  numbers, `$` and `%` on either side. When a < b it is "a to b" with the unit
  once at the end ("10-20%" and "10%-20%" -> "ten to twenty percent", "$5-10"
  -> "five to ten dollars"); a 4-digit year then a 2-digit end past the year's
  last two digits is a year range ("2025-26" -> "twenty twenty-five to
  twenty-six"); when a >= b it is a score or a pair ("120-119" -> "one hundred
  twenty, one hundred nineteen"). A three-part date (2025-05-28) and a number
  after a word (COVID-19) are left alone.
- A minus sign: "-7.66" after whitespace, a line start or "(" -> "minus seven
  point six six". A hyphen between words or numbers is never a minus.
- Leading-dot decimals: ".376" not after a digit or word character -> "point
  three seven six".

`spell_numbers(text, spoken_forms=False)` is the spelling from before
AGT-2302, which `engines.spoken_params` compares against so only the take keys
of lines these forms change move.

Pure Python, no model.
"""

from __future__ import annotations

import re
from collections.abc import Callable

ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
_SCALES = ((1_000_000_000, "billion"), (1_000_000, "million"), (1000, "thousand"))
_ORDINAL = {
    "one": "first", "two": "second", "three": "third", "five": "fifth", "eight": "eighth",
    "nine": "ninth", "twelve": "twelfth",
}


def under_hundred(n: int) -> str:
    if n < 20:
        return ONES[n]
    tens, ones = divmod(n, 10)
    return _TENS[tens] + (f"-{ONES[ones]}" if ones else "")


def _under_thousand(n: int) -> str:
    hundreds, rest = divmod(n, 100)
    parts = [f"{ONES[hundreds]} hundred"] if hundreds else []
    if rest or not parts:
        parts.append(under_hundred(rest))
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
        return f"{under_hundred(high)} hundred"
    if low < 10:
        return f"{under_hundred(high)} oh {ONES[low]}"
    return f"{under_hundred(high)} {under_hundred(low)}"


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

# One number inside a range: grouped thousands or digits, an optional decimal part.
_NUM = r"(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?"
_RANGE = re.compile(
    r"(?<![\w.\-–$])(\$)?" + _NUM + r"(%)?[ \t]*[-–][ \t]*(\$)?" + _NUM + r"(%)?(?![\w%]|[-–]\d|\.\d)"
)
# A numeral with the spoken forms (AGT-2302): `_NUMBER`, plus a minus sign after whitespace, a line start or "(",
# and a leading-dot decimal (".376"). Without a sign it starts where `_NUMBER` may.
_SIGNED = re.compile(
    r"(?:(?:^|(?<=[\s(]))([-−])|(?<![\w.]))(\$)?(?:(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?|\.(\d+))(st|nd|rd|th)?(%)?(?![\w])",
    re.M,
)

Changes = list[tuple[str, str]]
"""Where a normaliser records what it changed, `(as written, as spoken)`, for `pablo pronounce`."""


def recorded(fn: Callable[[re.Match[str]], str], changes: Changes | None) -> Callable[[re.Match[str]], str]:
    def sub(match: re.Match[str]) -> str:
        out = fn(match)
        if changes is not None and out != match.group(0):
            changes.append((match.group(0), out))
        return out

    return sub


def _digits(fraction: str) -> str:
    return " ".join(ONES[int(d)] for d in fraction)


def _number_words(whole: str, fraction: str | None, as_year: bool = True) -> str:
    """One number as said, without its unit: a year when it reads as one (and `as_year`), else a cardinal, with its decimals."""
    digits = whole.replace(",", "")
    n = int(digits)
    if fraction:
        return f"{cardinal(n)} point {_digits(fraction)}"
    if as_year and "," not in whole and _is_year(digits):
        return year(n)
    return cardinal(n)


def _value(whole: str, fraction: str | None) -> float:
    return float(whole.replace(",", "") + (f".{fraction}" if fraction else ""))


def _unit(dollar: bool, percent: bool, n: float) -> str:
    if dollar:
        return " dollar" if n == 1 else " dollars"
    return " percent" if percent else ""


def _spell_range(match: re.Match[str]) -> str:
    d1, w1, f1, p1, d2, w2, f2, p2 = match.groups()
    a, b = _value(w1, f1), _value(w2, f2)
    dollar, percent = bool(d1 or d2), bool(p1 or p2)
    plain = not dollar and not percent
    a_digits, b_digits = w1.replace(",", ""), w2.replace(",", "")
    if plain and not f1 and not f2 and len(a_digits) == 4 and "," not in w1 and len(w2) == 2 and int(b_digits) > int(a_digits) % 100:
        # A year range: "2025-26", "1996-97".
        start = _number_words(w1, None)
        end = int(b_digits)
        return f"{start} to {('oh ' + ONES[end]) if end < 10 else under_hundred(end)}"
    if a < b:
        return f"{_number_words(w1, f1, plain)} to {_number_words(w2, f2, plain)}{_unit(dollar, percent, b)}"
    # A score or a pair: each side as itself, with its own unit.
    first = _number_words(w1, f1, not d1 and not p1) + _unit(bool(d1), bool(p1), a)
    second = _number_words(w2, f2, not d2 and not p2) + _unit(bool(d2), bool(p2), b)
    return f"{first}, {second}"


def _spell_one(dollar: str | None, whole: str | None, fraction: str | None, suffix: str | None, percent: str | None) -> str:
    if whole is None:  # a leading-dot decimal
        return f"point {_digits(fraction or '')}" + (" percent" if percent else "")
    digits = whole.replace(",", "")
    n = int(digits)
    if suffix and not fraction:
        words = ordinal(n)
    elif fraction:
        words = f"{cardinal(n)} point {_digits(fraction)}"
    elif "," not in whole and not dollar and not percent and _is_year(digits):
        words = year(n)
    else:
        words = cardinal(n)
    if dollar:
        words += " dollar" if n == 1 and not fraction else " dollars"
    if percent:
        words += " percent"
    return words


def spell_numbers(text: str, spoken_forms: bool = True, changes: Changes | None = None) -> str:
    """`text` with every numeral spelled out (see the module docstring).

    `spoken_forms=False` skips the ranges, minus signs and leading-dot decimals (the spelling before AGT-2302).
    `changes`, when given, gets each `(numeral, words)` replaced.
    """
    if not spoken_forms:
        return _NUMBER.sub(recorded(lambda m: _spell_one(*m.groups()), changes), text)

    def signed(match: re.Match[str]) -> str:
        sign, dollar, whole, fraction, dot, suffix, percent = match.groups()
        words = _spell_one(dollar, whole, fraction if whole is not None else dot, suffix, percent)
        return f"minus {words}" if sign else words

    text = _RANGE.sub(recorded(_spell_range, changes), text)
    return _SIGNED.sub(recorded(signed, changes), text)
