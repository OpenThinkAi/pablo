"""The script reader, the direction grammar and the described `CAST:` line, model-free."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from pablo_casting.directions import EMOTIONS, parse_direction
from pablo_casting.script import Cue, SpokenLine, parse_cast, parse_script
from pablo_casting.traits import normalise

FIXTURES = Path(__file__).parent / "fixtures"

# ---- the prototype's `parse`, verbatim from valleys-shadow-radio/radio/produce.py
# (frontmatter, CAST and path handling aside): the reader must agree with it item for item.
_LINE = re.compile(r"^([A-Z][A-Z .'\-]{0,30}):\s*(.+)$")
_CUE = re.compile(r"^\[(SFX|BED|MUSIC):\s*(.+?)\]\s*$", re.I)
_NONVERBALS = {"laughs", "chuckle", "chuckles", "sighs", "clears throat", "coughs", "gasps", "inhales", "exhales", "sniffs", "groans"}


def _clean(words: str) -> str:
    words = re.sub(r"\(([^)]*)\)", lambda p: p.group(0) if p.group(1).lower() in _NONVERBALS else "", words)
    return re.sub(r"\s+", " ", words).strip()


def produce_parse(text: str) -> tuple[dict[str, str], list[tuple[str, str, str]]]:
    cast: dict[str, str] = {}
    items: list[tuple[str, str, str]] = []
    if text.startswith("---"):
        text = text[3:].split("---", 1)[1]
    for raw in text.splitlines():
        raw = raw.strip().replace("*", "")
        if not raw:
            continue
        if raw.upper().startswith("CAST:"):
            for part in raw[5:].split(","):
                if "=" in part:
                    name, g = part.split("=", 1)
                    cast[name.strip().upper()] = g.strip().lower()[:1]
            continue
        m = _CUE.match(raw)
        if m:
            items.append(("cue", m.group(1).upper(), m.group(2).strip()))
            continue
        m = _LINE.match(raw)
        if m:
            words = _clean(m.group(2))
            if re.sub(r"\([^)]*\)", "", words).strip():
                items.append(("line", m.group(1).strip(), words))
        elif items and items[-1][0] == "line":
            _, speaker, words = items[-1]
            items[-1] = ("line", speaker, words + " " + _clean(raw))
    return cast, items


def as_tuples(script_items: list[Cue | SpokenLine]) -> list[tuple[str, str, str]]:
    return [("cue", i.kind, i.text) if isinstance(i, Cue) else ("line", i.speaker, i.text) for i in script_items]


@pytest.fixture(scope="module")
def chapter() -> str:
    return (FIXTURES / "01-the-lighthouse-supper.md").read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def grammar() -> str:
    return (FIXTURES / "grammar.md").read_text(encoding="utf-8")


# ---- AC1: the same counts as produce.py, and the five directions the chapter uses

def test_episode_one_has_the_prototypes_line_and_cue_counts(chapter: str) -> None:
    script = parse_script(chapter)
    cast, items = produce_parse(chapter)
    assert len(script.lines) == sum(1 for i in items if i[0] == "line") == 15
    assert len(script.cues) == sum(1 for i in items if i[0] == "cue") == 8
    assert {name: role.gender for name, role in script.roles.items()} == cast


def test_episode_one_matches_the_prototype_item_for_item(chapter: str) -> None:
    _, items = produce_parse(chapter)
    assert as_tuples(script_items := parse_script(chapter).items) == items
    assert len(script_items) == 23


def test_grammar_fixture_matches_the_prototype_item_for_item(grammar: str) -> None:
    _, items = produce_parse(grammar)
    assert as_tuples(parse_script(grammar).items) == items


def directions_by_text(chapter: str) -> dict[str, tuple[str | None, str]]:
    return {i.direction.raw: (i.direction.emotion, i.direction.status) for i in parse_script(chapter).lines if i.direction}


def test_episode_one_maps_the_writers_directions(chapter: str) -> None:
    mapped = directions_by_text(chapter)
    assert mapped["dryly"] == ("dry", "mapped")
    assert mapped["boisterous"] == ("boisterous", "ok")
    assert mapped["softly"] == ("tender", "mapped")
    assert mapped["stubbornly"] == ("tense", "mapped")
    assert mapped["reverberating"] == (None, "ignored")


def test_episode_one_reports_only_what_the_vocabulary_does_not_know(chapter: str) -> None:
    unknown = {i.text for i in parse_script(chapter).issues}
    assert unknown == {"(approaching)", "(smiling)", "(small laugh)"}
    assert not {"(dryly)", "(boisterous)", "(softly)", "(stubbornly)", "(reverberating)", "(laughs)"} & unknown


def test_episode_one_line_numbers_point_into_the_file(chapter: str) -> None:
    file_lines = chapter.splitlines()
    for spoken in parse_script(chapter).lines:
        assert file_lines[spoken.line - 1].replace("*", "").startswith(f"{spoken.speaker}:")
    by_text = {i.text: i.line for i in parse_script(chapter).issues}
    assert "(approaching)" in file_lines[by_text["(approaching)"] - 1]


def test_frontmatter_is_read_not_treated_as_script(chapter: str) -> None:
    script = parse_script(chapter)
    assert script.meta["title"] == "The Lighthouse Supper"
    assert script.meta["chapter"] == "1"


# ---- the direction grammar

def test_vocabulary_is_twelve_closed_words() -> None:
    assert len(EMOTIONS) == 12
    assert set(EMOTIONS) == {"neutral", "warm", "amused", "dry", "tender", "tense", "urgent", "angry", "afraid", "sad", "weary", "boisterous"}


@pytest.mark.parametrize(
    ("raw", "emotion", "intensity", "pace", "status"),
    [
        ("dry", "dry", 2, None, "ok"),
        ("dryly", "dry", 2, None, "mapped"),
        ("dismissive", "dry", 2, None, "mapped"),
        ("softly", "tender", 2, None, "mapped"),
        ("stubbornly", "tense", 2, None, "mapped"),
        ("reverberating", None, 2, None, "ignored"),
        ("a little amused", "amused", 1, None, "ok"),
        ("very tense", "tense", 3, None, "ok"),
        ("weary, very, slow", "weary", 3, "slow", "ok"),
        ("urgent, a little, quick", "urgent", 1, "quick", "ok"),
        ("sad, quickly", "sad", 2, "quick", "ok"),
        ("slow", None, 2, "slow", "ok"),
        ("DRY", "dry", 2, None, "ok"),
        ("approaching", None, 2, None, "unknown"),
        ("dry, approaching", "dry", 2, None, "unknown"),
    ],
)
def test_direction_parses_against_the_vocabulary(raw: str, emotion: str | None, intensity: int, pace: str | None, status: str) -> None:
    got = parse_direction(raw)
    assert (got.emotion, got.intensity, got.pace, got.status) == (emotion, intensity, pace, status)


def test_unknown_direction_keeps_its_words_for_the_report() -> None:
    assert parse_direction("dry, approaching").unknown == ("approaching",)


def test_every_grammar_case_in_the_fixture(grammar: str) -> None:
    script = parse_script(grammar)
    by_words = {i.text.split(".")[0]: i for i in script.lines}

    assert by_words["A plain vocabulary word"].direction.emotion == "dry"  # type: ignore[union-attr]
    assert by_words["A synonym for dry"].direction.status == "mapped"  # type: ignore[union-attr]
    assert by_words["A sound note, ignored"].direction.status == "ignored"  # type: ignore[union-attr]
    assert by_words["Intensity rides on the emotion"].direction.intensity == 1  # type: ignore[union-attr]
    full = by_words["Full grammar, any order of the tail"].direction
    assert full is not None and (full.emotion, full.intensity, full.pace) == ("weary", 3, "slow")
    only_pace = by_words["Pace alone, no emotion at all"].direction
    assert only_pace is not None and (only_pace.emotion, only_pace.pace) == (None, "slow")
    assert next(i for i in script.lines if "A leading non-verbal" in i.text).direction is None


def test_non_verbals_stay_inline_and_directions_leave_the_words(grammar: str) -> None:
    script = parse_script(grammar)
    lead = next(i for i in script.lines if i.text.startswith("(laughs) A leading"))
    assert lead.direction is None and lead.nonverbals == ("laughs",)
    both = next(i for i in script.lines if "Non-verbal first" in i.text)
    assert both.text == "(laughs) Non-verbal first, then a direction (sighs) and one inside."
    assert both.direction is not None and both.direction.emotion == "dry"
    assert both.nonverbals == ("laughs", "sighs")


def test_unknown_leading_and_stray_inline_directions_are_reported_with_line_numbers(grammar: str) -> None:
    script = parse_script(grammar)
    lines = grammar.splitlines()
    issues = {i.text: i for i in script.issues}
    assert set(issues) == {"(approaching)", "(waving)"}
    assert issues["(approaching)"].kind == "direction" and issues["(approaching)"].speaker == "CORA"
    assert issues["(waving)"].kind == "inline"
    for issue in issues.values():
        assert issue.text in lines[issue.line - 1]
    # the stray never reaches the words
    assert all("(waving)" not in i.text and "(approaching)" not in i.text for i in script.lines)


def test_continuation_lines_join_the_speaker_above_and_carry_their_line_numbers(grammar: str) -> None:
    script = parse_script(grammar)
    speech = next(i for i in script.lines if i.text.startswith("A speech that runs"))
    assert speech.text == "A speech that runs on over several lines (clears throat) and finishes here."
    assert len(speech.continued) == 2
    assert speech.direction is not None and (speech.direction.emotion, speech.direction.pace) == ("dry", "quick")
    narrator = next(i for i in script.lines if i.speaker == "NARRATOR")
    assert narrator.text == "Evening, and the lamps are lit. It is the last week of the harvest."


def test_a_continuation_after_a_cue_belongs_to_nobody(grammar: str) -> None:
    script = parse_script(grammar)
    assert not any("belongs to nobody" in i.text for i in script.lines)


def test_cue_kinds_and_text(grammar: str) -> None:
    cues = [(c.kind, c.text) for c in parse_script(grammar).cues]
    assert cues == [("MUSIC", "Theme, a thin organ line"), ("BED", "Rain on a tin roof"), ("BED", "off"), ("SFX", "A door closes")]


def test_speakers_with_punctuation_and_undeclared_speakers(grammar: str) -> None:
    script = parse_script(grammar)
    assert "MR. O'HARA-SMITH" in {i.speaker for i in script.lines}
    assert script.undeclared == ["ALDERMAN OTT", "MR. O'HARA-SMITH"]
    assert script.role_names()[-2:] == ["ALDERMAN OTT", "MR. O'HARA-SMITH"]
    assert "MAE" in script.roles and not script.roles["MAE"].description


def test_emphasis_stars_are_stripped(grammar: str) -> None:
    mae = next(i for i in parse_script(grammar).lines if i.speaker == "MAE")
    assert mae.text == "Emphasis stars are stripped." and mae.direction is not None and mae.direction.emotion == "warm"


def test_a_script_with_no_frontmatter_or_cast_line() -> None:
    script = parse_script("ANNOUNCER: Good evening.\n[SFX: a bell]\n")
    assert script.meta == {} and not script.has_cast and len(script.lines) == 1 and len(script.cues) == 1
    assert script.lines[0].line == 1 and script.cues[0].line == 2


def test_an_unclosed_frontmatter_fence_is_not_frontmatter() -> None:
    script = parse_script("---\ntitle: x\nANNOUNCER: hello\n")
    assert script.meta == {}


# ---- AC2: the described CAST line

def test_cast_line_with_a_description_yields_traits() -> None:
    script = parse_script('CAST: CORA=f "thirties, dry, exact"\nCORA: hi\n')
    cora = script.roles["CORA"]
    assert cora.gender == "f" and cora.description == "thirties, dry, exact"
    assert cora.traits == {"gender": "f", "age": "30s", "register": "dry"}
    assert cora.free_text == ()


def test_a_bare_cast_entry_yields_gender_only() -> None:
    script = parse_script("CAST: CORA=f\nCORA: hi\n")
    assert script.roles["CORA"].traits == {"gender": "f"}
    assert script.roles["CORA"].description is None


def test_cast_line_splits_on_commas_only_outside_quotes() -> None:
    parsed = parse_cast(' CORA=f "thirties, dry, exact", EDWIN=m, MAE=F "a girl, bright"')
    assert parsed == [("CORA", "f", "thirties, dry, exact"), ("EDWIN", "m", None), ("MAE", "f", "a girl, bright")]


def test_cast_line_accepts_curly_quotes() -> None:
    assert parse_cast("CORA=f “thirties, dry”") == [("CORA", "f", "thirties, dry")]


def test_the_issue_example_description() -> None:
    traits = normalise("EDWIN", "m", "forties, expansive, boisterous to tender")
    assert traits.traits == {"gender": "m", "age": "40s", "energy": "lively"}
    assert traits.free_text == ()


def test_traits_cover_the_whole_vocabulary() -> None:
    got = normalise("RAMON", "m", "late 50s, deep, calm, cool, folksy, 1919 period, villain").traits
    assert got == {
        "gender": "m", "age": "50s", "pitch": "low", "energy": "subdued", "warmth": "cool",
        "register": "folksy", "era": "period", "roles": ["villain"],
    }


def test_traits_first_word_wins_within_a_field_and_gender_other_than_mf_is_left_out() -> None:
    assert normalise("X", "x", "dry, formal").traits == {"register": "dry"}


def test_pitch_prefers_the_compound_word() -> None:
    assert normalise("X", "f", "low-medium").traits["pitch"] == "low-medium"
    assert normalise("X", "f", "low, medium").traits["pitch"] == "low"


def test_free_text_is_left_for_the_harness() -> None:
    got = normalise("CORA", "f", "thirties, hums when nervous, dry")
    assert got.traits["age"] == "30s" and got.traits["register"] == "dry"
    assert got.free_text == ("hums when nervous",)


def test_narrator_and_announcer_roles_come_from_the_name() -> None:
    assert normalise("ANNOUNCER", "m", None).traits == {"gender": "m", "roles": ["announcer"]}


def test_the_episode_cast_line_has_no_descriptions(chapter: str) -> None:
    roles = parse_script(chapter).roles
    assert list(roles) == ["ORLA", "BRAM", "MR. PELL", "MRS. PELL", "ANNOUNCER", "NARRATOR"]
    assert roles["ORLA"].traits == {"gender": "f"}
    assert roles["ANNOUNCER"].traits == {"gender": "m", "roles": ["announcer"]}
