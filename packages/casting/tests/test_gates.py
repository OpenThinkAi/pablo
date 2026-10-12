"""The words port, the gate table and the threshold logic, model-free (AGT-1682)."""

from __future__ import annotations

import pytest

from pablo_casting.gates import (
    DEFAULT_GATES,
    GATE_NAMES,
    GateRefusal,
    derive,
    evaluate,
    validate_gates,
)
from pablo_casting.words import Heard, norm_words, sound_key, words_check


def heard(text: str, start: float = 0.5, step: float = 0.35) -> list[Heard]:
    return [Heard(w, start + i * step, start + i * step + 0.3) for i, w in enumerate(text.split())]


# --- words and tail -------------------------------------------------------------


def test_norm_words_drops_direction_splits_hyphens_and_spells_numbers_as_values() -> None:
    assert norm_words("(urgent) Not just for the Breweries -- twenty-two home-winemakers!") == [
        "not", "just", "for", "the", "breweries", "22", "home", "winemakers",
    ]


def test_a_clean_read_has_no_errors_and_ends_where_the_last_word_ends() -> None:
    line = "I'm worrying about the fact that the government is about to make our product illegal."
    words = heard(line)
    result = words_check(line, words)
    assert result["wer"] == 0.0
    assert result["inserted_span"] == 0
    assert result["tail_ok"] is True
    assert result["word_end"] == pytest.approx(words[-1].end)


def test_a_clipped_ending_fails_the_tail_and_has_no_word_end() -> None:
    line = "Not just for the breweries, but for the home winemakers too."
    result = words_check(line, heard("Not just for the breweries but for the home"))
    assert result["tail_ok"] is False
    assert result["word_end"] is None
    assert result["wer"] == pytest.approx(2 / 11, abs=1e-4)


# AGT-1789: Whisper's spelling never fails the tail. Invented lines, each with the kind of spelling
# Whisper was recorded giving on episode 1 (digits, a run-together word, a homophone name, a respelt place).


@pytest.mark.parametrize(
    ("line", "said"),
    [
        ("They poured three thousand barrels a piece.", "They poured 3 ,000 barrels apiece."),
        ("They poured three thousand barrels a piece.", "They poured three thousand barrels apiece."),
        ("A hundred and twenty steps down to the quay.", "120 steps down to the quay."),
        ("You always were a dreamer, Mara.", "You always were a dreamer, Marra."),
        ("You always were a dreamer, Cara.", "You always were a dreamer, Kara."),
        ("Nobody forgets the Valbruna estate.", "Nobody forgets the Val Bruna estate."),
        ("We will still sell Port Avellino.", "We will still sell Port Avelino."),
        ("We will still sell Port Avellino.", "We will still sell Portavellino."),
        ("The best vintage was nineteen twelve.", "The best vintage was 1912."),
        ("The best vintage was 1912.", "The best vintage was nineteen twelve."),
        ("The Quills kept their silver here.", "The Kwills kept their silver here."),
    ],
)
def test_spelling_only_differences_pass_the_words_and_tail_gates(line: str, said: str) -> None:
    result = words_check(line, heard(said))
    assert result["tail_ok"] is True, result
    assert result["wer"] == 0.0, result
    assert result["word_end"] is not None


def test_a_number_split_across_heard_words_ends_at_its_last_part() -> None:
    words = [Heard("barrels", 0.0, 0.4), Heard(" 3", 0.5, 0.7), Heard(",000", 0.7, 1.1)]
    result = words_check("barrels three thousand", words)
    assert result["tail_ok"] is True and result["wer"] == 0.0
    assert result["word_end"] == pytest.approx(1.1)


def test_a_wrong_word_still_counts_and_a_name_needs_a_capital_to_be_fuzzy() -> None:
    assert words_check("It is a promise, Mara.", heard("It is the promise, Mara."))["wer"] == pytest.approx(1 / 5)
    # "cold" and "could" are close, but neither is a name: still an error.
    assert words_check("the night was cold", heard("the night was could"))["tail_ok"] is False


def test_sound_key_folds_spellings_that_sound_alike() -> None:
    assert sound_key("cora") == sound_key("korra") == sound_key("quora")
    assert sound_key("sienna") == sound_key("siena")
    assert sound_key("apiece") == sound_key("a") + sound_key("piece")
    assert sound_key("phil") == sound_key("fill")


def test_inserted_words_are_measured_as_the_longest_run() -> None:
    line = "the cellar is full"
    result = words_check(line, heard("the cellar oh my word yes is full"))
    assert result["inserted_span"] == 4
    assert result["wer"] == pytest.approx(4 / 4)
    assert result["tail_ok"] is True


def test_numbers_and_direction_are_ignored_either_way() -> None:
    assert words_check("(warm) She was 19 then.", heard("she was nineteen then"))["wer"] == 0.0


# --- the gate table -------------------------------------------------------------


def good_scores(**over: object) -> dict[str, object]:
    scores: dict[str, object] = {
        "wer": 0.0,
        "inserted_span": 0,
        "tail_ok": True,
        "sim_card": 0.72,
        "sim_role_centroid": 0.80,
        "utmos": 4.1,
        "pq": 7.2,
        "bak": 4.2,
        "ovrl": 3.7,
        "wps": 2.9,
        "stretch": 1.0,
        "emotion_top2": ["neutral", "happy"],
        "duration_ratio": 1.1,
    }
    scores.update(over)
    return scores


def test_a_good_take_passes_every_hard_gate() -> None:
    verdict = evaluate(good_scores(), DEFAULT_GATES, centroid_takes=12, emotion="happy")
    assert verdict["pass"] is True
    assert verdict["failing"] == []
    assert verdict["flags"] == []
    assert set(verdict["gates"]) == set(GATE_NAMES)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("over", "gate"),
    [
        ({"wer": 0.08}, "words"),
        ({"inserted_span": 3}, "words"),
        ({"tail_ok": False}, "tail"),
        ({"clipped": True}, "tail"),
        ({"sim_card": 0.55}, "identity"),
        ({"sim_role_centroid": 0.60}, "consistency"),
        ({"utmos": 3.5}, "naturalness"),
        ({"bak": 3.9}, "artefacts"),
        ({"ovrl": 3.2}, "artefacts"),
        ({"wps": 3.8}, "pace"),
        ({"stretch": 0.7}, "pace"),
        ({"duration_ratio": 1.7}, "duration"),
        ({"duration_ratio": 0.3}, "duration"),
    ],
)
def test_each_hard_gate_fails_on_its_own_measure(over: dict[str, object], gate: str) -> None:
    verdict = evaluate(good_scores(**over), DEFAULT_GATES, centroid_takes=10)
    assert verdict["pass"] is False
    assert verdict["failing"] == [gate]


def test_thresholds_are_inclusive_at_the_boundary() -> None:
    at = good_scores(wer=0.05, inserted_span=2, sim_card=0.60, utmos=3.8, bak=4.0, ovrl=3.5, wps=2.4, stretch=1.05, duration_ratio=1.6)
    assert evaluate(at, DEFAULT_GATES)["pass"] is True


def test_a_missing_score_fails_its_hard_gate_and_says_so() -> None:
    scores = good_scores()
    del scores["utmos"]
    verdict = evaluate(scores, DEFAULT_GATES)
    assert verdict["failing"] == ["naturalness"]
    assert "not scored: utmos" in verdict["gates"]["naturalness"]["reason"]  # type: ignore[index]


def test_consistency_is_hard_only_from_ten_approved_takes() -> None:
    low = good_scores(sim_role_centroid=0.40)
    nine = evaluate(low, DEFAULT_GATES, centroid_takes=9)
    assert nine["pass"] is True
    assert nine["gates"]["consistency"]["pass"] is None  # type: ignore[index]
    assert "9 approved takes" in nine["gates"]["consistency"]["skipped"]  # type: ignore[index]
    assert evaluate(low, DEFAULT_GATES, centroid_takes=10)["failing"] == ["consistency"]
    absent = good_scores(sim_role_centroid=None)
    assert evaluate(absent, DEFAULT_GATES, centroid_takes=50)["gates"]["consistency"]["skipped"] == "no role centroid given"  # type: ignore[index]


def test_emotion_is_a_flag_never_a_failure() -> None:
    verdict = evaluate(good_scores(), DEFAULT_GATES, emotion="angry")
    assert verdict["pass"] is True
    assert verdict["failing"] == []
    assert verdict["flags"] == ["emotion"]
    unasked = evaluate(good_scores(), DEFAULT_GATES)
    assert unasked["gates"]["emotion"]["pass"] is None  # type: ignore[index]


def test_audiobox_pq_gates_only_when_a_threshold_is_set() -> None:
    low_pq = good_scores(pq=5.0)
    assert evaluate(low_pq, DEFAULT_GATES)["pass"] is True
    assert evaluate(low_pq, {**DEFAULT_GATES, "pq_min": 6.5})["failing"] == ["naturalness"]


def test_a_gates_block_is_validated_key_by_key() -> None:
    assert validate_gates({"sim_min": 0.62, "wps_band": [2.5, 3.1], "inserted_span_max": 1}, "card") == {
        "sim_min": 0.62,
        "wps_band": [2.5, 3.1],
        "inserted_span_max": 1,
    }
    for bad in ({"sim_minn": 0.6}, {"sim_min": "high"}, {"wps_band": [3.4, 2.4]}, {"inserted_span_max": 1.5}, {"utmos_min": True}):
        with pytest.raises(GateRefusal):
            validate_gates(bad, "card")


def test_derive_reads_pace_from_aligned_timings() -> None:
    timings = [{"word": "a", "start": 0.4, "end": 0.6}, {"word": "b", "start": 3.0, "end": 3.4}]
    # 9 script words over 3.0 s spoken = 3 w/s; target 2.7 -> stretch 0.9; 4.0 s audio vs 9/2.7 = 3.333 s.
    out = derive({"timings": timings}, "one two three four five six seven eight nine", 4.0, 2.7)
    assert out["wps"] == pytest.approx(3.0)
    assert out["stretch"] == pytest.approx(0.9)
    assert out["expected_seconds"] == pytest.approx(3.333, abs=1e-3)
    assert out["duration_ratio"] == pytest.approx(1.2)


def test_derive_falls_back_to_the_cut_then_the_whole_take() -> None:
    line = "one two three four five six"
    assert derive({"cut": 2.0}, line, 5.0, 3.0)["wps"] == pytest.approx(3.0)
    assert derive({}, line, 3.0, 3.0)["wps"] == pytest.approx(2.0)
    assert derive({"wps": 9.9}, None, None, 3.0) == {}
