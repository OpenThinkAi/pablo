"""The pronunciation lexicon and numerals-to-words (AGT-1798). Pure Python; the numerals themselves are test_numerals.py's."""

from __future__ import annotations

from pablo_casting.engines import dia_text, turbo_text
from pablo_casting.numerals import spell_numbers
from pablo_casting.lexicon import apply, params_for, parse, respelt_words
from pablo_casting.words import Heard, words_check

ENTRIES = parse(
    """# ep01
- Zinfandel -> zin-fan-DELL
CORA: reach → reech

not an entry
"""
)


def respelt(speaker: str, text: str, entries=ENTRIES) -> str:
    return turbo_text(text, speaker, params_for(entries, [(speaker, text)]).get("lexicon"))


def test_parse_reads_arrows_scopes_comments_and_bullets() -> None:
    assert [(e.speaker, e.word, e.respelling) for e in ENTRIES] == [(None, "zinfandel", "zin-fan-DELL"), ("CORA", "reach", "reech")]


def test_an_entry_changes_matching_words_only_keeping_punctuation_and_case_insensitive() -> None:
    assert respelt("MAVIS", 'Not "ZINFANDEL", surely? Zinfandel.') == 'Not "zin-fan-DELL", surely? zin-fan-DELL.'
    assert respelt("MAVIS", "Zinfandels and unzinfandel stay.") == "Zinfandels and unzinfandel stay."
    assert respelt("MAVIS", "Nothing to change here.") == "Nothing to change here."


def test_respelling_keeps_its_own_capitals_through_caps_normalisation() -> None:
    assert respelt("MAVIS", "I like ZINFANDEL.") == "I like zin-fan-DELL."


def test_speaker_scope_applies_only_to_that_speaker() -> None:
    assert respelt("CORA", "The heat can't reach.") == "The heat can't reech."
    assert respelt("OTTO", "The heat can't reach.") == "The heat can't reach."


def test_matching_entries_are_in_params_and_unrelated_ones_are_not() -> None:
    both = params_for(ENTRIES, [("CORA", "reach the Zinfandel")])
    only = params_for(ENTRIES, [("CORA", "Zinfandel")])
    assert both != only and "reech" in both["lexicon"] and "reech" not in only["lexicon"]
    assert params_for(ENTRIES, [("CORA", "nothing")]) == {}
    assert params_for(ENTRIES, [("OTTO", "reach")]) == {}
    assert params_for([], [("CORA", "reach")]) == {}


def test_a_changed_respelling_changes_the_param_so_the_take_key() -> None:
    a = params_for(parse("reach -> reech"), [("A", "reach")])
    b = params_for(parse("reach -> reetch"), [("A", "reach")])
    assert a != b


def test_dia_applies_the_lexicon_per_speaker() -> None:
    param = params_for(ENTRIES, [("CORA", "reach"), ("OTTO", "reach Zinfandel")])["lexicon"]
    text = dia_text([("CORA", "reach"), ("OTTO", "reach Zinfandel")], {"CORA": "[S1]", "OTTO": "[S2]"}, param)
    assert text == "[S1] reech [S2] reach zin-fan-DELL [S1] Mm."


def test_apply_is_a_noop_without_a_valid_param() -> None:
    assert apply(None, "A", "reach") == "reach"
    assert apply("not json", "A", "reach") == "reach"


def test_turbo_speaks_numerals_and_the_script_is_not_the_one_changed() -> None:
    text = "In 1917 it cost $40,000."
    assert turbo_text(text) == "In nineteen seventeen it cost forty thousand dollars."
    assert text == "In 1917 it cost $40,000."


def _heard(text: str) -> list[Heard]:
    return [Heard(w, i * 0.4, i * 0.4 + 0.3) for i, w in enumerate(text.split())]


def test_a_take_with_a_respelling_passes_the_words_gate_against_the_original_text() -> None:
    line = "I read the yield estimates for the Zinfandel."
    heard = _heard("I read the yield estimates for the Xin Fan Dalell.")
    assert words_check(line, heard)["wer"] > 0.05
    result = words_check(line, heard, ("zinfandel",))
    assert result["wer"] == 0.0 and result["tail_ok"] and result["inserted_span"] == 0


def test_respelt_tolerance_covers_only_that_word_not_the_rest_of_the_line() -> None:
    line = "I read the yield estimates for the Zinfandel."
    heard = _heard("I read a field estimate for the Xin Fan Dalell.")
    assert words_check(line, heard, ("zinfandel",))["wer"] > 0.05


def test_a_respelt_word_that_was_not_said_at_all_still_fails_the_tail() -> None:
    assert not words_check("Where the heat can't reach.", _heard("Where the heat can't"), ("reach",))["tail_ok"]


def test_respelt_words_come_from_the_take_param() -> None:
    assert respelt_words(params_for(ENTRIES, [("CORA", "reach the Zinfandel")])["lexicon"]) == ("reach", "zinfandel")
    assert respelt_words(None) == ()


def test_years_and_money_are_read_as_words_in_the_engine_input() -> None:
    assert spell_numbers("In 1917 it cost $40,000, again in 1919.") == "In nineteen seventeen it cost forty thousand dollars, again in nineteen nineteen."
    assert turbo_text("In 1917 it cost $40,000.") == "In nineteen seventeen it cost forty thousand dollars."
