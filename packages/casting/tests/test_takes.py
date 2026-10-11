"""The take store (AGT-1681 AC1, AC4): content-addressed, immutable, model-free."""

from __future__ import annotations

import ast
import dataclasses
import json
import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

from pablo_casting.cli import run
from pablo_casting.fake_engine import FakeEngine
from pablo_casting.takes import (
    Direction,
    EngineId,
    Line,
    TakeInputError,
    TakeInputs,
    derive_seed,
    read_take,
    record_take,
    take_key,
    takes_dir,
)
from pablo_casting.wav import read_wav

SRC = Path(__file__).resolve().parents[1] / "src" / "pablo_casting"


def inputs(**changes: object) -> TakeInputs:
    base = TakeInputs(
        engine=EngineId(id="fake", weights_sha256="0" * 64, mlx_audio="none", mlx="none"),
        voice="card-" + "a" * 60,
        lines=(Line(speaker="CORA", text="The harvest is in, and none of it is legal."),),
        seed=7,
        direction=Direction(emotion="dry", intensity=1, pace=None),
        params={"cfg": 0.5},
    )
    return dataclasses.replace(base, **changes)  # type: ignore[arg-type]


@pytest.fixture
def work(tmp_path: Path) -> Path:
    path = tmp_path / "work"
    path.mkdir()
    return path


def snapshot(root: Path) -> dict[str, tuple[bytes, int]]:
    return {str(p.relative_to(root)): (p.read_bytes(), p.stat().st_mtime_ns) for p in sorted(root.rglob("*")) if p.is_file()}


# AC1 ----------------------------------------------------------------------


def test_writing_the_same_take_twice_is_a_no_op_and_never_reaches_the_engine(work: Path) -> None:
    engine = FakeEngine()
    first, created = record_take(work, engine, inputs())
    assert created is True
    before = snapshot(takes_dir(work))
    receipts = (work / ".pablo" / "casting" / "receipts.jsonl").read_text()

    again, created_again = record_take(work, engine, inputs(), scores={"wer": 0.5}, status="best_of_failed", attempt=3)
    assert created_again is False
    assert again.key == first.key
    assert again.record == first.record
    assert snapshot(takes_dir(work)) == before
    assert len(engine.calls) == 1
    assert (work / ".pablo" / "casting" / "receipts.jsonl").read_text() == receipts


@pytest.mark.parametrize(
    "change",
    [
        {"take_version": 2},
        {"engine": EngineId(id="other", weights_sha256="0" * 64, mlx_audio="none", mlx="none")},
        {"engine": EngineId(id="fake", weights_sha256="1" * 64, mlx_audio="none", mlx="none")},
        {"engine": EngineId(id="fake", weights_sha256="0" * 64, mlx_audio="0.5.8", mlx="none")},
        {"engine": EngineId(id="fake", weights_sha256="0" * 64, mlx_audio="none", mlx="0.32.3")},
        {"voice": "card-" + "b" * 60},
        {"lines": (Line(speaker="NED", text="The harvest is in, and none of it is legal."),)},
        {"lines": (Line(speaker="CORA", text="The harvest is in, and all of it is legal."),)},
        {"lines": (Line(speaker="CORA", text="The harvest is in, and none of it is legal."), Line(speaker="NED", text="Hush."))},
        {"direction": Direction(emotion="warm", intensity=1, pace=None)},
        {"direction": Direction(emotion="dry", intensity=3, pace=None)},
        {"direction": Direction(emotion="dry", intensity=1, pace="slow")},
        {"params": {"cfg": 0.3}},
        {"params": {"cfg": 0.5, "temperature": 0.7}},
        {"seed": 8},
    ],
)
def test_changing_any_key_field_yields_a_new_key(change: dict[str, object]) -> None:
    assert take_key(inputs(**change)) != take_key(inputs())


def test_the_key_is_canonical_json_so_param_order_does_not_matter() -> None:
    a = inputs(params={"cfg": 0.5, "temperature": 0.7})
    b = inputs(params={"temperature": 0.7, "cfg": 0.5})
    assert take_key(a) == take_key(b)
    assert len(take_key(a)) == 64


def test_a_take_round_trips_through_from_body() -> None:
    original = inputs()
    assert TakeInputs.from_body(original.key_body()) == original
    with pytest.raises(TakeInputError):
        TakeInputs.from_body({**original.key_body(), "mood": "x"})


def test_derived_seeds_differ_per_attempt_and_ignore_the_current_seed() -> None:
    assert derive_seed(inputs(), 0) != derive_seed(inputs(), 1)
    assert derive_seed(inputs(seed=1), 2) == derive_seed(inputs(seed=99), 2)


def test_take_files_are_read_only_and_the_fake_engine_gives_silence_of_the_right_shape(work: Path) -> None:
    take, _ = record_take(work, FakeEngine(), inputs())
    for name in ("take.wav", "take.json"):
        mode = (take.path / name).stat().st_mode
        assert not mode & (stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH)
    audio = read_wav((take.path / "take.wav").read_bytes())
    assert (audio.sample_rate, audio.channels, audio.sample_width) == (24_000, 1, 2)
    assert set(audio.frames) == {0}
    words = 10
    assert audio.duration == pytest.approx(words / 2.8 + 0.18, abs=1e-3)
    record = take.record
    assert record["audio"]["frames"] == audio.frame_count  # type: ignore[index]
    assert len(record["timings"]["words"]) == words  # type: ignore[index]
    assert record["inputs"] == inputs().key_body()
    assert record["seed"] == 7
    assert str(record["receipt"]).startswith("r-")


def test_a_take_already_in_place_wins_a_race_and_the_loser_leaves_nothing(work: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import pablo_casting.takes as takes

    first, _ = record_take(work, FakeEngine(), inputs())
    real = takes.read_take
    calls = {"n": 0}

    def blind_once(w: Path, key: str):  # the existence check misses once, as in a race
        calls["n"] += 1
        return None if calls["n"] <= 2 else real(w, key)

    monkeypatch.setattr(takes, "read_take", blind_once)
    before = snapshot(takes_dir(work))
    again, created = takes.record_take(work, FakeEngine(), inputs())
    assert created is False
    assert again.record == first.record
    assert snapshot(takes_dir(work)) == before
    assert [p.name for p in takes_dir(work).iterdir() if p.name.startswith(".")] == []


def test_no_code_path_deletes_or_rewrites_a_take() -> None:
    """Static guard: the only deleting/replacing calls in the package are the staging discard and the link swap."""
    deleting = {"unlink", "rmtree", "remove", "rmdir", "removedirs", "truncate"}
    allowed = {
        ("takes.py", "_discard_staging", "rmtree"),
        ("manifest.py", "write_version", "replace"),
        # `gate calibrate --apply` (AGT-1682) swaps a card.json atomically and removes only its own temp file; never a take.
        ("gate_command.py", "_write_json_atomically", "replace"),
        ("gate_command.py", "_write_json_atomically", "unlink"),
        # AGT-1679: a cast card's staging discard and its file moves (into place, or the old card into recast/).
        ("cards.py", "_discard_staging", "rmtree"),
        ("cards.py", "_move", "replace"),
        # AGT-1683: perform's auto flags swap flags.json atomically; never a take.
        ("perform.py", "_write_auto_flags", "replace"),
        # AGT-1684: the link swap moved out of write_version; a mix completes an unmixed manifest by an atomic
        # swap of that one file; the cue library drops only its own staging name after linking the asset. Never a take.
        ("manifest.py", "move_link", "replace"),
        ("manifest.py", "attach_mix", "replace"),
        ("cues.py", "ensure", "unlink"),
        # AGT-1685: fix moves applied flags between flags.json and flags-done.json by atomic swaps; never a take.
        ("fix.py", "_write_atomic", "replace"),
        # AGT-1697: the stream swaps its own index and moves a staged segment into place, under .pablo/out/stream/;
        # never a take.
        ("stream.py", "_write_atomic", "replace"),
        ("stream.py", "_write_segment", "replace"),
    }
    found: set[tuple[str, str, str]] = set()
    for path in SRC.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for function in ast.walk(tree):
            if not isinstance(function, ast.FunctionDef):
                continue
            for node in ast.walk(function):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                    name = node.func.attr
                    if name in deleting or (name == "replace" and isinstance(node.func.value, ast.Name) and node.func.value.id == "os"):
                        found.add((path.name, function.name, name))
    assert found <= allowed, found - allowed


# AC4 ----------------------------------------------------------------------


def test_takes_show_prints_inputs_scores_timings_and_the_receipt(work: Path) -> None:
    take, _ = record_take(work, FakeEngine(), inputs(), scores={"wer": 0.0, "sim_card": 0.71})
    (body, code), _ = run(["takes", "show", take.key[:10], "--work", str(work), "--json"])
    assert code == 0
    assert body["key"] == take.key
    assert body["inputs"] == inputs().key_body()
    assert body["scores"] == {"wer": 0.0, "sim_card": 0.71}
    assert len(body["timings"]["words"]) == 10  # type: ignore[index]
    assert body["receipt"] == take.record["receipt"]
    receipts = [json.loads(line) for line in (work / ".pablo" / "casting" / "receipts.jsonl").read_text().splitlines()]
    assert [r["id"] for r in receipts if r["intent"] == "take"] == [body["receipt"]]


def test_takes_show_refuses_a_missing_or_ambiguous_key_and_errors_on_a_bad_one(work: Path) -> None:
    (body, code), _ = run(["takes", "show", "abcd1234", "--work", str(work), "--json"])
    assert code == 2 and body["missing"] == ["abcd1234"]
    (body, code), _ = run(["takes", "show", "../../etc", "--work", str(work), "--json"])
    assert code == 1
    (body, code), _ = run(["takes", "show", "--work", str(work), "--json"])
    assert code == 1


def test_takes_and_audio_are_untracked_and_manifests_are_not(work: Path) -> None:
    from pablo_casting.manifest import write_version

    if shutil.which("git") is None:
        pytest.skip("git is not installed")
    subprocess.run(["git", "init", "-q", str(work)], check=True)
    (work / ".gitignore").write_text(".pablo/\n")  # a work's own rule (receipts); not under test
    take, _ = record_take(work, FakeEngine(), inputs())
    audio = work.parent / "mix.m4a"
    audio.write_bytes(b"not really aac")
    written = write_version(work, 1, {"lines": [{"i": 0, "speaker": "CORA", "text": "…", "take": take.key}]}, audio=audio)
    archived = work / "outputs" / "radio" / "casting" / "archive" / "takes" / "x" / "y.wav"
    archived.parent.mkdir(parents=True)
    archived.write_bytes(b"")
    status = subprocess.run(
        ["git", "-C", str(work), "status", "--porcelain", "--untracked-files=all"], check=True, capture_output=True, text=True
    ).stdout
    listed = sorted(line[3:] for line in status.splitlines())
    assert listed == [".gitignore", "outputs/radio/casting/.gitignore", "outputs/radio/casting/renders/ep01/v1.json"]
    assert written.link is not None and os.readlink(written.link) == "ep01.v1.m4a"
