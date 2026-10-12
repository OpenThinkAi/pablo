"""Numerals spelled out for the engines (AGT-1789)."""

from __future__ import annotations

import pytest

from pablo_casting.engines import dia_text, turbo_text
from pablo_casting.numerals import cardinal, ordinal, spell_numbers, year


@pytest.mark.parametrize(
    ("text", "spoken"),
    [
        ("the vintage of 1912.", "the vintage of nineteen twelve."),
        ("built in 1905", "built in nineteen oh five"),
        ("by 1900,", "by nineteen hundred,"),
        ("in 2026", "in twenty twenty-six"),
        ("in 2005", "in two thousand five"),
        ("3,000 barrels", "three thousand barrels"),
        ("120 steps", "one hundred twenty steps"),
        ("Chapter 7:", "Chapter seven:"),
        ("the 3rd row", "the third row"),
        ("her 21st", "her twenty-first"),
        ("1.5 miles", "one point five miles"),
        ("$40 each", "forty dollars each"),
        ("50% of it", "fifty percent of it"),
        ("no numbers here", "no numbers here"),
    ],
)
def test_spell_numbers(text: str, spoken: str) -> None:
    assert spell_numbers(text) == spoken


def test_words_helpers() -> None:
    assert cardinal(0) == "zero"
    assert cardinal(1_002_003) == "one million two thousand three"
    assert year(1999) == "nineteen ninety-nine"
    assert ordinal(12) == "twelfth"
    assert ordinal(40) == "fortieth"


def test_the_engines_read_numerals_as_words_and_the_script_keeps_its_digits() -> None:
    line = "We barely touched the 1912."
    assert turbo_text(line) == "We barely touched the nineteen twelve."
    assert "nineteen twelve" in dia_text([("A", line)], {"A": "[S1]"})
