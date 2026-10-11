"""`perform` end to end over a recording fake engine and fake scorers (AGT-1683). Model-free.

Every script, card and voice here is invented; nothing reads a real vault.
"""

from __future__ import annotations

import io
import json
from collections.abc import Mapping, Sequence
from pathlib import Path

import pytest

from pablo_casting.binding import bind, cast_path, casting_dir
from pablo_casting.cli import run
from pablo_casting.engines import DIA, TURBO, EngineSpec, RecordingEngine, VoiceRef
from pablo_casting.manifest import episode_dir, flags_path, read_version
from pablo_casting.perform import PACE_RANGE, PerformRequest, perform
from pablo_casting.receipts import receipts_path
from pablo_casting.scorers import ALIGNER, AUDIOBOX, DNSMOS, ECAPA, EMOTION, UTMOS, WHISPER, ScorerInfo, ScorerUnavailable, Take
from pablo_casting.takes import read_take
from pablo_casting.words import script_word_count

SCRIPT = """CAST: MAVIS=f "forties, warm, quick", OTTO=m "sixties, gruff"
[MUSIC: a brass sting]
MAVIS: Good evening from THE HARBOUR LIGHT, where the fog is in.
OTTO: (tender, slow) Mind the step, the boards are wet tonight.
[SFX: a door creaks]
MAVIS: (laughs) You always say that, Otto.
OTTO: And I am always right.
"""


class FakeScorer:
    def __init__(self, info: ScorerInfo, answer: Mapping[str, object] | None = None) -> None:
        self.info = info
        self.answer = dict(answer or {})

    def score(self, take: Take) -> Mapping[str, object]:
        if self.info is WHISPER:
            return {"wer": 0.0, "inserted_span": 0, "tail_ok": True, "cut": round(take.seconds, 3), "heard": take.line}
        if self.info is ALIGNER:
            words = script_word_count(take.line)
            spoken = take.seconds - 0.18
            step = spoken / words
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


def make_card(library: Path, slug: str, wps: float = 2.8) -> None:
    card_dir = library / "voices" / slug
    card_dir.mkdir(parents=True)
    (card_dir / "reference.flac").write_bytes(b"not audio: the recording engine never reads it")
    (card_dir / "reference.txt").write_text(f"the invented {slug} reading\n", encoding="utf-8")
    (card_dir / "embedding.ecapa.npy").write_bytes(b"fake")
    card = {
        "slug": slug,
        "description": f"an invented test voice, {slug}",
        "reference": {"file": "reference.flac", "sha256": "0" * 64, "seconds": 24.0, "transcript": "reference.txt", "sample_rate": 24000},
        "embedding": {"model": "speechbrain/spkrec-ecapa-voxceleb", "file": "embedding.ecapa.npy"},
        "pace": {"wps": wps, "band": [2.4, 3.4]},
    }
    (card_dir / "card.json").write_text(json.dumps(card, indent=2) + "\n", encoding="utf-8")


@pytest.fixture
def setup(tmp_path: Path) -> tuple[Path, Path]:
    work = tmp_path / "work"
    episodes = work / "outputs" / "radio" / "episodes"
    episodes.mkdir(parents=True)
    (episodes / "01-the-harbour-light.md").write_text(SCRIPT, encoding="utf-8")
    library = tmp_path / "library"
    make_card(library, "mavis")
    make_card(library, "otto")
    bind(work, library / "voices", "MAVIS", "mavis")
    bind(work, library / "voices", "OTTO", "otto")
    return work, library


class Factory:
    """Hands `perform` one recording engine and keeps it for the assertions."""

    def __init__(self, **kwargs: object) -> None:
        self.kwargs = kwargs
        self.engine: RecordingEngine | None = None

    def __call__(self, spec: EngineSpec, voices: Mapping[str, VoiceRef], env: Mapping[str, str]) -> RecordingEngine:
        self.engine = RecordingEngine(spec=spec, voices=voices, **self.kwargs)  # type: ignore[arg-type]
        return self.engine


def go(work: Path, library: Path, factory: Factory, *, engine: str = TURBO.name, scorers: Sequence[FakeScorer] | None = None, json_lines: bool = False):
    err, out = io.StringIO(), io.StringIO()
    body, code = perform(
        PerformRequest(work=work, episode=1, engine=engine, voices_dir=library / "voices", json_lines=json_lines),
        env={},
        engine_factory=factory,
        scorer_factory=lambda: scorers if scorers is not None else fake_scorers(),
        err=err,
        out=out,
    )
    return body, code, err.getvalue(), out.getvalue()


def receipts(work: Path, intent: str) -> list[dict[str, object]]:
    rows = [json.loads(line) for line in receipts_path(work).read_text(encoding="utf-8").splitlines()]
    return [row for row in rows if row.get("intent") == intent]


# AC1 -------------------------------------------------------------------------


def test_episode_renders_end_to_end_into_takes_and_v1(setup: tuple[Path, Path]) -> None:
    work, library = setup
    body, code, err, _ = go(work, library, Factory(wps=(3.0,)))
    assert code == 0, body
    assert body["version"] == 1 and body["lines"] == 4 and body["pass"] == 4
    manifest = read_version(work, 1, 1)
    assert manifest["parent"] is None and manifest["changed_lines"] == [0, 1, 2, 3]
    for line in manifest["lines"]:
        take = read_take(work, line["take"])
        assert take is not None
        assert line["status"] == "pass" and take.record["status"] == "pass"
        assert {"wer", "sim_card", "utmos", "bak", "ovrl", "wps", "stretch"} <= set(take.record["scores"])
        assert line["gates"]["sim_card"] == 0.8
    assert [c["kind"] for c in manifest["cues"]] == ["MUSIC", "SFX"]
    assert [c["after"] for c in manifest["cues"]] == [-1, 1]
    events = [json.loads(line) for line in err.splitlines()]
    assert [e["event"] for e in events] == ["start", "line", "line", "line", "line", "done"]
    assert [e["i"] for e in events if e["event"] == "line"] == [0, 1, 2, 3]
    assert all(Path(e["path"]).is_file() for e in events if e["event"] == "line")


def test_json_lines_puts_the_same_events_on_stdout(setup: tuple[Path, Path]) -> None:
    work, library = setup
    _, code, err, out = go(work, library, Factory(wps=(3.0,)), json_lines=True)
    assert code == 0
    assert out == err and len(out.splitlines()) == 6


def test_cli_perform_resolves_the_library_as_cast_writes_it(setup: tuple[Path, Path], capsys: pytest.CaptureFixture[str]) -> None:
    work, library = setup
    factory = Factory(wps=(3.0,))
    (body, code), _ = run(
        ["perform", "--work", str(work), "--episode", "1", "--library", str(library), "--json-lines", "--json"],
        {},
        scorers=fake_scorers,
        engines=factory,
    )
    assert code == 0, body
    stdout = capsys.readouterr().out.splitlines()
    assert [json.loads(line)["event"] for line in stdout] == ["start", "line", "line", "line", "line", "done"]
    assert body["manifest"].endswith("renders/ep01/v1.json")


# AC2 -------------------------------------------------------------------------


def test_tender_slow_reaches_the_engine_mapped_and_ends_in_its_pace_band(setup: tuple[Path, Path]) -> None:
    work, library = setup
    factory = Factory(wps=(3.0,))
    _, code, _, _ = go(work, library, factory)
    assert code == 0
    engine = factory.engine
    assert engine is not None
    call = next(c for c in engine.calls if c["inputs"].lines[0].speaker == "OTTO" and "step" in c["inputs"].lines[0].text)
    inputs = call["inputs"]
    assert (inputs.direction.emotion, inputs.direction.intensity, inputs.direction.pace) == ("tender", 2, "slow")
    # Turbo maps no emotion (bake-off decision): exactly its defaults reach it, and the slow pace is a stretch.
    assert dict(inputs.params) == {"adapter": "chatterbox-turbo/1", "temperature": 0.8}
    assert call["text"] == "Mind the step, the boards are wet tonight."
    line = read_version(work, 1, 1)["lines"][1]
    assert line["pace"]["target_wps"] == round(2.8 * 0.85, 3)
    assert line["pace"]["band"] == [round(2.4 * 0.85, 3), round(3.4 * 0.85, 3)]
    low, high = line["pace"]["band"]
    assert low <= line["pace"]["paced_wps"] <= high
    assert line["stretch"] == pytest.approx(2.89 / 3.0, abs=0.002)  # out of the slowed band: to its edge, not the target


def test_caps_reach_the_engine_capitalised_and_the_script_text_is_unchanged(setup: tuple[Path, Path]) -> None:
    work, library = setup
    factory = Factory(wps=(3.0,))
    go(work, library, factory)
    assert factory.engine is not None
    first = factory.engine.calls[0]
    assert first["text"] == "Good evening from The Harbour Light, where the fog is in."
    assert first["inputs"].lines[0].text == "Good evening from THE HARBOUR LIGHT, where the fog is in."
    assert read_version(work, 1, 1)["lines"][0]["text"] == "Good evening from THE HARBOUR LIGHT, where the fog is in."
    assert "THE HARBOUR LIGHT" in (work / "outputs" / "radio" / "episodes" / "01-the-harbour-light.md").read_text(encoding="utf-8")
    laugh = factory.engine.calls[2]
    assert laugh["text"] == "[laugh] You always say that, Otto."


# AC3 -------------------------------------------------------------------------


def test_an_in_band_line_is_not_stretched(setup: tuple[Path, Path]) -> None:
    work, library = setup
    assert go(work, library, Factory(wps=(3.0,)))[1] == 0  # inside the 2.4-3.4 band
    lines = read_version(work, 1, 1)["lines"]
    assert [line["stretch"] for line in lines if line["i"] != 1] == [1.0, 1.0, 1.0]  # line 1 is `slow`: band 2.04-2.89


def test_an_out_of_band_line_goes_to_the_band_edge_not_the_target(setup: tuple[Path, Path]) -> None:
    work, library = setup
    assert go(work, library, Factory(wps=(3.6,)))[1] == 0  # over the band
    stretches = {line["i"]: line["stretch"] for line in read_version(work, 1, 1)["lines"]}
    assert stretches[0] == pytest.approx(3.4 / 3.6, abs=0.002) and stretches[1] == pytest.approx(2.89 / 3.6, abs=0.002)


def test_reused_takes_are_re_measured_under_the_current_pace_policy(setup: tuple[Path, Path]) -> None:
    work, library = setup
    assert go(work, library, Factory(wps=(3.0,)))[1] == 0
    for path in (work / "outputs/radio/casting/takes").glob("*/take.json"):
        record = json.loads(path.read_text())
        record["scores"]["stretch"] = 0.8  # what the exact-target policy would have written
        path.chmod(0o644)
        path.write_text(json.dumps(record))
    # Re-performing means setting the old render aside; the takes stay in the store.
    episode_dir(work, 1).rename(work / "ep01-old")
    factory = Factory(wps=(3.0,))
    body, code, _, _ = go(work, library, factory)
    assert code == 0, body
    assert factory.engine is None or not factory.engine.calls  # nothing re-rendered
    stretches = {line["i"]: line["stretch"] for line in read_version(work, 1, 1)["lines"]}
    assert stretches[0] == 1.0

def test_a_take_needing_a_stretch_outside_the_range_is_retaken(setup: tuple[Path, Path]) -> None:
    work, library = setup
    # Every first attempt is rushed (3.4 / 5.0 = 0.68 stretch), every second at a sane pace.
    factory = Factory(wps=(5.0, 3.0))
    body, code, _, _ = go(work, library, factory)
    assert code == 0, body
    manifest = read_version(work, 1, 1)
    assert [line["attempts"] for line in manifest["lines"]] == [2, 2, 2, 2]
    assert [line["attempt"] for line in manifest["lines"]] == [1, 1, 1, 1]
    for line in manifest["lines"]:
        assert PACE_RANGE[0] <= line["stretch"] <= PACE_RANGE[1]
        assert "stretch_needed" not in line
    seeds = [c["inputs"].seed for c in factory.engine.calls[:2]]  # type: ignore[union-attr]
    assert seeds[0] != seeds[1]
    statuses = sorted(json.loads((p / "take.json").read_text())["status"] for p in (work / "outputs/radio/casting/takes").iterdir())
    assert statuses == ["fail"] * 4 + ["pass"] * 4


def test_no_attempt_in_range_keeps_the_best_clamped_and_flags_the_line(setup: tuple[Path, Path]) -> None:
    work, library = setup
    factory = Factory(wps=(5.0,))
    body, code, _, _ = go(work, library, factory)
    assert code == 0, body
    assert body["bestOfFailed"] == 4 and len(factory.engine.calls) == 16  # type: ignore[union-attr]
    line = read_version(work, 1, 1)["lines"][0]
    assert line["status"] == "best_of_failed" and line["attempts"] == 4
    assert line["stretch"] == PACE_RANGE[0] and line["stretch_needed"] == round(3.4 / 5.0, 3)
    assert "pace" in line["failing"] and "needed stretch" in line["flag"]
    assert read_take(work, line["take"]).record["status"] == "best_of_failed"  # type: ignore[union-attr]
    flags = json.loads(flags_path(work).read_text())["flags"]
    assert [f["line"] for f in flags] == [0, 1, 2, 3] and {f["by"] for f in flags} == {"auto"}
    assert body["flags"] == [f["id"] for f in flags]


# AC4 -------------------------------------------------------------------------


def test_receipts_have_one_entry_per_engine_pass_and_the_manifest_has_rtf_total(setup: tuple[Path, Path]) -> None:
    work, library = setup
    factory = Factory(wps=(5.0, 3.0))
    body, code, _, _ = go(work, library, factory)
    assert code == 0
    takes = receipts(work, "take")
    assert len(takes) == len(factory.engine.calls) == 8  # type: ignore[union-attr]
    for row in takes:
        assert isinstance(row["rtf"], float) and row["peak_memory_gb"] == 1.5 and row["audio_seconds"] > 0
    assert len(receipts(work, "load")) == 1 and len(receipts(work, "perform")) == 1
    manifest = read_version(work, 1, 1)
    render = manifest["render"]
    assert manifest["rtf_total"] == render["rtf_total"] == body["rtfTotal"]
    assert render["rtf_total"] == pytest.approx((render["engine_wall"] + render["score_wall"]) / render["audio_seconds"], rel=0.05, abs=1e-3)
    assert render["takes_rendered"] == 8


# resume, refusals --------------------------------------------------------------


def test_a_stopped_run_resumes_without_rendering_finished_lines(setup: tuple[Path, Path]) -> None:
    work, library = setup
    body, code, _, _ = go(work, library, Factory(wps=(3.0,), fail_on_call=2))
    assert code == 1 and "resume" in body["message"]
    second = Factory(wps=(3.0,))
    body, code, _, _ = go(work, library, second)
    assert code == 0, body
    assert body["takesReused"] == 2 and body["takesRendered"] == 2
    assert [c["inputs"].lines[0].text for c in second.engine.calls] == ["(laughs) You always say that, Otto.", "And I am always right."]  # type: ignore[union-attr]


def test_unbound_role_is_a_refusal_and_nothing_renders(setup: tuple[Path, Path]) -> None:
    work, library = setup
    cast = json.loads(cast_path(work).read_text())
    del cast["roles"]["OTTO"]
    cast_path(work).write_text(json.dumps(cast))
    factory = Factory()
    body, code, _, _ = go(work, library, factory)
    assert code == 2 and body["unbound"] == ["OTTO"]
    assert factory.engine is None


def test_a_changed_card_is_a_refusal(setup: tuple[Path, Path]) -> None:
    work, library = setup
    card = library / "voices" / "otto" / "card.json"
    card.write_text(card.read_text().replace("test voice, otto", "test voice, recast"))
    body, code, _, _ = go(work, library, Factory())
    assert code == 2 and "changed" in body["message"]


def test_a_rendered_episode_is_refused_rather_than_rerendered(setup: tuple[Path, Path]) -> None:
    work, library = setup
    assert go(work, library, Factory(wps=(3.0,)))[1] == 0
    body, code, _, _ = go(work, library, Factory(wps=(3.0,)))
    assert code == 2 and "pablo fix" in body["message"]


def test_unknown_engine_is_a_refusal(setup: tuple[Path, Path]) -> None:
    work, library = setup
    body, code, _, _ = go(work, library, Factory(), engine="zonos2")
    assert code == 2 and "chatterbox-turbo" in body["message"]


def test_dia_groups_the_prototypes_passes_and_lines_share_a_take(setup: tuple[Path, Path]) -> None:
    work, library = setup
    factory = Factory(wps=(3.0,))
    body, code, _, _ = go(work, library, factory, engine=DIA.name)
    assert code == 0, body
    calls = factory.engine.calls  # type: ignore[union-attr]
    assert len(calls) == 2
    assert calls[0]["text"] == "[S1] Good evening from The Harbour Light, where the fog is in. [S2] Mind the step, the boards are wet tonight. [S1] Mm."
    lines = read_version(work, 1, 1)["lines"]
    assert lines[0]["take"] == lines[1]["take"] and lines[2]["take"] == lines[3]["take"] != lines[0]["take"]
    assert lines[1]["segment"] == {"index": 1, "of": 2}


def test_a_work_bound_before_outputs_radio_existed_keeps_its_cast(tmp_path: Path) -> None:
    work = tmp_path / "work"
    (work / "casting").mkdir(parents=True)
    (work / "casting" / "cast.json").write_text('{"version": 1, "roles": {}}')
    (work / "outputs" / "radio" / "casting" / "takes").mkdir(parents=True)
    assert casting_dir(work) == work / "casting"
