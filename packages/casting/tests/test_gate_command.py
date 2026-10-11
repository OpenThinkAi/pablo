"""`gate`, `gate calibrate` and the doctor's scorer listing, through `run`, with fake scorers (AGT-1682)."""

from __future__ import annotations

import json
import struct
import wave
from collections.abc import Mapping
from dataclasses import replace
from pathlib import Path

import pytest

from pablo_casting.cli import run
from pablo_casting.scorers import (
    ALIGNER,
    AUDIOBOX,
    DNSMOS,
    ECAPA,
    EMOTION,
    SCORERS,
    UTMOS,
    WHISPER,
    ScorerInfo,
    ScorerUnavailable,
    Take,
)

LINE = "Not just for the breweries, but for the home winemakers too."  # 11 words


@pytest.fixture
def env(tmp_path: Path) -> dict[str, str]:
    library = tmp_path / "library"
    library.mkdir()
    config = tmp_path / "config" / "pablo" / "casting.json"
    config.parent.mkdir(parents=True)
    config.write_text(json.dumps({"library": str(library)}), encoding="utf-8")
    return {"HOME": str(tmp_path / "home"), "XDG_CONFIG_HOME": str(tmp_path / "config"), "HF_HUB_CACHE": str(tmp_path / "hf")}


def library(env: Mapping[str, str]) -> Path:
    return Path(json.loads((Path(env["XDG_CONFIG_HOME"]) / "pablo" / "casting.json").read_text())["library"])


def make_card(env: Mapping[str, str], slug: str = "cora", gates: dict[str, object] | None = None, pace: dict[str, object] | None = None) -> Path:
    card_dir = library(env) / slug
    card_dir.mkdir()
    (card_dir / "embedding.ecapa.npy").write_bytes(b"fake")
    card = {
        "slug": slug,
        "description": "an invented test voice",
        "embedding": {"model": "speechbrain/spkrec-ecapa-voxceleb", "file": "embedding.ecapa.npy"},
        "pace": pace or {"wps": 2.9, "band": [2.4, 3.4]},
        "gates": gates if gates is not None else {"sim_min": 0.62},
        "notes": "kept as is by calibrate",
    }
    (card_dir / "card.json").write_text(json.dumps(card, indent=2) + "\n", encoding="utf-8")
    return card_dir


def make_wav(path: Path, seconds: float = 4.5, rate: int = 16000) -> Path:
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(struct.pack("<h", 0) * int(seconds * rate))
    return path


class Fake:
    def __init__(self, info: ScorerInfo, answer: Mapping[str, object] | None = None, missing: bool = False) -> None:
        self.info = info
        self.answer = dict(answer or {})
        self.missing = missing
        self.takes: list[Take] = []

    def score(self, take: Take) -> Mapping[str, object]:
        self.takes.append(take)
        if self.missing:
            raise ScorerUnavailable(self.info, ImportError(f"No module named {self.info.module!r}"))
        return self.answer


def good_stack(**over: Mapping[str, object]) -> list[Fake]:
    # 11 words spoken from 0.3 s to 4.1 s = 2.89 w/s against a 2.9 target.
    answers: dict[str, Mapping[str, object]] = {
        "whisper": {"wer": 0.0, "inserted_span": 0, "tail_ok": True, "cut": 4.28, "heard": "not just for"},
        "aligner": {"timings": [{"word": "Not", "start": 0.3, "end": 0.5}, {"word": "too", "start": 3.8, "end": 4.1}]},
        "ecapa": {"sim_card": 0.74, "sim_role_centroid": None},
        "utmos": {"utmos": 4.05},
        "audiobox": {"pq": 7.1},
        "dnsmos": {"bak": 4.15, "ovrl": 3.62},
        "emotion": {"emotion_top2": ["neutral", "sad"]},
    }
    answers.update(over)
    return [Fake(info, answers[info.name]) for info in SCORERS]


def gate(env: dict[str, str], argv: list[str], stack: list[Fake]) -> tuple[dict[str, object], int]:
    (body, code), _ = run(["gate", *argv, "--json"], env, scorers=lambda: stack)
    return body, code


# --- gate ------------------------------------------------------------------------


def test_gate_returns_every_score_in_the_gate_table_plus_pass_and_failing(env: dict[str, str], tmp_path: Path) -> None:
    make_card(env)
    take = make_wav(tmp_path / "take.wav")
    body, code = gate(env, [str(take), "--line", LINE, "--card", "cora", "--emotion", "sad"], good_stack())
    assert code == 0, body
    assert body["ok"] is True
    assert body["pass"] is True
    assert body["failing"] == []
    scores = body["scores"]
    assert isinstance(scores, dict)
    for key in ("wer", "inserted_span", "tail_ok", "sim_card", "sim_role_centroid", "utmos", "pq", "bak", "ovrl", "wps", "stretch", "emotion_top2", "duration_ratio", "seconds"):
        assert key in scores, key
    assert scores["seconds"] == pytest.approx(4.5)
    assert scores["wps"] == pytest.approx(11 / 3.8, abs=1e-3)
    assert set(body["gates"]) == {"words", "tail", "identity", "consistency", "naturalness", "artefacts", "pace", "emotion", "duration"}  # type: ignore[arg-type]
    assert body["thresholds"]["sim_min"] == 0.62  # type: ignore[index]  # the card's own
    assert body["thresholds"]["utmos_min"] == 3.8  # type: ignore[index]  # the package default
    assert [s["name"] for s in body["scorers"]] == [info.name for info in SCORERS]  # type: ignore[union-attr]
    assert body["timings"][0]["word"] == "Not"  # type: ignore[index]


def test_every_scorer_sees_the_take_the_line_and_the_card(env: dict[str, str], tmp_path: Path) -> None:
    card_dir = make_card(env)
    take = make_wav(tmp_path / "take.wav")
    stack = good_stack()
    gate(env, [str(take), "--line", LINE, "--card", "cora"], stack)
    for fake in stack:
        (seen,) = fake.takes
        assert seen.audio == take
        assert seen.line == LINE
        assert seen.card_embedding == card_dir / "embedding.ecapa.npy"


def test_a_failing_take_is_an_answer_naming_the_failing_gates(env: dict[str, str], tmp_path: Path) -> None:
    make_card(env)
    take = make_wav(tmp_path / "take.wav")
    stack = good_stack(ecapa={"sim_card": 0.58, "sim_role_centroid": None}, utmos={"utmos": 3.1})
    body, code = gate(env, [str(take), "--line", LINE, "--card", "cora"], stack)
    assert code == 0
    assert body["pass"] is False
    assert body["failing"] == ["identity", "naturalness"]


def test_the_card_overrides_the_defaults_and_its_pace_band_applies(env: dict[str, str], tmp_path: Path) -> None:
    make_card(env, gates={"sim_min": 0.80}, pace={"wps": 2.5, "band": [2.0, 2.6]})
    take = make_wav(tmp_path / "take.wav")
    body, _ = gate(env, [str(take), "--line", LINE, "--card", "cora"], good_stack())
    assert body["failing"] == ["identity", "pace"]
    assert body["thresholds"]["wps_band"] == [2.0, 2.6]  # type: ignore[index]


def test_a_role_centroid_counts_once_it_has_ten_takes(env: dict[str, str], tmp_path: Path) -> None:
    make_card(env)
    take = make_wav(tmp_path / "take.wav")
    centroid = tmp_path / "centroid.json"
    centroid.write_text(json.dumps({"embedding": [0.1, 0.2, 0.3], "takes": 12}), encoding="utf-8")
    stack = good_stack(ecapa={"sim_card": 0.74, "sim_role_centroid": 0.50})
    body, _ = gate(env, [str(take), "--line", LINE, "--card", "cora", "--centroid", str(centroid)], stack)
    assert stack[2].takes[0].centroid == [0.1, 0.2, 0.3]
    assert body["failing"] == ["consistency"]


def test_a_missing_hard_scorer_is_a_refusal_naming_the_extra(env: dict[str, str], tmp_path: Path) -> None:
    make_card(env)
    take = make_wav(tmp_path / "take.wav")
    stack = good_stack()
    stack[2] = Fake(ECAPA, missing=True)
    body, code = gate(env, [str(take), "--line", LINE, "--card", "cora"], stack)
    assert code == 2
    assert "`scorers` extra" in str(body["message"])
    assert body["missing"] == ["speechbrain"]


def test_a_missing_emotion_scorer_only_skips_the_soft_gate(env: dict[str, str], tmp_path: Path) -> None:
    make_card(env)
    take = make_wav(tmp_path / "take.wav")
    stack = good_stack()
    stack[-1] = Fake(EMOTION, missing=True)
    body, code = gate(env, [str(take), "--line", LINE, "--card", "cora", "--emotion", "sad"], stack)
    assert code == 0
    assert body["pass"] is True
    assert body["gates"]["emotion"]["skipped"] == "emotion was not scored"  # type: ignore[index]
    assert body["scorers"][-1] == {"name": "emotion", "skipped": "the `emotion` extra is not installed"}  # type: ignore[index]


def test_a_crashing_scorer_is_an_error(env: dict[str, str], tmp_path: Path) -> None:
    make_card(env)
    take = make_wav(tmp_path / "take.wav")

    class Boom(Fake):
        def score(self, take: Take) -> Mapping[str, object]:
            raise RuntimeError("model exploded")

    stack = good_stack()
    stack[3] = Boom(UTMOS)
    body, code = gate(env, [str(take), "--line", LINE, "--card", "cora"], stack)
    assert code == 1
    assert "model exploded" in str(body["message"])


@pytest.mark.parametrize(
    ("argv", "code"),
    [
        (["{take}", "--line", LINE], 2),  # no card
        (["{take}", "--line", LINE, "--card", "nobody"], 2),
        (["{take}", "--line", LINE, "--card", "../escape"], 2),
        (["{dir}/missing.wav", "--line", LINE, "--card", "cora"], 2),
        (["{take}", "--card", "cora"], 1),  # no line
        ([], 1),
        (["{take}", "{take}", "--line", LINE, "--card", "cora"], 1),
    ],
)
def test_gate_refuses_or_errors_with_pablos_codes(env: dict[str, str], tmp_path: Path, argv: list[str], code: int) -> None:
    make_card(env)
    take = make_wav(tmp_path / "take.wav")
    filled = [a.replace("{take}", str(take)).replace("{dir}", str(tmp_path)) for a in argv]
    body, got = gate(env, filled, good_stack())
    assert got == code, body
    assert body["ok"] is False


def test_a_card_can_be_named_by_its_directory(env: dict[str, str], tmp_path: Path) -> None:
    card_dir = make_card(env)
    take = make_wav(tmp_path / "take.wav")
    body, code = gate(env, [str(take), "--line", LINE, "--card", str(card_dir)], good_stack())
    assert code == 0
    assert body["card"] == "cora"


def test_gate_with_a_work_leaves_a_receipt(env: dict[str, str], tmp_path: Path) -> None:
    make_card(env)
    take = make_wav(tmp_path / "take.wav")
    work = tmp_path / "work"
    work.mkdir()
    (body, code), _ = run(["gate", str(take), "--line", LINE, "--card", "cora", "--work", str(work), "--json"], env, scorers=good_stack)
    assert code == 0
    (receipt,) = [json.loads(line) for line in (work / ".pablo" / "casting" / "receipts.jsonl").read_text().splitlines()]
    assert receipt["intent"] == "gate"
    assert receipt["card"] == "cora"
    assert receipt["pass"] is True
    assert len(receipt["take_sha256"]) == 64


def test_scores_rejudges_a_stored_body_without_any_scorer(env: dict[str, str], tmp_path: Path) -> None:
    make_card(env)
    take = make_wav(tmp_path / "take.wav")
    stored, _ = gate(env, [str(take), "--line", LINE, "--card", "cora"], good_stack())
    record = tmp_path / "take-gate.json"
    record.write_text(json.dumps(stored), encoding="utf-8")
    # Calibration tightened the card: the same scores now fail identity.
    (Path(library(env)) / "cora" / "card.json").write_text(json.dumps({"slug": "cora", "gates": {"sim_min": 0.80}}), encoding="utf-8")

    def no_scorers() -> list[Fake]:
        raise AssertionError("--scores must not load a scorer")

    (body, code), _ = run(["gate", "--scores", str(record), "--card", "cora", "--json"], env, scorers=no_scorers)
    assert code == 0
    assert body["take"] is None
    assert body["failing"] == ["identity"]


# --- gate calibrate --------------------------------------------------------------


def write_records(directory: Path, records: list[dict[str, object]], as_csv: bool = False) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    if as_csv:
        keys = sorted({k for r in records for k in r})
        rows = [",".join(keys)] + [",".join(str(r.get(k, "")) for k in keys) for r in records]
        (directory / "results.csv").write_text("\n".join(rows) + "\n", encoding="utf-8")
    else:
        for i, record in enumerate(records):
            (directory / f"take-{i:03}.json").write_text(json.dumps({"ok": True, "scores": record}), encoding="utf-8")
    return directory


def approved_and_others(tmp_path: Path) -> tuple[Path, Path]:
    approved = [{"sim_card": 0.66 + i * 0.004, "utmos": 3.9 + i * 0.01, "wer": 0.0, "bak": 4.1} for i in range(30)]
    others = [{"sim_card": 0.30 + i * 0.004, "utmos": 3.5 + i * 0.01, "wer": 0.1, "bak": 4.0} for i in range(30)]
    return write_records(tmp_path / "approved", approved), write_records(tmp_path / "others", others, as_csv=True)


def snapshot(directory: Path) -> dict[str, bytes]:
    return {str(p): p.read_bytes() for p in sorted(directory.rglob("*")) if p.is_file()}


def test_calibrate_prints_a_proposed_gates_block_and_writes_nothing(env: dict[str, str], tmp_path: Path) -> None:
    make_card(env)
    approved, others = approved_and_others(tmp_path)
    before = snapshot(tmp_path)
    (body, code), _ = run(["gate", "calibrate", "--approved", str(approved), "--others", str(others), "--card", "cora", "--json"], env)
    assert code == 0, body
    assert snapshot(tmp_path) == before
    assert body["applied"] is False
    assert body["approved"] == 30 and body["others"] == 30
    proposed = body["proposed"]["gates"]  # type: ignore[index]
    assert set(proposed) == {"sim_min", "utmos_min", "wer_max", "bak_min"}
    assert proposed["sim_min"] == pytest.approx(0.66 + 0.004 * 29 * 0.05, abs=1e-3)  # p5 wins: the others are far below
    assert body["current"] == {"sim_min": 0.62}
    assert body["fits"]["sim_min"]["chose"] == "p5"  # type: ignore[index]


def test_calibrate_apply_merges_the_block_into_the_card(env: dict[str, str], tmp_path: Path) -> None:
    card_dir = make_card(env, gates={"sim_min": 0.62, "centroid_min_takes": 12})
    approved, others = approved_and_others(tmp_path)
    (body, code), _ = run(
        ["gate", "calibrate", "--approved", str(approved), "--others", str(others), "--card", "cora", "--apply", "--json"], env
    )
    assert code == 0, body
    assert body["applied"] is True
    assert body["wrote"] == [str(card_dir / "card.json")]
    card = json.loads((card_dir / "card.json").read_text())
    assert card["gates"] == {"centroid_min_takes": 12, **body["proposed"]["gates"]}  # type: ignore[index]
    assert card["gates"]["sim_min"] != 0.62
    assert card["notes"] == "kept as is by calibrate"
    assert sorted(p.name for p in card_dir.iterdir()) == ["card.json", "embedding.ecapa.npy"]


@pytest.mark.parametrize(
    ("argv", "code"),
    [
        (["--approved", "{approved}", "--apply"], 2),  # apply needs a card
        (["--approved", "{empty}"], 2),
        (["--approved", "{tmp}/nowhere"], 2),
        ([], 1),
        (["extra", "--approved", "{approved}"], 1),
    ],
)
def test_calibrate_refuses_or_errors(env: dict[str, str], tmp_path: Path, argv: list[str], code: int) -> None:
    approved, _ = approved_and_others(tmp_path)
    (tmp_path / "empty").mkdir()
    filled = [a.replace("{approved}", str(approved)).replace("{empty}", str(tmp_path / "empty")).replace("{tmp}", str(tmp_path)) for a in argv]
    (body, got), _ = run(["gate", "calibrate", *filled, "--json"], env)
    assert got == code, body
    assert body["ok"] is False


# --- doctor ----------------------------------------------------------------------


def test_doctor_lists_every_scorer_with_weights_license_and_version(env: dict[str, str]) -> None:
    snapshot_dir = Path(env["HF_HUB_CACHE"]) / "models--speechbrain--spkrec-ecapa-voxceleb" / "snapshots" / "abc"
    snapshot_dir.mkdir(parents=True)
    (body, code), _ = run(["doctor", "--json"], env)
    assert code == 0
    scorers = body["scorers"]
    assert isinstance(scorers, list)
    assert [s["name"] for s in scorers] == ["whisper", "aligner", "ecapa", "utmos", "audiobox", "dnsmos", "emotion"]
    for scorer in scorers:
        assert scorer["weights"]
        assert scorer["license"]["code"] and scorer["license"]["weights"]
        assert "version" in scorer and "installed" in scorer
    by_name = {s["name"]: s for s in scorers}
    assert by_name["ecapa"]["cached"] is True
    assert by_name["whisper"]["cached"] is False
    assert by_name["utmos"]["cached"] is None
    assert by_name["utmos"]["revision"] == "v1.2.0"
    assert by_name["aligner"]["runs"] == "MLX"
    assert by_name["ecapa"]["runs"].startswith("CPU")


def test_the_stack_order_is_the_design_order() -> None:
    assert SCORERS == (WHISPER, ALIGNER, ECAPA, UTMOS, AUDIOBOX, DNSMOS, EMOTION)
    assert [info.name for info in SCORERS if info.soft] == ["emotion"]
    assert replace(EMOTION, soft=False).soft is False
