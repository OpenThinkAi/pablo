"""Design on demand and gated admission to the library (AGT-1699). Model-free.

`cast --auto --design` over a fixture library, the fake designer toolkit, a
recording fake engine and fake scorers. Every script, card and voice here is
invented; every library and work is a tmp directory, never a real vault.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

import numpy as np
import pytest

from pablo_casting.binding import pin_state
from pablo_casting.cli import run
from pablo_casting.config import CastingConfig
from pablo_casting.design import PITCH_HZ, TRIAL_LINES, pitch_band, screen
from pablo_casting.engines import EngineSpec, RecordingEngine, VoiceRef
from pablo_casting.fakes import FakeDesigner, fake_toolkit
from pablo_casting.library import Library, card_hash
from pablo_casting.matching import load_voices
from pablo_casting.receipts import receipts_path
from pablo_casting.scorers import ALIGNER, AUDIOBOX, DNSMOS, ECAPA, EMOTION, UTMOS, WHISPER, ScorerInfo, ScorerUnavailable, Take
from pablo_casting.toolkit import Toolkit
from pablo_casting.traits import describe_traits, normalise
from pablo_casting.words import script_word_count

SCRIPT = """---
chapter: 1
title: The Ferry at Dusk
---
CAST: CORA=f "thirties, low-medium, measured, warm, dry, period, lead", RAMON=m "seventies, reedy, gruff, cool, period"

CORA: (dryly) The ferry is late again, Ramon.
RAMON: It was late in my day too.
"""

_rng = np.random.default_rng(1699)
LIBRARY_CARDS: dict[str, dict[str, object]] = {
    "cora": {"gender": "f", "age": "30s", "pitch": "low-medium", "energy": "measured", "warmth": "warm", "register": "dry", "era": "period", "roles": ["lead"]},
    # The only man in the library, nothing like RAMON: so RAMON needs a designed voice.
    "edwin": {"gender": "m", "age": "40s", "pitch": "low", "energy": "lively", "warmth": "warm", "register": "theatrical", "era": "modern"},
}
EMBEDDINGS = {slug: _rng.standard_normal(192) for slug in LIBRARY_CARDS}


def high_male(instruct: str, seed: int) -> float:
    """RAMON's "reedy" is a high pitch: every candidate lands in the male high band, each a little apart."""
    return 165.0 + (seed % 4) * 12.0


class FakeScorer:
    def __init__(self, info: ScorerInfo, answer: Mapping[str, object] | None = None) -> None:
        self.info = info
        self.answer = dict(answer or {})

    def score(self, take: Take) -> Mapping[str, object]:
        if self.info is WHISPER:
            return {"wer": 0.0, "inserted_span": 0, "tail_ok": True, "cut": round(take.seconds, 3), "heard": take.line}
        if self.info is ALIGNER:
            words = script_word_count(take.line)
            step = (take.seconds - 0.18) / words
            return {"timings": [{"word": f"w{k}", "start": round(k * step, 4), "end": round((k + 1) * step, 4)} for k in range(words)]}
        if self.info is EMOTION:
            raise ScorerUnavailable(self.info, ImportError("funasr"))
        return self.answer


def fake_scorers(sim: float = 0.8) -> list[FakeScorer]:
    return [
        FakeScorer(WHISPER),
        FakeScorer(ALIGNER),
        FakeScorer(ECAPA, {"sim_card": sim, "sim_role_centroid": None}),
        FakeScorer(UTMOS, {"utmos": 4.3}),
        FakeScorer(AUDIOBOX, {"pq": 7.1}),
        FakeScorer(DNSMOS, {"bak": 4.2, "ovrl": 3.6}),
        FakeScorer(EMOTION),
    ]


class Engines:
    """Hands design one recording engine per trial round and keeps them for the assertions."""

    def __init__(self, wps: Sequence[float] = (3.0,)) -> None:
        self.wps = tuple(wps)
        self.made: list[RecordingEngine] = []

    def __call__(self, spec: EngineSpec, voices: Mapping[str, VoiceRef], env: Mapping[str, str]) -> RecordingEngine:
        engine = RecordingEngine(spec=spec, voices=voices, wps=self.wps)
        self.made.append(engine)
        return engine


@pytest.fixture
def env(tmp_path: Path) -> dict[str, str]:
    return {"HOME": str(tmp_path / "home"), "XDG_CONFIG_HOME": str(tmp_path / "config"), "HF_HUB_CACHE": str(tmp_path / "hf"), "USER": "tester"}


def _write_card(vault: Path, slug: str, traits: Mapping[str, object], embedding: np.ndarray) -> None:
    directory = vault / "casting" / "voices" / slug
    directory.mkdir(parents=True, exist_ok=True)
    card = {
        "slug": slug,
        "description": f"fixture voice {slug}",
        "reference": {"file": "reference.flac", "sha256": f"ref-{slug}"},
        "embedding": {"model": "fake/spectrum-embedder", "file": "embedding.ecapa.npy"},
        "traits": dict(traits),
        "admitted": {"by": "matt", "at": "2026-10-01T00:00:00Z", "gates": "pass", "approved_takes": 0},
    }
    (directory / "card.json").write_text(json.dumps(card, indent=2), encoding="utf-8")
    np.save(directory / "embedding.ecapa.npy", embedding.astype(np.float32))


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    root = tmp_path / "vault"
    for slug, traits in LIBRARY_CARDS.items():
        _write_card(root, slug, traits, EMBEDDINGS[slug])
    return root


@pytest.fixture
def work(vault: Path) -> Path:
    episodes = vault / "stories" / "ferry" / "outputs" / "radio" / "episodes"
    episodes.mkdir(parents=True)
    (episodes / "01-the-ferry-at-dusk.md").write_text(SCRIPT, encoding="utf-8")
    return vault / "stories" / "ferry"


def design(
    env: dict[str, str],
    vault: Path,
    work: Path,
    *extra: str,
    designer: FakeDesigner | None = None,
    mos: float = 4.1,
    engines: Engines | None = None,
    scorers: Callable[[], Sequence[FakeScorer]] | None = None,
) -> tuple[dict[str, object], int, FakeDesigner, Engines]:
    designer = designer or FakeDesigner(name="qwen3", pitch=high_male)
    engines = engines or Engines()

    def toolkits(env: Mapping[str, str], config: CastingConfig) -> Toolkit:
        return fake_toolkit(designer, mos=mos)

    (body, code), _ = run(
        ["cast", "--auto", "--design", "--work", str(work), "--vault", str(vault), "--seed", "40", *extra, "--json"],
        env,
        toolkits=toolkits,
        engines=engines,
        scorers=scorers or fake_scorers,
    )
    return body, code, designer, engines


def call(env: dict[str, str], *argv: str) -> tuple[dict[str, object], int]:
    (body, code), _ = run([*argv, "--json"], env)
    return body, code


def cast_json(work: Path) -> dict[str, dict[str, object]]:
    return json.loads((work / "outputs" / "radio" / "casting" / "cast.json").read_text(encoding="utf-8"))["roles"]


def receipts(work: Path) -> list[dict[str, object]]:
    return [json.loads(line) for line in receipts_path(work).read_text(encoding="utf-8").splitlines()]


def voice(vault: Path, slug: str) -> Path:
    return vault / "casting" / "voices" / slug


# ---- AC1: a needs_design role ends bound to a new, auto-admitted card whose trial passed every hard gate


def test_a_needs_design_role_is_bound_to_a_new_auto_admitted_card(env: dict[str, str], vault: Path, work: Path) -> None:
    body, code, _, engines = design(env, vault, work)
    assert code == 0, body
    assert body["needsDesign"] == [] and body["complete"] is True
    [designed] = body["designed"]  # type: ignore[misc]
    assert designed["role"] == "RAMON" and designed["slug"] == "ramon" and designed["round"] == 1

    card = json.loads((voice(vault, "ramon") / "card.json").read_text(encoding="utf-8"))
    admitted = card["admitted"]
    assert admitted["by"] == "auto" and admitted["gates"] == "pass" and card["by"] == "auto"
    assert admitted["candidate"] == designed["candidate"] and admitted["round"] == 1
    trial = admitted["trial"]
    assert trial["pass"] is True and trial["engine"] == "chatterbox-turbo"
    assert [line["text"] for line in trial["lines"]] == list(TRIAL_LINES)
    for line in trial["lines"]:
        assert line["pass"] is True and line["failing"] == []
        assert line["gates"]["sim_card"] == 0.8 and line["gates"]["utmos"] == 4.3
    assert admitted["screen"]["pass"] is True
    assert card["traits"] == normalise("RAMON", "m", "seventies, reedy, gruff, cool, period").traits
    # `cards.cast` writes the designer's provenance as the card's top-level `designed` block (AGT-1679);
    # its instruct is the one design on demand rendered the admitted candidate with.
    assert card["designed"]["instruct"] == admitted["instruct"] == describe_traits(card["traits"], (), 0)
    assert card["designed"]["candidate"] == admitted["candidate"]

    roles = cast_json(work)
    assert roles["CORA"]["by"] == "match"
    assert roles["RAMON"]["by"] == "design" and roles["RAMON"]["slug"] == "ramon"
    assert roles["RAMON"]["card_hash"] == card_hash(card) == designed["hash"]
    assert pin_state(vault / "casting" / "voices", roles["RAMON"]) == "ok"

    bound = {row["role"]: row for row in body["bindings"]}  # type: ignore[union-attr]
    assert bound["RAMON"]["by"] == "design" and bound["RAMON"]["new"] is True

    # The trial ran through the engine: three lines for each screened candidate, in that candidate's voice.
    [engine] = engines.made
    spoken = [call["inputs"].lines[0].text for call in engine.calls]
    assert spoken[:3] == list(TRIAL_LINES)


def test_the_trial_reference_is_the_reference_admitted(env: dict[str, str], vault: Path, work: Path) -> None:
    body, code, _, _ = design(env, vault, work)
    assert code == 0, body
    card = json.loads((voice(vault, "ramon") / "card.json").read_text(encoding="utf-8"))
    assert card["admitted"]["trial"]["reference_sha256"] == card["reference"]["sha256"]


def test_the_best_passing_candidate_is_admitted(env: dict[str, str], vault: Path, work: Path) -> None:
    # Candidates 1-3 fail the pitch screen (too low for "reedy"); the best of the rest is admitted.
    designer = FakeDesigner(name="qwen3", pitch=lambda instruct, seed: 100.0 if seed < 43 else 165.0 + (seed % 4) * 12.0)
    body, code, _, _ = design(env, vault, work, designer=designer)
    assert code == 0, body
    [designed] = body["designed"]  # type: ignore[misc]
    rounds = designed["rounds"]
    failing = {c["candidate"]: c["screen"]["failing"] for c in rounds[0]["candidates"]}
    assert failing[1] == failing[2] == failing[3] == ["pitch"]
    assert designed["candidate"] in (4, 5, 6)
    assert all("trial" not in c for c in rounds[0]["candidates"] if c["candidate"] <= 3)


def test_a_designed_voice_is_never_admitted_over_an_existing_card(env: dict[str, str], vault: Path, work: Path) -> None:
    # A retired "ramon" already holds the slug: the design takes ramon-2 and the old card is untouched.
    _write_card(vault, "ramon", {"gender": "f", "age": "20s"}, _rng.standard_normal(192))
    before = (voice(vault, "ramon") / "card.json").read_bytes()
    body, code, _, _ = design(env, vault, work)
    assert code == 0, body
    assert cast_json(work)["RAMON"]["slug"] == "ramon-2"
    assert (voice(vault, "ramon") / "card.json").read_bytes() == before


def test_the_harness_traits_replace_free_text_the_mapper_could_not_normalise(env: dict[str, str], vault: Path, work: Path) -> None:
    episodes = work / "outputs" / "radio" / "episodes"
    (episodes / "01-the-ferry-at-dusk.md").write_text(SCRIPT.replace('cool, period"', 'cool, period, sounds like a rusty gate"'), encoding="utf-8")
    described, code = call(env, "describe", "--describe", "sounds like a rusty gate", "--gender", "m", "--role", "RAMON")
    assert code == 0 and described["normalised"] is False and described["freeText"] == ["sounds like a rusty gate"]
    assert described["vocabulary"]["pitch"] == ["low-medium", "low", "medium-high", "high", "medium"]  # type: ignore[index]

    harness = {"RAMON": {"age": "70s", "pitch": "high", "register": "gruff"}}  # the harness's reading of the whole line
    body, code, designer, _ = design(env, vault, work, "--role-traits", json.dumps(harness))
    assert code == 0, body
    card = json.loads((voice(vault, "ramon") / "card.json").read_text(encoding="utf-8"))
    assert card["traits"] == {"gender": "m", "age": "70s", "pitch": "high", "register": "gruff"}
    assert card["admitted"]["traits_from"] == "harness"
    assert "rusty" not in designer.calls[0][0] and "seventies" in designer.calls[0][0]


def test_role_traits_that_contradict_the_cast_line_are_refused(env: dict[str, str], vault: Path, work: Path) -> None:
    body, code, _, _ = design(env, vault, work, "--role-traits", json.dumps({"RAMON": {"gender": "f"}}))
    assert code == 2 and "RAMON" in str(body["message"]) and "gender" in str(body["message"])
    body, code, _, _ = design(env, vault, work, "--role-traits", json.dumps({"NOBODY": {"gender": "f"}}))
    assert code == 2 and "NOBODY" in str(body["message"])


@pytest.mark.parametrize(
    ("raw", "says"),
    [("{not json", "not valid JSON"), (json.dumps(["RAMON"]), "must map role names"), (json.dumps({"RAMON": "m"}), "must map role names")],
)
def test_malformed_role_traits_are_refused_before_any_design(env: dict[str, str], vault: Path, work: Path, raw: str, says: str) -> None:
    body, code, designer, engines = design(env, vault, work, "--role-traits", raw)
    assert code == 2 and body["ok"] is False and says in str(body["message"])
    assert designer.calls == [] and engines.made == []
    # Refused at argument parsing: no card, and no cast.json written at all.
    assert not (voice(vault, "ramon") / "card.json").exists()
    assert not (work / "outputs" / "radio" / "casting" / "cast.json").exists()


# ---- AC2: no passing voice -> one retry with a re-phrased instruct, then a refusal naming the role; nothing admitted


def _assert_nothing_admitted(vault: Path, work: Path) -> None:
    assert not (voice(vault, "ramon") / "card.json").exists()
    assert "RAMON" not in cast_json(work)
    listed, _ = call({"HOME": "/nowhere", "XDG_CONFIG_HOME": "/nowhere"}, "voices", "list", "--auto-admitted", "--vault", str(vault))
    assert listed["voices"] == []


def test_no_natural_candidate_retries_once_then_refuses_naming_the_role(env: dict[str, str], vault: Path, work: Path) -> None:
    body, code, designer, engines = design(env, vault, work, mos=3.0)
    assert code == 2 and body["ok"] is False
    assert "no voice could be cast for RAMON" in str(body["message"])
    [refused] = body["refused"]  # type: ignore[misc]
    assert refused["role"] == "RAMON" and len(refused["rounds"]) == 2
    assert [row["role"] for row in body["needsDesign"]] == ["RAMON"]  # type: ignore[union-attr]

    # Two rounds of six; the second instruct re-phrases the first, with fresh seeds.
    instructs = list(dict.fromkeys(instruct for instruct, _, _ in designer.calls))
    assert len(designer.calls) == 12 and len(instructs) == 2 and instructs[0] != instructs[1]
    assert sorted({seed for _, _, seed in designer.calls}) == list(range(40, 52))
    assert all(c["screen"]["failing"] == ["naturalness"] for r in refused["rounds"] for c in r["candidates"])
    # The refusal says which gate turned them away and what to do next.
    assert refused["failures"] == {"naturalness": 12}
    assert "failures: naturalness 12" in str(body["message"]) and "auditions" in str(body["message"])
    assert "pablo cast --role RAMON --slug ramon --candidate N" in str(body["message"])
    assert engines.made == []  # nothing passed the screen, so nothing reached the engine
    _assert_nothing_admitted(vault, work)
    # The candidates stay on disk for a human to hear.
    assert len(list((voice(vault, "ramon") / "auditions").glob("*.wav"))) == 12


def test_a_failing_trial_retries_once_then_refuses(env: dict[str, str], vault: Path, work: Path) -> None:
    body, code, _, engines = design(env, vault, work, scorers=lambda: fake_scorers(sim=0.3))
    assert code == 2 and "no voice could be cast for RAMON" in str(body["message"])
    [refused] = body["refused"]  # type: ignore[misc]
    for summary in refused["rounds"]:
        for candidate in summary["candidates"]:
            assert candidate["screen"]["pass"] is True and candidate["trial"]["pass"] is False
            assert "identity" in candidate["trial"]["lines"][-1]["failing"]
    assert refused["failures"] == {"trial:identity": 12}
    assert len(engines.made) == 2  # one trial engine per round
    _assert_nothing_admitted(vault, work)


def test_a_role_off_the_cast_line_is_refused_by_name(env: dict[str, str], vault: Path, work: Path) -> None:
    episodes = work / "outputs" / "radio" / "episodes"
    (episodes / "01-the-ferry-at-dusk.md").write_text(SCRIPT + "BOSUN: All aboard.\n", encoding="utf-8")
    body, code, _, _ = design(env, vault, work)
    assert code == 2 and "BOSUN" in str(body["message"])
    assert cast_json(work)["RAMON"]["by"] == "design"  # the role that could be designed still was
    assert [r["role"] for r in body["refused"]] == ["BOSUN"]  # type: ignore[union-attr]
    assert "add it to the CAST: line" in str(body["message"]) and "--role-traits" in str(body["message"])

    # The next step it names works: the harness's role-traits give BOSUN a gender to design from.
    again, code, _, _ = design(env, vault, work, "--role-traits", json.dumps({"BOSUN": {"gender": "m", "pitch": "high"}}))
    assert code == 0, again
    assert cast_json(work)["BOSUN"]["by"] == "design"


def test_design_flags_without_design_are_refused(env: dict[str, str], vault: Path, work: Path) -> None:
    body, code = call(env, "cast", "--auto", "--work", str(work), "--vault", str(vault), "-n", "3")
    assert code == 2 and "--design" in str(body["message"])
    body, code = call(env, "cast", "--role", "RAMON", "--candidate", "1", "--design", "--vault", str(vault))
    assert code == 2 and "--auto" in str(body["message"])


# ---- AC3: voices list --auto-admitted shows the new card; voices retire works on it


def test_voices_list_auto_admitted_shows_the_new_card_and_retire_works_on_it(env: dict[str, str], vault: Path, work: Path) -> None:
    body, code, _, _ = design(env, vault, work)
    assert code == 0, body
    listed, code = call(env, "voices", "list", "--auto-admitted", "--vault", str(vault))
    assert code == 0 and [row["slug"] for row in listed["voices"]] == ["ramon"]  # type: ignore[union-attr]
    assert listed["voices"][0]["admitted_by"] == "auto"  # type: ignore[index]

    pin = cast_json(work)["RAMON"]
    retired, code = call(env, "voices", "retire", "ramon", "--reason", "too close to a new card", "--vault", str(vault))
    assert code == 0 and retired["changed"] is True and retired["hash"] == pin["card_hash"]
    assert pin_state(vault / "casting" / "voices", pin) == "ok"  # the story that bound it still performs

    listed, _ = call(env, "voices", "list", "--auto-admitted", "--vault", str(vault))
    assert listed["voices"][0]["retired"] is True  # type: ignore[index]
    # A retired voice is never matched again: a fresh story's RAMON needs design anew.
    (work / "outputs" / "radio" / "casting" / "cast.json").unlink()
    again, code = call(env, "cast", "--auto", "--work", str(work), "--vault", str(vault))
    assert code == 0 and [row["role"] for row in again["needsDesign"]] == ["RAMON"]  # type: ignore[union-attr]


# ---- AC4: receipts cover the design and trial passes


def test_receipts_cover_the_design_and_the_trial(env: dict[str, str], vault: Path, work: Path) -> None:
    body, code, _, engines = design(env, vault, work)
    assert code == 0, body
    rows = receipts(work)
    auditions = [r for r in rows if r["intent"] == "audition"]
    assert len(auditions) == 6 and all(r["stage"] == "design" and r["role"] == "RAMON" and r["round"] == 1 for r in auditions)

    trial = [r for r in rows if r.get("stage") == "design-trial"]
    loads = [r for r in trial if r["intent"] == "load"]
    takes = [r for r in trial if r["intent"] == "take"]
    gates = [r for r in trial if r["intent"] == "gate"]
    assert len(loads) == 1
    [engine] = engines.made
    assert len(takes) == len(gates) == len(engine.calls) == 3 * 6  # every candidate passed the screen and the trial
    assert all(r["role"] == "RAMON" and r["voice"] == "ramon" and isinstance(r["candidate"], int) for r in takes + gates)
    assert {r["candidate"] for r in takes} == {1, 2, 3, 4, 5, 6}

    [summary] = [r for r in rows if r["intent"] == "design"]
    assert summary["role"] == "RAMON" and summary["round"] == 1 and summary["chosen"] == body["designed"][0]["candidate"]  # type: ignore[index]
    [admitted] = [r for r in rows if r["intent"] == "cast"]
    assert admitted["voice"] == "ramon" and admitted["card_hash"] == body["designed"][0]["hash"]  # type: ignore[index]


def test_a_refused_design_leaves_receipts_for_both_rounds(env: dict[str, str], vault: Path, work: Path) -> None:
    design(env, vault, work, scorers=lambda: fake_scorers(sim=0.3))
    rows = receipts(work)
    assert [r["round"] for r in rows if r["intent"] == "design"] == [1, 2]
    assert [r["chosen"] for r in rows if r["intent"] == "design"] == [None, None]
    assert {r["round"] for r in rows if r.get("stage") == "design-trial" and r["intent"] == "take"} == {1, 2}
    assert not [r for r in rows if r["intent"] == "cast"]


# ---- the screens and the mapper


def test_pitch_bands() -> None:
    assert pitch_band({"gender": "m", "pitch": "high"}) == PITCH_HZ["m"]["high"]
    assert pitch_band({"gender": "f"}) == (130.0, 330.0)
    assert pitch_band({}) == (65.0, 330.0)
    low, high = pitch_band({"pitch": "low"})
    assert low == PITCH_HZ["m"]["low"][0] and high == PITCH_HZ["f"]["low"][1]


def test_a_candidate_that_sounds_like_a_library_voice_fails_distinctness(vault: Path) -> None:
    record = {"scores": {"utmos": 4.2, "pitch_hz": 170.0}, "trim": {"ok": True}}
    voices = load_voices(Library(vault / "casting"))
    same = screen(record, EMBEDDINGS["edwin"], {"gender": "m", "pitch": "high"}, voices, 0.75)
    assert same["failing"] == ["distinctness"] and same["closest"] == {"slug": "edwin", "ecapa": 1.0}
    apart = screen(record, -EMBEDDINGS["edwin"], {"gender": "m", "pitch": "high"}, voices, 0.75)
    assert apart["pass"] is True


def test_the_instruct_is_re_phrased_for_the_retry_and_keeps_free_text() -> None:
    traits = {"gender": "f", "age": "30s", "pitch": "low-medium", "warmth": "warm", "register": "dry", "era": "period"}
    first = describe_traits(traits, ("smells of pipe smoke",), 0)
    second = describe_traits(traits, ("smells of pipe smoke",), 1)
    assert first != second
    for text in (first, second):
        assert "low-medium" in text and "dry" in text and "warm" in text and "moke" in text
    assert describe_traits({"gender": "m"}) == "A man."
