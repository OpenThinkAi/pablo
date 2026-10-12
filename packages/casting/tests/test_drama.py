"""`[DRAMA]` scenes (AGT-1888): the markers, the dramatic engine, perform, fix, mix and check. Model-free.

The dramatic lines go through the original Chatterbox spec and the rest through
the episode's engine, each a recording fake. Every script, card and voice here
is invented; nothing reads a real vault.
"""

from __future__ import annotations

import io
from collections.abc import Mapping
from pathlib import Path

import numpy as np
import pytest
from test_fix import flag
from test_mix import seams
from test_perform import Factory, fake_scorers, go, make_card, setup  # noqa: F401  (setup is a fixture)

from pablo_casting.binding import bind
from pablo_casting.cli import run
from pablo_casting.engines import (
    CHATTERBOX,
    CHATTERBOX_CFG_WEIGHT,
    CHATTERBOX_EXAGGERATION,
    CHATTERBOX_REF_PEAK,
    CHATTERBOX_REF_RMS,
    CHATTERBOX_TEMPERATURE,
    DIA,
    DRAMA_ENGINE,
    ENGINE_SPECS,
    TURBO,
    TURBO_MIN_REF_S,
    EngineSpec,
    MlxEngine,
    Pass,
    PassLine,
    RecordingEngine,
    VoiceRef,
    adapt,
    chatterbox_text,
    level_reference,
)
from pablo_casting.fix import FixRequest, fix
from pablo_casting.manifest import read_version
from pablo_casting.script import parse_script
from pablo_casting.takes import EngineId, Line, TakeInputs, read_take

DRAMA_SCRIPT = """CAST: MAVIS=f "forties, warm, quick", OTTO=m "sixties, gruff"
[MUSIC: a brass sting]
MAVIS: Good evening from the harbour, where the fog is in.
[DRAMA]
[SFX: a crash on the quay]
OTTO: (gasps) He is hurt, help me get him in.
MAVIS: (afraid) Put him on the table (sighs) gently,
gently now.
[DRAMA: off]
OTTO: (laughs) He will live, Mavis.
"""
PLAIN_SCRIPT = "\n".join(line for line in DRAMA_SCRIPT.splitlines() if not line.startswith("[DRAMA")) + "\n"

# The take keys `perform` gave test_perform's SCRIPT before AGT-1888 (recording engine, wps 3.0):
# an episode without a scene must keep every one, or every existing episode would re-render.
UNMARKED_KEYS = [
    "38f5040c1326803236afa9ae6976eaa5861fd37b0b77b1f09becec4b75974129",
    "8b171a10c5efaa4eabf1201757a668974b9b6775c38ea9b5cda026ece5876ef2",
    "8e9a1bc26bbe0a3b3b6c907992d3476851c2835e07d9f04486a9b58432c9e2a6",
    "8407e414952282fcd25e55df1fedb36e5618341a288ebaa3e82d312dfa1b4192",
]


class Engines:
    """Hands `perform` one recording engine per spec and keeps them all, by spec name."""

    def __init__(self, **kwargs: object) -> None:
        self.kwargs = kwargs
        self.made: dict[str, RecordingEngine] = {}

    def __call__(self, spec: EngineSpec, voices: Mapping[str, VoiceRef], env: Mapping[str, str]) -> RecordingEngine:
        engine = RecordingEngine(spec=spec, voices=voices, **self.kwargs)  # type: ignore[arg-type]
        self.made[spec.name] = engine
        return engine

    def lines(self, name: str) -> list[list[str]]:
        """The script lines each pass of the named engine voiced."""
        return [[line.text for line in call["inputs"].lines] for call in self.made[name].calls]  # type: ignore[attr-defined]


def make_work(tmp_path: Path, script: str, name: str = "work") -> tuple[Path, Path]:
    work = tmp_path / name
    episodes = work / "outputs" / "radio" / "episodes"
    episodes.mkdir(parents=True)
    (episodes / "01-the-harbour-light.md").write_text(script, encoding="utf-8")
    library = tmp_path / "library"
    if not (library / "voices" / "mavis").exists():
        make_card(library, "mavis")
        make_card(library, "otto")
    bind(work, library / "voices", "MAVIS", "mavis")
    bind(work, library / "voices", "OTTO", "otto")
    return work, library


# --- the markers ------------------------------------------------------------------


def test_lines_between_the_markers_are_dramatic_and_the_markers_make_no_item() -> None:
    script = parse_script(DRAMA_SCRIPT)
    assert [(line.speaker, line.drama) for line in script.lines] == [("MAVIS", False), ("OTTO", True), ("MAVIS", True), ("OTTO", False)]
    assert script.lines[2].text == "Put him on the table (sighs) gently, gently now."  # a continuation stays in its scene
    assert [cue.kind for cue in script.cues] == ["MUSIC", "SFX"]
    assert len(script.items) == 6
    assert "[DRAMA" not in " ".join(line.text for line in script.lines)
    assert script.drama_markers() == []
    assert script.lines[1].as_body()["drama"] is True and "drama" not in script.lines[0].as_body()


def test_an_unclosed_scene_runs_to_the_end_of_the_episode() -> None:
    script = parse_script("CAST: A=f, B=m\nA: One.\n[drama]\nB: Two.\nA: Three.\n")
    assert [line.drama for line in script.lines] == [False, True, True]
    assert script.drama_markers() == []


def test_unpaired_markers_are_reported_and_otherwise_change_nothing() -> None:
    script = parse_script("CAST: A=f, B=m\nA: One.\n[DRAMA: off]\n[DRAMA]\nB: Two.\n[DRAMA]\nA: Three.\n[DRAMA: off]\nB: Four.\n")
    assert [line.drama for line in script.lines] == [False, True, True, False]
    assert script.drama_markers() == [
        {"line": 3, "text": "[DRAMA: off]", "problem": "unopened"},
        {"line": 6, "text": "[DRAMA]", "problem": "nested", "open": 4},
    ]


# --- the engine ---------------------------------------------------------------------


def test_the_dramatic_engine_is_the_original_chatterbox_and_not_an_engine_choice() -> None:
    assert DRAMA_ENGINE is CHATTERBOX
    assert (CHATTERBOX.repo, CHATTERBOX.grouping, CHATTERBOX.pace) == ("mlx-community/Chatterbox-TTS-fp16", "line", "stretch")
    assert CHATTERBOX.name not in ENGINE_SPECS
    assert (CHATTERBOX_EXAGGERATION, CHATTERBOX_CFG_WEIGHT, CHATTERBOX_TEMPERATURE) == (0.5, 0.5, 0.8)


def test_chatterbox_never_reads_a_non_verbal_aloud() -> None:
    text = "(gasps) He is hurt (sighs) gently (laughs) now (clears throat) (coughs) in 1917."
    assert chatterbox_text(text) == "He is hurt gently now in nineteen seventeen."


def test_chatterbox_params_carry_its_controls_and_turbos_reference_padding() -> None:
    take_pass = Pass((PassLine(0, "OTTO", "Help me.", True),))
    long = {"OTTO": VoiceRef("c" * 64, "otto", Path("ref.flac"), "", 24.0)}
    short = {"OTTO": VoiceRef("c" * 64, "otto", Path("ref.flac"), "", 3.0)}
    params = adapt(CHATTERBOX, take_pass, long, "afraid", 3)
    assert params == {"adapter": "chatterbox/2", "temperature": 0.8, "exaggeration": 0.5, "cfg_weight": 0.5, "ref_rms": 0.05, "ref_peak_cap": 0.9}
    assert adapt(CHATTERBOX, take_pass, short, None, None)["ref_pad_to_s"] == TURBO_MIN_REF_S
    assert adapt(CHATTERBOX, take_pass, long, None, None, ("flat",))["temperature"] == 0.95


def test_only_chatterbox_params_carry_the_reference_levelling() -> None:
    take_pass = Pass((PassLine(0, "OTTO", "Help me.", True),))
    voices = {"OTTO": VoiceRef("c" * 64, "otto", Path("ref.flac"), "", 24.0)}
    assert {"ref_rms", "ref_peak_cap"} <= set(adapt(CHATTERBOX, take_pass, voices, None, None))
    for spec in ENGINE_SPECS.values():
        assert not {"ref_rms", "ref_peak_cap"} & set(adapt(spec, take_pass, voices, None, None))
    assert (CHATTERBOX_REF_RMS, CHATTERBOX_REF_PEAK) == (0.05, 0.9)


def _tone(amp: float, n: int = 24_000) -> np.ndarray:
    return (amp * np.sin(np.linspace(0, 400 * np.pi, n))).astype(np.float32)


def _rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))


def test_level_reference_brings_a_hot_reference_down_to_the_target_rms() -> None:
    hot = _tone(1.0) * 1.0
    out = level_reference(hot, 0.05, 0.9)
    assert _rms(out) == pytest.approx(0.05, rel=1e-3)
    assert float(np.abs(out).max()) < 0.9


def test_level_reference_caps_the_peak_of_a_spiky_reference() -> None:
    spiky = _tone(0.02)
    spiky[100] = 1.0
    out = level_reference(spiky, 0.05, 0.9)
    assert float(np.abs(out).max()) == pytest.approx(0.9, rel=1e-4)
    assert _rms(out) <= 0.05


def test_level_reference_leaves_silence_alone() -> None:
    assert not level_reference(np.zeros(100, np.float32), 0.05, 0.9).any()
    assert level_reference(np.zeros(0, np.float32), 0.05, 0.9).size == 0


class _Result:
    def __init__(self, audio: np.ndarray) -> None:
        self.audio, self.sample_rate = audio, 24_000


class _FakeModel:
    sample_rate = 24_000

    def __init__(self) -> None:
        self.refs: list[np.ndarray] = []

    def generate(self, *, text: str, temperature: float, ref_audio: np.ndarray, **controls: object):  # type: ignore[no-untyped-def]
        self.refs.append(np.asarray(ref_audio))
        yield _Result(np.zeros(2400, np.float32))


def _synthesize(monkeypatch: pytest.MonkeyPatch, spec: EngineSpec, seconds: float, amp: float) -> np.ndarray:
    import sys
    import types

    import pablo_casting.audio as audio

    core = types.SimpleNamespace(
        array=np.asarray, reset_peak_memory=lambda: None, get_peak_memory=lambda: 0,
        random=types.SimpleNamespace(seed=lambda _s: None),
    )
    mlx = types.ModuleType("mlx")
    mlx.core = core  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "mlx", mlx)
    monkeypatch.setitem(sys.modules, "mlx.core", core)  # type: ignore[arg-type]
    monkeypatch.setattr(audio, "read_audio", lambda _path: (_tone(amp, int(24_000 * seconds)), 24_000))
    voices = {"OTTO": VoiceRef("c" * 64, "otto", Path("ref.flac"), "", seconds)}
    take_pass = Pass((PassLine(0, "OTTO", "Help me.", True),))
    engine = MlxEngine(spec, voices, {})
    model = _FakeModel()
    engine._model = model
    params = adapt(spec, take_pass, voices, None, None)
    engine.synthesize(TakeInputs(EngineId("x", "y", "z", "w"), "c" * 64, (Line("OTTO", "Help me."),), 1, params=params))
    return model.refs[0]


def test_a_hot_reference_reaches_chatterbox_levelled_and_turbo_untouched(monkeypatch: pytest.MonkeyPatch) -> None:
    drama = _synthesize(monkeypatch, CHATTERBOX, 6.0, 1.0)
    assert _rms(drama) == pytest.approx(0.05, rel=1e-3)
    assert float(np.abs(drama).max()) <= 0.9
    turbo = _synthesize(monkeypatch, TURBO, 6.0, 1.0)
    assert float(np.abs(turbo).max()) == pytest.approx(1.0, rel=1e-3)


def test_chatterbox_levels_before_it_pads_a_short_reference(monkeypatch: pytest.MonkeyPatch) -> None:
    ref = _synthesize(monkeypatch, CHATTERBOX, 3.0, 1.0)
    assert ref.size == int(TURBO_MIN_REF_S * 24_000)
    assert _rms(ref[: 3 * 24_000]) == pytest.approx(0.05, rel=1e-3)
    assert not ref[3 * 24_000 :].any()


# --- perform ------------------------------------------------------------------------


def test_dramatic_lines_go_through_chatterbox_and_the_rest_through_turbo_in_one_run(tmp_path: Path) -> None:
    work, library = make_work(tmp_path, DRAMA_SCRIPT)
    engines = Engines(wps=(3.0,))
    body, code, err, _ = go(work, library, engines)  # type: ignore[arg-type]
    assert code == 0, body
    assert set(engines.made) == {TURBO.name, CHATTERBOX.name}
    assert engines.lines(TURBO.name) == [["Good evening from the harbour, where the fog is in."], ["(laughs) He will live, Mavis."]]
    assert engines.lines(CHATTERBOX.name) == [["(gasps) He is hurt, help me get him in."], ["Put him on the table (sighs) gently, gently now."]]
    heard = [call["text"] for call in engines.made[CHATTERBOX.name].calls]
    assert heard == ["He is hurt, help me get him in.", "Put him on the table gently, gently now."]

    manifest = read_version(work, 1, 1)
    lines = manifest["lines"]
    assert manifest["engine"]["name"] == TURBO.name  # type: ignore[index]
    assert [line.get("drama", False) for line in lines] == [False, True, True, False]  # type: ignore[union-attr]
    assert [line["engine"]["name"] if "engine" in line else None for line in lines] == [None, "chatterbox", "chatterbox", None]  # type: ignore[index,union-attr,operator]
    assert lines[1]["engine"]["repo"] == CHATTERBOX.repo and lines[1]["engine"]["revision"] == CHATTERBOX.revision  # type: ignore[index]
    take = read_take(work, str(lines[1]["take"]))  # type: ignore[index]
    assert take is not None
    params = take.record["inputs"]["params"]  # type: ignore[index]
    assert (params["adapter"], params["exaggeration"], params["cfg_weight"], params["temperature"]) == ("chatterbox/2", 0.5, 0.5, 0.8)  # type: ignore[index]
    # Both engines were loaded (two load receipts) and the start event names the second.
    assert '"drama_engine": "chatterbox"' in err
    # The markers are not cues: the manifest's cues are the script's two.
    assert [(cue["kind"], cue["after"]) for cue in manifest["cues"]] == [("MUSIC", -1), ("SFX", 0)]  # type: ignore[index,union-attr]


def test_a_dramatic_take_never_shares_a_key_with_the_turbo_take_of_the_same_line(tmp_path: Path) -> None:
    drama_work, library = make_work(tmp_path, DRAMA_SCRIPT, "drama")
    plain_work, _ = make_work(tmp_path, PLAIN_SCRIPT, "plain")
    assert go(drama_work, library, Engines(wps=(3.0,)))[1] == 0  # type: ignore[arg-type]
    assert go(plain_work, library, Engines(wps=(3.0,)))[1] == 0  # type: ignore[arg-type]
    drama = [line["take"] for line in read_version(drama_work, 1, 1)["lines"]]  # type: ignore[index,union-attr]
    plain = [line["take"] for line in read_version(plain_work, 1, 1)["lines"]]  # type: ignore[index,union-attr]
    assert (drama[0], drama[3]) == (plain[0], plain[3])
    assert drama[1] != plain[1] and drama[2] != plain[2]


def test_an_episode_without_a_scene_loads_one_engine_and_keeps_its_take_keys(setup: tuple[Path, Path]) -> None:  # noqa: F811
    work, library = setup
    engines = Engines(wps=(3.0,))
    body, code, err, _ = go(work, library, engines)  # type: ignore[arg-type]
    assert code == 0, body
    assert list(engines.made) == [TURBO.name]
    manifest = read_version(work, 1, 1)
    assert [line["take"] for line in manifest["lines"]] == UNMARKED_KEYS  # type: ignore[index,union-attr]
    assert all("engine" not in line and "drama" not in line for line in manifest["lines"])  # type: ignore[union-attr,operator]
    assert "drama_engine" not in err


def test_under_dia_a_scene_is_still_one_line_per_chatterbox_pass(tmp_path: Path) -> None:
    work, library = make_work(tmp_path, DRAMA_SCRIPT)
    engines = Engines(wps=(3.0,))
    body, code, _, _ = go(work, library, engines, engine=DIA.name)  # type: ignore[arg-type]
    assert code == 0, body
    assert [len(lines) for lines in engines.lines(CHATTERBOX.name)] == [1, 1]
    assert engines.lines(DIA.name) == [["Good evening from the harbour, where the fog is in."], ["(laughs) He will live, Mavis."]]


# --- fix and mix ----------------------------------------------------------------------


def _fix(work: Path, library: Path, engines: Engines):  # type: ignore[no-untyped-def]
    return fix(
        FixRequest(work=work, episode=1, voices_dir=library / "voices"),
        env={},
        engine_factory=engines,
        scorer_factory=lambda: fake_scorers(),
        mixer=None,
        err=io.StringIO(),
    )


def test_a_retake_of_a_dramatic_line_uses_the_dramatic_engine(tmp_path: Path) -> None:
    work, library = make_work(tmp_path, DRAMA_SCRIPT)
    assert go(work, library, Engines(wps=(3.0,)))[1] == 0  # type: ignore[arg-type]
    flag(work, (2, "flat"), (3, "other"))
    engines = Engines(wps=(3.0,))
    body, code = _fix(work, library, engines)
    assert code == 0, body
    assert body["changedLines"] == [2, 3]
    assert engines.lines(CHATTERBOX.name) == [["Put him on the table (sighs) gently, gently now."]]
    assert engines.lines(TURBO.name) == [["(laughs) He will live, Mavis."]]
    retake = engines.made[CHATTERBOX.name].calls[0]["inputs"]
    assert retake.params["adapter"] == "chatterbox/2" and retake.params["temperature"] == 0.95  # type: ignore[attr-defined]
    v2 = read_version(work, 1, 2)
    assert v2["lines"][2]["engine"]["name"] == CHATTERBOX.name and v2["lines"][2]["drama"] is True  # type: ignore[index]
    assert "engine" not in v2["lines"][3]  # type: ignore[index,operator]


def test_a_fix_with_no_dramatic_line_flagged_loads_only_the_episode_engine(tmp_path: Path) -> None:
    work, library = make_work(tmp_path, DRAMA_SCRIPT)
    assert go(work, library, Engines(wps=(3.0,)))[1] == 0  # type: ignore[arg-type]
    flag(work, (0, "rushed"))
    engines = Engines(wps=(3.0,))
    body, code = _fix(work, library, engines)
    assert code == 0, body
    assert list(engines.made) == [TURBO.name]


def test_the_mix_makes_no_clip_or_cue_for_the_markers(tmp_path: Path) -> None:
    work, library = make_work(tmp_path, DRAMA_SCRIPT)
    assert go(work, library, Engines(wps=(3.0,)))[1] == 0  # type: ignore[arg-type]
    mixer, cues = seams()
    (body, code), _ = run(["mix", "--work", str(work), "--episode", "1", "--cues", str(tmp_path / "cues")], {}, mixer=mixer)
    assert code == 0, body
    assert cues.made == [("MUSIC", "a brass sting"), ("SFX", "a crash on the quay")]
    assert [cue["kind"] for cue in read_version(work, 1, 1)["cues"]] == ["MUSIC", "SFX"]  # type: ignore[index,union-attr]


# --- check ----------------------------------------------------------------------------


@pytest.fixture
def env(tmp_path: Path) -> dict[str, str]:
    return {"HOME": str(tmp_path / "home"), "XDG_CONFIG_HOME": str(tmp_path / "config"), "HF_HUB_CACHE": str(tmp_path / "hf")}


def test_check_flags_an_unmatched_off_and_a_nested_scene(env: dict[str, str], tmp_path: Path) -> None:
    work, _ = make_work(tmp_path, 'CAST: MAVIS=f "forties", OTTO=m "sixties"\nMAVIS: One.\n[DRAMA: off]\n[DRAMA]\nOTTO: Two.\n[DRAMA]\nMAVIS: Three.\n')
    (body, code), _ = run(["check", "--work", str(work), "--json"], env)
    assert code == 0, body
    assert [(m["line"], m["problem"]) for m in body["dramaMarkers"]] == [(3, "unopened"), (6, "nested")]  # type: ignore[union-attr,index]
    assert body["dramaMarkers"][0]["file"] == "outputs/radio/episodes/01-the-harbour-light.md"  # type: ignore[index]


def test_check_is_quiet_about_a_paired_scene(env: dict[str, str], tmp_path: Path) -> None:
    work, _ = make_work(tmp_path, DRAMA_SCRIPT)
    (body, code), _ = run(["check", "--work", str(work), "--json"], env)
    assert code == 0 and body["dramaMarkers"] == []
