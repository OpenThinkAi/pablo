"""The pronounce gate (AGT-2307): acronyms and respellings checked by their phonemes. Model-free.

The phoneme recogniser is a fake that returns canned transcriptions; the strings marked "real" are what
facebook/wav2vec2-lv-60-espeak-cv-ft heard on dogfood takes. Every script and voice is invented.
"""

from __future__ import annotations

import io
import json
from collections.abc import Mapping, Sequence
from pathlib import Path

import pytest

from pablo_casting.cli import run
from pablo_casting.config import ConfigRefusal, load_config
from pablo_casting.gates import DEFAULT_GATES, GATE_NAMES, PRONOUNCE_OFF, evaluate
from pablo_casting.lexicon import params_for, parse
from pablo_casting.manifest import read_version
from pablo_casting.perform import PerformRequest, perform
from pablo_casting.phonemes import LETTER_NAMES, Expectation, check, count, expectations, ipa_map, letters_ipa
from pablo_casting.scorers import PHONEMES, PhonemeScorer, Take, ctc_decode
from pablo_casting.takes import read_take

from test_perform import Factory, FakeScorer, fake_scorers, make_radio_work

GOOD_AI = "ð æ t eɪ aɪ k ə d"  # real: "that AI could", said "ay eye"
BAD_AJ = "ɐ dʒ eɪ d iː b æ n"  # real: "AJ", said "uh jay"


def acronym(letters: str, token: str | None = None) -> Expectation:
    return Expectation(token or letters, "acronym", letters_ipa(letters), letters)


# --- matching ---------------------------------------------------------------------------


def test_real_world_strings() -> None:
    assert count(GOOD_AI, acronym("AI")) == 1
    assert count(BAD_AJ, acronym("AJ")) == 0
    assert count("eɪ dʒ eɪ d iː b æ n", acronym("AJ")) == 1  # the take the prototype failed by mistake


@pytest.mark.parametrize("heard", ["ð æ t aɪ k ə d", "ð æ t ɐ aɪ k ə d", "ð æ t ə aɪ k ə d", "ð æ t eɪ ə aɪ k ə d"])
def test_eye_and_uh_eye_are_misses(heard: str) -> None:
    # A schwa never stands in for a letter's vowel, and the letters must be said in a row.
    assert count(heard, acronym("AI")) == 0


def test_tolerant_of_vowel_variants_and_dropped_consonants() -> None:
    assert count("ð æ t e aɪ k ə d", acronym("AI")) == 1  # a monophthong ay
    assert count("ð ə ɛ n b iː eɪ f æ n z", acronym("NBA")) == 1
    assert count("ð ə ɛ b i eɪ f æ n z", acronym("NBA")) == 1  # the n dropped, iː heard short
    assert count("d ʌ b ə j uː", acronym("W")) == 1  # dub-uh-yoo
    assert count("d ʌ b j uː", acronym("W")) == 1  # dub-yoo


def test_each_use_must_be_heard() -> None:
    expected = [acronym("AI"), acronym("AI", "AI's")]
    once = check(expected, GOOD_AI)
    assert once["pronounce_missed"] == ["AI/AI's"]
    assert once["pronounce"] == [{"token": "AI/AI's", "kind": "acronym", "ipa": "eɪ aɪ", "need": 2, "heard": 1}]
    twice = check(expected, GOOD_AI + " ɐ n d eɪ aɪ z")
    assert twice["pronounce_missed"] == [] and twice["phonemes"].startswith("ð æ t")


def test_letter_table_is_complete() -> None:
    assert sorted(LETTER_NAMES) == [chr(c) for c in range(ord("A"), ord("Z") + 1)]
    assert letters_ipa("AJ") == "eɪ dʒ eɪ"


# --- what a take must say --------------------------------------------------------------------


def test_acronyms_come_from_the_take_keys_acronyms_param() -> None:
    lines = [("NARRATOR", "That AI could beat the NBA, AI's fans say, in World War II.")]
    found = expectations(lines, {"acronyms": 2})
    assert [(e.token, e.ipa) for e in found] == [("AI", "eɪ aɪ"), ("NBA", "ɛ n b iː eɪ"), ("AI's", "eɪ aɪ")]
    assert expectations(lines, {}) == []  # fiction (acronym mode off): the engine read words, nothing to check
    assert expectations([("NARRATOR", "WE ARE THE CHAMPIONS, AI.")], {"acronyms": 2}) == []  # a shout is capitalised


def test_respellings_need_an_ipa_field_or_spelled_letters() -> None:
    entries = parse("AJ -> A J /eɪ dʒ eɪ/\nZinfandel -> zin-fan-DELL\nNASA -> N.A.S.A.\n")
    assert entries[0].respelling == "A J" and entries[0].ipa == "eɪ dʒ eɪ"
    assert entries[1].ipa is None
    lines = [("NARRATOR", "AJ drank Zinfandel at NASA.")]
    params = dict(params_for(entries, lines))
    assert "eɪ dʒ" not in params["lexicon"]  # the IPA is never part of the take key
    found = expectations(lines, params, ipa_map(entries))
    assert [(e.token, e.kind, e.ipa) for e in found] == [("AJ", "respelling", "eɪ dʒ eɪ"), ("NASA", "respelling", letters_ipa("NASA"))]


def test_a_speaker_scoped_ipa_applies_to_that_speaker() -> None:
    entries = parse("CORA: Siobhan -> shiv-AWN /ʃ ɪ v ɔː n/\n")
    params = dict(params_for(entries, [("CORA", "Siobhan waved.")]))
    assert [e.token for e in expectations([("CORA", "Siobhan waved.")], params, ipa_map(entries))] == ["Siobhan"]
    assert count("ʃ ɪ v ɔː n w eɪ v d", expectations([("CORA", "Siobhan waved.")], params, ipa_map(entries))[0]) == 1


# --- the gate and its config ------------------------------------------------------------------


def passing_scores(**extra: object) -> dict[str, object]:
    return {
        "wer": 0.0, "inserted_span": 0, "tail_ok": True, "sim_card": 0.8, "utmos": 4.2, "bak": 4.2, "ovrl": 3.6,
        "wps": 2.9, "stretch": 1.0, "duration_ratio": 1.0, **extra,
    }  # fmt: skip


def test_gate_fails_a_miss_and_skips_when_nothing_was_checked_or_it_is_off() -> None:
    assert "pronounce" in GATE_NAMES
    missed = evaluate(passing_scores(pronounce_missed=["AI"]), DEFAULT_GATES)
    assert missed["failing"] == ["pronounce"]
    assert evaluate(passing_scores(pronounce_missed=[]), DEFAULT_GATES)["pass"] is True
    unscored = evaluate(passing_scores(), DEFAULT_GATES)
    assert unscored["pass"] is True and unscored["gates"]["pronounce"]["pass"] is None  # type: ignore[index]
    off = evaluate(passing_scores(pronounce_missed=["AI"]), {**DEFAULT_GATES, **PRONOUNCE_OFF})
    assert off["pass"] is True and "casting.json" in off["gates"]["pronounce"]["skipped"]  # type: ignore[index]


def test_config_turns_the_gate_off(tmp_path: Path) -> None:
    env = {"XDG_CONFIG_HOME": str(tmp_path)}
    assert load_config(env).pronounce_gate is True
    (tmp_path / "pablo").mkdir()
    (tmp_path / "pablo" / "casting.json").write_text(json.dumps({"pronounce": {"gate": False}}), encoding="utf-8")
    assert load_config(env).pronounce_gate is False
    assert load_config(env).as_body()["pronounce"] == {"gate": False}
    (tmp_path / "pablo" / "casting.json").write_text(json.dumps({"pronounce": {"gate": "no"}}), encoding="utf-8")
    with pytest.raises(ConfigRefusal, match="pronounce"):
        load_config(env)


# --- the scorer -----------------------------------------------------------------------------------


def test_scorer_loads_nothing_without_expectations(tmp_path: Path) -> None:
    class NeverLoads(PhonemeScorer):
        def _load(self) -> object:
            raise AssertionError("loaded the phoneme model for a take with nothing to check")

    assert NeverLoads().score(Take(audio=tmp_path / "none.wav", line="Hello there.", seconds=1.0)) == {}


def test_ctc_decode_collapses_repeats_and_drops_specials() -> None:
    vocab = {0: "<pad>", 1: "eɪ", 2: "aɪ", 3: "<s>"}
    assert ctc_decode([0, 1, 1, 0, 2, 2, 3, 0], vocab) == "eɪ aɪ"
    assert ctc_decode([1, 0, 1], vocab) == "eɪ eɪ"


class FakePhonemes(FakeScorer):
    """The phoneme scorer with canned transcriptions, one per call (the last repeats)."""

    def __init__(self, heard: Sequence[str]) -> None:
        super().__init__(PHONEMES)
        self.heard = list(heard)
        self.calls: list[tuple[Expectation, ...]] = []

    def score(self, take: Take) -> Mapping[str, object]:
        if not take.expect:
            return {}
        self.calls.append(take.expect)
        phonemes = self.heard[min(len(self.calls) - 1, len(self.heard) - 1)]
        return check(take.expect, phonemes)


# --- perform retries a miss -----------------------------------------------------------------------

SCRIPT = """CAST: MAVIS=f "forties, warm, quick", OTTO=m "sixties, gruff"
MAVIS: Good evening, the AI is listening tonight and so are we.
OTTO: Mind the step, the boards are wet tonight.
"""


def nonfiction_work(tmp_path: Path) -> tuple[Path, Path]:
    work, library = make_radio_work(tmp_path)
    (work / "outputs" / "radio" / "episodes" / "01-the-harbour-light.md").write_text(SCRIPT, encoding="utf-8")
    (work / "pablo.json").write_text(json.dumps({"track": "nonfiction"}), encoding="utf-8")
    return work, library


def go(work: Path, library: Path, phonemes: FakePhonemes, env: Mapping[str, str] | None = None) -> tuple[dict[str, object], int]:
    body, code = perform(
        PerformRequest(work=work, episode=1, engine="chatterbox-turbo", voices_dir=library / "voices"),
        env=dict(env or {}),
        engine_factory=Factory(wps=(3.0,)),
        scorer_factory=lambda: [*fake_scorers(), phonemes],
        err=io.StringIO(),
        out=io.StringIO(),
    )
    return body, code


def test_perform_retakes_a_line_whose_acronym_was_not_heard(tmp_path: Path) -> None:
    work, library = nonfiction_work(tmp_path)
    phonemes = FakePhonemes(["ɡ ʊ d iː v n ɪ ŋ ð ə aɪ ɪ z", "ɡ ʊ d iː v n ɪ ŋ ð ə eɪ aɪ ɪ z"])
    body, code = go(work, library, phonemes)
    assert code == 0, body
    assert len(phonemes.calls) == 2 and [e.token for e in phonemes.calls[0]] == ["AI"]  # OTTO's line had nothing to check
    line = read_version(work, 1, 1)["lines"][0]
    assert line["status"] == "pass" and line["attempt"] == 1 and line["attempts"] == 2
    take = read_take(work, line["take"])
    assert take is not None and take.record["scores"]["pronounce_missed"] == []


def test_perform_flags_a_line_never_heard_right(tmp_path: Path) -> None:
    work, library = nonfiction_work(tmp_path)
    body, code = go(work, library, FakePhonemes(["ð ə aɪ ɪ z"]))
    assert code == 0, body
    line = read_version(work, 1, 1)["lines"][0]
    assert line["status"] == "best_of_failed" and line["failing"] == ["pronounce"]
    assert "pronounce" in line["flag"]


def test_perform_skips_the_gate_when_casting_json_turns_it_off(tmp_path: Path) -> None:
    work, library = nonfiction_work(tmp_path)
    config = tmp_path / "config" / "pablo"
    config.mkdir(parents=True)
    (config / "casting.json").write_text(json.dumps({"pronounce": {"gate": False}}), encoding="utf-8")
    phonemes = FakePhonemes(["ð ə aɪ ɪ z"])
    body, code = go(work, library, phonemes, env={"XDG_CONFIG_HOME": str(tmp_path / "config")})
    assert code == 0, body
    assert phonemes.calls == []
    assert read_version(work, 1, 1)["lines"][0]["status"] == "pass"


# --- pronounce --check ---------------------------------------------------------------------------


def test_check_lists_misses_in_rendered_takes_without_re_rendering(tmp_path: Path) -> None:
    work, library = nonfiction_work(tmp_path)
    assert go(work, library, FakePhonemes(["ɡ ʊ d ð ə eɪ aɪ ɪ z"]))[1] == 0
    before = sorted(p.name for p in (work / "outputs" / "radio" / "casting" / "takes").iterdir())
    bad = FakePhonemes(["ɡ ʊ d ð ə ɐ aɪ ɪ z"])
    (body, code), _ = run(["pronounce", "--work", str(work), "--check", "--json"], {}, scorers=lambda: [*fake_scorers(), bad])
    assert code == 0, body
    assert body["check"] is True and body["checked"] == 1 and body["misses"] == 1
    unit = body["units"][0]  # type: ignore[index]
    assert unit["unit"] == 1 and unit["version"] == 1
    miss = unit["misses"][0]
    assert miss["missed"] == ["AI"] and miss["speaker"] == "MAVIS" and miss["lines"] == [2]
    assert sorted(p.name for p in (work / "outputs" / "radio" / "casting" / "takes").iterdir()) == before
    good = FakePhonemes(["ɡ ʊ d ð ə eɪ aɪ ɪ z"])
    (body, code), _ = run(["pronounce", "--work", str(work), "--check", "--json"], {}, scorers=lambda: [*fake_scorers(), good])
    assert code == 0 and body["misses"] == 0


def test_check_refuses_an_unrendered_unit(tmp_path: Path) -> None:
    work, _library = nonfiction_work(tmp_path)
    (body, code), _ = run(["pronounce", "--work", str(work), "--check", "--episode", "1", "--json"], {}, scorers=lambda: [FakePhonemes([""])])
    assert code == 2 and "perform it first" in str(body["message"])
