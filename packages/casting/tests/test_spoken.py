"""Spoken forms for the engines (AGT-2302): number ranges, minus signs, leading-dot decimals, acronyms, and
`pronounce`. Pure Python, model-free; every work and line here is invented."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pablo_casting import outputs
from pablo_casting.cli import run
from pablo_casting.engines import (
    ACRONYMS_PARAM,
    ACRONYMS_VERSION,
    SPOKEN_PARAM,
    TURBO,
    PassLine,
    Pass,
    VoiceRef,
    adapt,
    dotted,
    engine_text,
    is_shouted,
    normalise_caps,
    spoken_params,
    turbo_text,
)
from pablo_casting.lexicon import acronym_mode, lexicon_path, parse
from pablo_casting.numerals import spell_numbers
from pablo_casting.perform import Performer
from pablo_casting.spoken import expand, links, undecided
from pablo_casting.takes import Direction, EngineId, Line, TakeInputs
from test_perform import SCRIPT, Factory, LineSpy, fake_scorers, go, make_radio_work


@pytest.mark.parametrize(
    ("text", "spoken"),
    [
        ("to 10-20% within", "to ten to twenty percent within"),
        ("10%-20%", "ten to twenty percent"),
        ("10–20%", "ten to twenty percent"),  # en dash
        ("10 – 20", "ten to twenty"),  # spaces around the dash
        ("$5-10", "five to ten dollars"),
        ("$1-2", "one to two dollars"),
        ("$5-$10", "five to ten dollars"),
        ("1.5-2.5%", "one point five to two point five percent"),
        ("the 2025-26 season", "the twenty twenty-five to twenty-six season"),
        ("1996-97", "nineteen ninety-six to ninety-seven"),
        ("1914-1918", "nineteen fourteen to nineteen eighteen"),
        ("New Orleans won 120-119", "New Orleans won one hundred twenty, one hundred nineteen"),
        ("a 3-3 tie", "a three, three tie"),
        ("employment of 22-25 year-olds", "employment of twenty-two to twenty-five year-olds"),
    ],
)
def test_ranges_are_spoken_a_to_b_with_the_unit_once(text: str, spoken: str) -> None:
    assert spell_numbers(text) == spoken


@pytest.mark.parametrize(
    "text",
    ["2025-05-28", "COVID-19", "well-known", "twenty-two", "x-5", "3rd-4th"],
)
def test_dates_number_words_and_non_digit_sides_are_not_ranges(text: str) -> None:
    assert spell_numbers(text) == spell_numbers(text, spoken_forms=False)
    assert " to " not in spell_numbers(text)


def test_leading_dot_decimals_and_minus_signs() -> None:
    assert spell_numbers("opponents shot .376") == "opponents shot point three seven six"
    assert spell_numbers(".5%") == "point five percent"
    assert spell_numbers("end.376") == "end.376"  # after a word character: not a decimal
    assert spell_numbers("a net rating of -7.66") == "a net rating of minus seven point six six"
    assert spell_numbers("-4 degrees") == "minus four degrees"  # a line start
    assert spell_numbers("(-3)") == "(minus three)"
    assert spell_numbers("-.5") == "minus point five"
    # A hyphen between words or numbers is never a minus.
    assert "minus" not in spell_numbers("x-5 and well-known and 5-3 and 2025-05-28")


def test_spoken_forms_off_is_the_spelling_before_them() -> None:
    assert spell_numbers("10-20% and -7.66 and .376", spoken_forms=False) == "ten-twenty percent and -seven point six six and .376"


def test_changes_record_each_token() -> None:
    changes: list[tuple[str, str]] = []
    spell_numbers("10-20% and -7.66", changes=changes)
    assert changes == [("10-20%", "ten to twenty percent"), ("-7.66", "minus seven point six six")]


def test_acronyms_as_spaced_letters_when_on() -> None:
    assert dotted("AI") == "A I" and dotted("GDP") == "G D P" and dotted("AEI") == "A E I"
    assert dotted("CEOs") == "C E Os" and dotted("AI's") == "A I's"
    assert dotted("A") is None and dotted("ABCDEFG") is None and dotted("McDonald") is None
    assert normalise_caps("CEOs at AEI and FRI", acronyms=True) == "C E Os at A E I and F R I"
    assert normalise_caps("I trust AI.", acronyms=True) == "I trust A I."  # the full stop stays the sentence's


def test_acronym_mode_off_is_todays_behaviour() -> None:
    assert normalise_caps("AI and GDP") == "Ai and Gdp"
    assert turbo_text("AI and GDP") == "Ai and Gdp"


def test_roman_numerals_stay_words() -> None:
    assert dotted("II") is None and dotted("XIV") is None
    assert normalise_caps("World War II and the AI", acronyms=True) == "World War Ii and the A I"


def test_a_shouted_line_keeps_capitalising() -> None:
    assert is_shouted("WE ARE THE CHAMPIONS, AI.")
    assert not is_shouted("CEOs at AEI and FRI") and not is_shouted("AI.") and not is_shouted("NASA said AI")
    assert normalise_caps("WE ARE THE CHAMPIONS, AI.", acronyms=True) == "We Are The Champions, Ai."
    # A shouted phrase inside a line (three caps words in a row, or two with one too long for an acronym) too.
    assert normalise_caps("Good evening from THE HARBOUR LIGHT, where", acronyms=True) == "Good evening from The Harbour Light, where"
    assert normalise_caps("US GDP rose", acronyms=True) == "U S G D P rose"


def test_the_lexicon_overrides_an_acronym() -> None:
    entries = parse("NASA -> nasa\nzinfandel -> zin-fan-DELL")
    line = "NASA said AI likes ZINFANDEL"
    params = spoken_params([("N", line)], entries, acronyms=True)
    assert params[ACRONYMS_PARAM] == ACRONYMS_VERSION
    assert turbo_text(line, "N", params["lexicon"], True) == "nasa said A I likes zin-fan-DELL"


def test_the_requested_lines() -> None:
    said = lambda text: turbo_text(text, "NARRATOR", None, True)  # noqa: E731
    assert said("AI could push unemployment to 10-20% within one to five years.") == "A I could push unemployment to ten to twenty percent within one to five years."
    assert said("a net rating of -7.66 and opponents shot .376") == "a net rating of minus seven point six six and opponents shot point three seven six"


def voice() -> VoiceRef:
    return VoiceRef(card_hash="c" * 64, slug="n", reference=Path("/nowhere/reference.flac"), transcript="hello", seconds=25.0)


def one(text: str) -> Pass:
    return Pass((PassLine(0, "N", text),))


def test_take_keys_move_only_for_lines_the_new_rules_change() -> None:
    # A line the new rules leave alone keeps exactly the params it had; acronyms only on (nonfiction) and only where they change it.
    plain = adapt(TURBO, one("The fog came in."), {"N": voice()}, None, None, (), (), acronyms=True)
    assert SPOKEN_PARAM not in plain and ACRONYMS_PARAM not in plain
    assert plain == adapt(TURBO, one("The fog came in."), {"N": voice()}, None, None)
    assert adapt(TURBO, one("in 1912, 50%"), {"N": voice()}, None, None) == adapt(TURBO, one("in 1912, 50%"), {"N": voice()}, None, None, (), (), True)
    ranged = adapt(TURBO, one("10-20%"), {"N": voice()}, None, None)
    assert ranged[SPOKEN_PARAM] == 1 and ACRONYMS_PARAM not in ranged
    assert ACRONYMS_PARAM not in adapt(TURBO, one("AI here"), {"N": voice()}, None, None)  # fiction: off
    assert adapt(TURBO, one("AI here"), {"N": voice()}, None, None, (), (), True)[ACRONYMS_PARAM] == ACRONYMS_VERSION


def test_engine_text_follows_the_take_key() -> None:
    def inputs(params: dict[str, object]) -> TakeInputs:
        return TakeInputs(engine=EngineId("chatterbox-turbo", "0" * 64, "0", "0"), voice="v", lines=(Line("N", "AI at 10-20%"),), seed=0, direction=Direction(), params=params)

    assert engine_text(TURBO, inputs({ACRONYMS_PARAM: ACRONYMS_VERSION})) == "A I at ten to twenty percent"
    assert engine_text(TURBO, inputs({})) == "Ai at ten to twenty percent"


def make_work(root: Path, track: str | None, reading: str, lexicon: str = "") -> Path:
    work = root / "essays" / "jobs"
    (work / "outputs" / "narrated" / "readings").mkdir(parents=True)
    marker: dict[str, object] = {"title": "Jobs", "slug": "jobs", "outputs": {"narrated": {"from": "essay"}}}
    if track:
        marker["track"] = track
    (work / "pablo.json").write_text(json.dumps(marker), encoding="utf-8")
    (work / "outputs" / "narrated" / "readings" / "01-jobs.md").write_text(reading, encoding="utf-8")
    if lexicon:
        (work / "outputs" / "narrated" / "pronounce.md").write_text(lexicon, encoding="utf-8")
    return work


READING = """CAST: NARRATOR="the narrator, reading the prose"

NARRATOR: AI could push unemployment to 10-20% within one to five years.

NARRATOR: The fog came in over the harbour.

NARRATOR: NASA and the Brookings Institution disagree, said Okafor.
"""


def test_acronym_mode_reads_the_track(tmp_path: Path) -> None:
    assert acronym_mode(make_work(tmp_path / "a", "nonfiction", READING))
    assert not acronym_mode(make_work(tmp_path / "b", None, READING))
    assert not acronym_mode(make_work(tmp_path / "c", "fiction", READING))
    assert not acronym_mode(tmp_path / "nowhere")


def test_the_performer_takes_acronym_mode_from_the_work(tmp_path: Path) -> None:
    work = make_work(tmp_path, "nonfiction", READING)
    performer = Performer(work=work, episode=1, spec=TURBO, roles={}, engine=None, scorers=(), err=None, out=None, scratch=tmp_path)  # type: ignore[arg-type]
    assert performer.acronyms is True


def test_the_lexicon_path_is_per_output(tmp_path: Path) -> None:
    assert lexicon_path(tmp_path, "narrated") == tmp_path / "outputs" / "narrated" / "pronounce.md"
    assert lexicon_path(tmp_path, "radio") == tmp_path / "outputs" / "radio" / "pronounce.md"
    with outputs.using("narrated"):
        assert lexicon_path(tmp_path) == tmp_path / "outputs" / "narrated" / "pronounce.md"


def test_pronounce_lists_changed_lines_tokens_and_unresolved_words(tmp_path: Path) -> None:
    work = make_work(tmp_path, "nonfiction", READING, "NASA -> nasa\n")
    (body, code), _json = run(["pronounce", "--work", str(work), "--output", "narrated", "--json"], env={})
    assert code == 0, body
    assert body["output"] == "narrated" and body["acronyms"] is True and body["lexicon"] == "outputs/narrated/pronounce.md"
    (unit,) = body["units"]  # type: ignore[misc]
    lines = unit["lines"]
    assert [line["line"] for line in lines] == [3, 7]  # the fog line is said as written
    first = lines[0]
    assert first["speaker"] == "NARRATOR"
    assert first["changes"] == [{"from": "AI", "to": "A I"}, {"from": "10-20%", "to": "ten to twenty percent"}]  # in line order
    assert first["engine"] == "A I could push unemployment to ten to twenty percent within one to five years."
    assert lines[1]["changes"] == [{"from": "NASA", "to": "nasa"}]  # the lexicon wins; the chain through caps is one change
    unresolved = {row["token"]: row for row in body["unresolved"]}  # type: ignore[union-attr]
    assert set(unresolved) == {"Brookings", "Institution", "Okafor"}  # "The", "NARRATOR"'s sentence starts and NASA are decided
    assert unresolved["Okafor"]["first"] == {"unit": 1, "line": 7}
    assert not list(work.rglob("casting"))  # read-only: nothing written


def test_pronounce_on_a_fiction_work_keeps_caps_and_lists_them(tmp_path: Path) -> None:
    work = make_work(tmp_path, None, 'CAST: NARRATOR="n"\n\nNARRATOR: The AI said GDP.\n')
    (body, code), _ = run(["pronounce", "--work", str(work), "--output", "narrated", "--episode", "1", "--json"], env={})
    assert code == 0
    assert body["units"][0]["lines"][0]["engine"] == "The Ai said Gdp."  # type: ignore[index]
    assert {row["token"]: row["kind"] for row in body["unresolved"]} == {"AI": "caps", "GDP": "caps"}  # type: ignore[union-attr]


def test_pronounce_refuses_a_missing_unit(tmp_path: Path) -> None:
    work = make_work(tmp_path, "nonfiction", READING)
    (body, code), _ = run(["pronounce", "--work", str(work), "--output", "narrated", "--episode", "4", "--json"], env={})
    assert code == 2 and body["missing"] == ["narrated unit 4"] and body["units"] == [1]
    assert "its units are 1" in str(body["message"])


def test_a_nonfiction_perform_reads_acronyms_as_letters_and_the_words_gate_keeps_the_script_text(tmp_path: Path) -> None:
    work, library = make_radio_work(tmp_path)
    (work / "pablo.json").write_text(json.dumps({"title": "W", "slug": "w", "track": "nonfiction"}), encoding="utf-8")
    script = work / "outputs" / "radio" / "episodes" / "01-the-harbour-light.md"
    script.write_text(SCRIPT.replace("Mind the step", "Mind the AI at 10-20%"), encoding="utf-8")
    LineSpy.seen = []
    factory = Factory(wps=(3.0,))
    body, code, _, _ = go(work, library, factory, scorers=[LineSpy(s.info, s.answer) for s in fake_scorers()])
    assert code == 0, body
    assert factory.engine is not None
    first, second = factory.engine.calls[0], factory.engine.calls[1]
    assert second["text"].startswith("Mind the A I at ten to twenty percent")
    assert second["inputs"].params[ACRONYMS_PARAM] == ACRONYMS_VERSION and second["inputs"].params[SPOKEN_PARAM] == 1
    # The shouted-title line keeps today's capitalising and gets no new param.
    assert "The Harbour Light" in first["text"] and ACRONYMS_PARAM not in first["inputs"].params
    assert any("Mind the AI at 10-20%" in line for line in LineSpy.seen)  # the gate judges the script's own words


# --- the shorthand rules (spoken.py), every track ----------------------------------------------------------------


def say(text: str, acronyms: bool = False, lexicon: object = None) -> str:
    return turbo_text(text, "N", lexicon, acronyms)


def test_the_extension_lines() -> None:
    assert say("Gov. Lisa Cook spoke at 3:00 p.m. on Oct. 22", True) == "Governor Lisa Cook spoke at three p.m. on October twenty-second"
    assert say("a $7T market and 15M jobs", True) == "a seven trillion dollars market and fifteen million jobs"
    assert say("about 1/3 of firms, i.e. a minority", True) == "about one third of firms, that is a minority"
    assert say("the U.S. vs. the U.K.", True) == "the U.S. versus the U.K."
    assert say("Q3 2026 growth of ~2.5%", True) == "Q three twenty twenty-six growth of about two point five percent"
    assert say("the 1990s and the 2020s", True) == "the nineteen nineties and the twenty twenties"
    assert say("R&D at 10x the pace", True) == "R and D at ten times the pace"


@pytest.mark.parametrize(
    ("text", "spoken"),
    [
        ("Mr. Smith, Mrs. Smith and Ms. Smith", "Mister Smith, Missus Smith and Miz Smith"),
        ("Dr. Okafor", "Doctor Okafor"),
        ("on Elm Dr. today", "on Elm Dr. today"),  # not before a capitalised name
        ("St. Louis", "Saint Louis"),
        ("Sen. Ruiz and Rep. Hale", "Senator Ruiz and Representative Hale"),
        ("Prof. Lee, Gen. Lee, Lt. Lee, Sgt. Lee", "Professor Lee, General Lee, Lieutenant Lee, Sergeant Lee"),
        ("Hank Ruiz Jr. and Hank Ruiz, Sr. agreed", "Hank Ruiz Junior and Hank Ruiz, Senior agreed"),
        ("It was Hank Ruiz Jr.", "It was Hank Ruiz Junior."),  # a line's last full stop is kept
        ("red vs blue", "red versus blue"),
        ("pens, paper, etc.", "pens, paper, et cetera."),
        ("fruit, e.g. pears", "fruit, for example pears"),
        ("approx. 40 people", "approximately forty people"),
        ("the No. 2 pick", "the number two pick"),
        ("Jan. 3 and Sept. 1 and Dec. 31st", "January third and September first and December thirty-first"),
        ("mr. smith", "mr. smith"),  # case-sensitive
    ],
)
def test_abbreviations(text: str, spoken: str) -> None:
    assert say(text) == spoken


@pytest.mark.parametrize(
    ("text", "spoken"),
    [
        ("at 3:15", "at three fifteen"),
        ("at 3:05", "at three oh five"),
        ("at 12:00", "at twelve"),
        ("at 3:00p", "at three p.m."),
        ("at 3p", "at three p.m."),
        ("at 9 AM", "at nine a.m."),
        ("at 3:00 p.m. sharp", "at three p.m. sharp"),
        ("1/2 and 2/3 and 1/4 and 3/4", "one half and two thirds and one quarter and three quarters"),
        ("5/8 of it", "five over eight of it"),
        ("1 1/2 cups", "one and one half cups"),
        ("on 10/22/2026", "on October twenty-second, twenty twenty-six"),  # a date, not a fraction
    ],
)
def test_times_fractions_and_dates(text: str, spoken: str) -> None:
    assert say(text) == spoken


@pytest.mark.parametrize(
    ("text", "spoken"),
    [
        ("$15M and 3B and 2bn", "fifteen million dollars and three billion and two billion"),
        ("$40K and 4k", "forty thousand dollars and four thousand"),
        ("a 4K video and an 8K screen", "a 4K video and an 8K screen"),  # screen resolutions
        ("7 T-shirts", "seven T-shirts"),  # a letter must touch the number
        ("60 mph and 1 km and 2.5 kg", "sixty miles per hour and one kilometer and two point five kilograms"),
        ("1 lb, 3 lbs, 6 ft, 5 in. and 2 mi", "one pound, three pounds, six feet, five inches and two miles"),
        ("12 in a row", "twelve in a row"),  # "in" only with its full stop
        ("4 cm, 9 mm, 250 ml, 8 GB, 2 MB, 1 TB", "four centimeters, nine millimeters, two hundred fifty milliliters, eight gigabytes, two megabytes, one terabyte"),
        ("50bps and 12 pts and 30 ppl", "fifty basis points and twelve points and thirty people"),
        ("1 hr, 2 hrs, 5 min, 1 sec, 3 yrs", "one hour, two hours, five minutes, one second, three years"),
        ("2x4 and 3 × 3", "two times four and three times three"),
        ("±3 and #1 and @home", "plus or minus three and number one and at home"),
        ("tea & cake", "tea and cake"),
        ("10 % and a % sign", "ten percent and a percent sign"),
        ("and/or, either/or, cats/dogs", "and or, either or, cats or dogs"),
        ("the '90s and the 1900s", "the nineties and the nineteen hundreds"),
        ("FY2026 and FY26", "fiscal year twenty twenty-six and fiscal year twenty-six"),
        ("Q4", "Q four"),
    ],
)
def test_magnitudes_units_symbols_and_the_rest(text: str, spoken: str) -> None:
    assert say(text) == spoken


def test_links_are_left_alone_and_listed() -> None:
    line = "Read https://example.com/a-10%&b=2 or write to ann@example.org at 5pm"
    assert say(line) == "Read https://example.com/a-10%&b=2 or write to ann@example.org at five p.m."
    assert links(line) == ["https://example.com/a-10%&b=2", "ann@example.org"]
    assert ("ann@example.org", "link") in undecided(line)


def test_dotted_initialisms_stay_dotted_letters() -> None:
    assert say("the U.S. and U.K. and E.U. and U.N.", True) == "the U.S. and U.K. and E.U. and U.N."
    assert say("U.S. policy", True) == "U.S. policy"  # never "us"
    assert say("the U.S.", False) == "the U.S."


def test_a_lexicon_entry_wins_over_a_shorthand_rule() -> None:
    entries = parse("vs -> verses\nmin -> minimum")
    line = "red vs blue at 5 min"
    params = spoken_params([("N", line)], entries)
    assert say(line, lexicon=params["lexicon"]) == "red verses blue at five minimum"


def test_undecided_lists_abbreviations_and_units() -> None:
    found = undecided("Ave. three is 5GHz but 5 km and the U.S. economy are fine.")
    assert ("Ave.", "abbreviation") in found and ("5GHz", "unit") in found
    assert not any(token.startswith("U.") or token == "5km" for token, _ in found)


def test_shorthand_moves_take_keys_only_where_it_changes_the_line() -> None:
    assert SPOKEN_PARAM in spoken_params([("N", "Mr. Smith & sons")])
    assert spoken_params([("N", "Mister Smith and sons")]) == {}
    assert expand("no shorthand here") == "no shorthand here"


def test_a_full_month_name_before_a_day_says_the_day_as_an_ordinal() -> None:
    assert say("On April 23, 2026, AEI reported", True) == "On April twenty-third, twenty twenty-six, A E I reported"
    assert say("In a May 5, 2026, report", False) == "In a May fifth, twenty twenty-six, report"
    assert say("on July 5th", False) == "on July fifth"
    # a month before a year, or a bare month, is left alone
    assert say("In May 2026 and in June", False) == "In May twenty twenty-six and in June"
