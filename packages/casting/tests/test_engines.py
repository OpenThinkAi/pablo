"""The engine adapters, caps normalisation and Dia's pass grouping (AGT-1683). Model-free."""

from __future__ import annotations

from pathlib import Path

from pablo_casting.engines import (
    DIA,
    TURBO,
    TURBO_MIN_REF_S,
    Pass,
    PassLine,
    VoiceRef,
    adapt,
    dia_text,
    engine_text,
    group_dia,
    group_lines,
    normalise_caps,
    turbo_text,
)
from pablo_casting.takes import EngineId, Line, TakeInputs


def voice(seconds: float = 25.0) -> VoiceRef:
    return VoiceRef(card_hash="a" * 64, slug="mavis", reference=Path("/nowhere/reference.flac"), transcript="hello", seconds=seconds)


def test_caps_words_are_capitalised_for_the_engine() -> None:
    assert normalise_caps("Welcome to THE VALLEY'S SHADOW, chapter one.") == "Welcome to The Valley's Shadow, chapter one."
    assert normalise_caps("OK, I said NO.") == "Ok, I said No."


def test_caps_leaves_single_letters_mixed_case_and_lower_case_alone() -> None:
    assert normalise_caps("I saw A ship") == "I saw A ship"
    assert normalise_caps("McDonald and iPhone, plainly") == "McDonald and iPhone, plainly"
    assert normalise_caps("") == ""


def test_turbo_text_maps_its_three_tags_and_leaves_out_other_nonverbals() -> None:
    text = "(laughs) Well. (coughs) THE HARBOUR (chuckles) is shut. (sighs) Go home."
    assert turbo_text(text) == "[laugh] Well. [cough] The Harbour [chuckle] is shut. Go home."


def test_turbo_params_are_the_bake_off_defaults_with_no_emotion_mapping() -> None:
    one = Pass((PassLine(0, "MAVIS", "Mind the step."),))
    tender = adapt(TURBO, one, {"MAVIS": voice()}, "tender", 2)
    angry = adapt(TURBO, one, {"MAVIS": voice()}, "angry", 3)
    assert tender == angry == {"adapter": "chatterbox-turbo/2", "temperature": 0.8}


def test_turbo_pads_a_reference_under_five_seconds_and_says_so() -> None:
    one = Pass((PassLine(0, "MAVIS", "Mind the step."),))
    assert adapt(TURBO, one, {"MAVIS": voice(3.1)}, None, None)["ref_pad_to_s"] == TURBO_MIN_REF_S


def test_engine_text_comes_from_the_key_lines_and_never_changes_them() -> None:
    inputs = TakeInputs(
        engine=EngineId("fake", "0" * 64, "none", "none"),
        voice="a" * 64,
        lines=(Line("MAVIS", "This is THE HARBOUR LIGHT."),),
        seed=1,
    )
    assert engine_text(TURBO, inputs) == "This is The Harbour Light."
    assert inputs.lines[0].text == "This is THE HARBOUR LIGHT."


def test_dia_text_tags_turns_and_adds_the_throwaway() -> None:
    assert dia_text([("MAVIS", "Evening, OTTO."), ("OTTO", "Evening.")], {"MAVIS": "[S1]", "OTTO": "[S2]"}) == "[S1] Evening, Otto. [S2] Evening. [S1] Mm."


def test_dia_groups_two_alternating_turns_within_forty_words_and_never_across_a_cue() -> None:
    a, b = "MAVIS", "OTTO"
    run1 = [PassLine(0, a, "one two"), PassLine(1, b, "three four"), PassLine(2, a, "five six"), PassLine(3, a, "seven")]
    run2 = [PassLine(4, b, "eight")]
    passes = group_dia([run1, run2])
    assert [[line.i for line in p.lines] for p in passes] == [[0, 1], [2, 3], [4]]
    assert passes[1].turns() == [(a, "five six seven")]
    long = [PassLine(0, a, " ".join(["w"] * 30)), PassLine(1, b, " ".join(["w"] * 15))]
    assert [[line.i for line in p.lines] for p in group_dia([long])] == [[0], [1]]


def test_real_cloners_get_one_line_per_pass() -> None:
    runs = [[PassLine(0, "MAVIS", "a"), PassLine(1, "OTTO", "b")], [PassLine(2, "MAVIS", "c")]]
    assert [[line.i for line in p.lines] for p in group_lines(runs)] == [[0], [1], [2]]


def test_dia_params_are_the_prototype_settings() -> None:
    two = Pass((PassLine(0, "MAVIS", "a"), PassLine(1, "OTTO", "b")))
    params = adapt(DIA, two, {"MAVIS": voice(), "OTTO": voice()}, None, None)
    assert params == {"adapter": "dia/2", "temperature": 1.1, "top_p": 0.9, "ref_pad_s": 0.25, "throwaway": "Mm."}
