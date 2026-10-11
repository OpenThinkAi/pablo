"""Manifest versions and the "only flagged lines change" invariant (AGT-1681 AC2, AC3), and `takes gc`."""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path

import pytest

from pablo_casting.cli import run
from pablo_casting.fake_engine import FakeEngine
from pablo_casting.manifest import ManifestError, episode_dir, flags_path, read_version, versions, write_version
from pablo_casting.takes import Direction, EngineId, Line, TakeInputs, list_take_keys, record_take, takes_dir

ENGINE = EngineId(id="fake", weights_sha256="0" * 64, mlx_audio="none", mlx="none")
SCRIPT = [("ANNOUNCER", "Good evening."), ("CORA", "The harvest is in."), ("NED", "None of it legal."), ("CORA", "Hush.")]


@pytest.fixture
def work(tmp_path: Path) -> Path:
    path = tmp_path / "work"
    path.mkdir()
    return path


def take_for(work: Path, i: int, attempt: int = 0, emotion: str | None = None) -> str:
    speaker, text = SCRIPT[i]
    inputs = TakeInputs(
        engine=ENGINE,
        voice=f"card-{speaker.lower()}",
        lines=(Line(speaker=speaker, text=text),),
        seed=1000 + attempt,
        direction=Direction(emotion=emotion),
    )
    take, _ = record_take(work, FakeEngine(), inputs, attempt=attempt)
    return take.key


def proposal(work: Path, takes: dict[int, str] | None = None, target_wps: float | None = None) -> dict[str, object]:
    takes = takes or {}
    return {
        "script_sha256": "s" * 64,
        "cast_hash": "c" * 64,
        "engine": {"id": ENGINE.id, "weights_sha256": ENGINE.weights_sha256},
        "pace_policy": {"target_wps": target_wps, "min_stretch": 0.75},
        "lines": [
            {"i": i, "speaker": speaker, "text": text, "take": takes.get(i) or take_for(work, i), "stretch": 1.0}
            for i, (speaker, text) in enumerate(SCRIPT)
        ],
        "cues": [],
        "duration": 12.0,
    }


def audio_file(tmp: Path, name: str) -> Path:
    path = tmp / name
    path.write_bytes(name.encode())
    return path


def flag(work: Path, *flags: dict[str, object]) -> None:
    path = flags_path(work)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"flags": list(flags)}))


def tree(work: Path) -> dict[str, bytes]:
    root = work / "outputs" / "radio" / "casting"
    return {str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file() and not p.is_symlink()}


def test_version_one_has_no_parent_and_every_line_is_new(work: Path, tmp_path: Path) -> None:
    written = write_version(work, 1, proposal(work), audio=audio_file(tmp_path, "mix1.m4a"))
    manifest = written.manifest
    assert (manifest["version"], manifest["parent"], manifest["changed_lines"]) == (1, None, [0, 1, 2, 3])
    assert written.path == episode_dir(work, 1) / "v1.json"
    assert manifest["audio"] == "ep01.v1.m4a"
    assert os.readlink(episode_dir(work, 1) / "ep01.m4a") == "ep01.v1.m4a"


# AC2 ----------------------------------------------------------------------


def test_a_fix_may_change_only_flagged_lines(work: Path, tmp_path: Path) -> None:
    v1 = write_version(work, 1, proposal(work)).manifest
    flag(work, {"id": "f-1", "episode": 1, "line": 1, "reason": "clipped"})
    takes = {line["i"]: line["take"] for line in v1["lines"]}  # type: ignore[union-attr,index]
    retake = take_for(work, 1, attempt=1)
    written = write_version(work, 1, proposal(work, {**takes, 1: retake}), flags_applied=["f-1"], audio=audio_file(tmp_path, "mix2.m4a"))
    assert (written.manifest["version"], written.manifest["parent"]) == (2, 1)
    assert written.manifest["changed_lines"] == [1]
    assert written.manifest["flags_applied"] == ["f-1"]
    assert os.readlink(episode_dir(work, 1) / "ep01.m4a") == "ep01.v2.m4a"


def test_a_changed_take_outside_the_flagged_set_writes_nothing(work: Path, tmp_path: Path) -> None:
    v1 = write_version(work, 1, proposal(work), audio=audio_file(tmp_path, "mix1.m4a")).manifest
    flag(work, {"id": "f-1", "episode": 1, "line": 1})
    takes = {line["i"]: line["take"] for line in v1["lines"]}  # type: ignore[union-attr,index]
    changed = {**takes, 1: take_for(work, 1, attempt=1), 2: take_for(work, 2, attempt=1), 3: take_for(work, 3, emotion="tender")}
    before = tree(work)
    link_before = os.readlink(episode_dir(work, 1) / "ep01.m4a")

    with pytest.raises(ManifestError) as refused:
        write_version(work, 1, proposal(work, changed), flags_applied=["f-1"], audio=audio_file(tmp_path, "mix2.m4a"))
    assert refused.value.extra["offending"] == [2, 3]
    assert "2, 3" in str(refused.value)
    assert tree(work) == before
    assert versions(work, 1) == [1]
    assert os.readlink(episode_dir(work, 1) / "ep01.m4a") == link_before


def test_the_cli_exits_1_with_the_offending_line_ids_and_writes_nothing(work: Path, tmp_path: Path) -> None:
    v1 = write_version(work, 1, proposal(work)).manifest
    lines = copy.deepcopy(v1["lines"])
    lines[2]["take"] = take_for(work, 2, attempt=5)  # type: ignore[index]
    source = tmp_path / "proposal.json"
    source.write_text(json.dumps({**proposal(work), "lines": lines}))
    before = tree(work)
    (body, code), _ = run(["manifest", "write", "--work", str(work), "--episode", "1", "--from", str(source), "--json"])
    assert code == 1
    assert body["ok"] is False and body["offending"] == [2]
    assert tree(work) == before


def test_a_line_added_or_dropped_counts_as_changed(work: Path) -> None:
    v1 = write_version(work, 1, proposal(work)).manifest
    lines = list(v1["lines"])[:3]  # type: ignore[arg-type]
    with pytest.raises(ManifestError) as refused:
        write_version(work, 1, {**proposal(work), "lines": lines})
    assert refused.value.extra["offending"] == [3]


def test_unknown_or_other_episode_flags_and_missing_takes_are_errors(work: Path) -> None:
    write_version(work, 1, proposal(work))
    flag(work, {"id": "f-ep2", "episode": 2, "line": 1})
    with pytest.raises(ManifestError, match="f-ep2, f-nope"):
        write_version(work, 1, proposal(work), flags_applied=["f-ep2", "f-nope"])
    lines = proposal(work)["lines"]
    lines[0]["take"] = "f" * 64  # type: ignore[index]
    with pytest.raises(ManifestError, match="not in the store"):
        write_version(work, 1, {**proposal(work), "lines": lines})
    assert versions(work, 1) == [1]


# AC3 ----------------------------------------------------------------------


def test_a_pace_or_mix_only_change_is_a_new_version_with_no_changed_lines(work: Path, tmp_path: Path) -> None:
    v1 = write_version(work, 1, proposal(work), audio=audio_file(tmp_path, "mix1.m4a")).manifest
    takes_before = list_take_keys(work)

    paced = proposal(work, target_wps=2.6)
    for line in paced["lines"]:  # type: ignore[union-attr]
        line["stretch"] = 0.93  # type: ignore[index]
    v2 = write_version(work, 1, paced, audio=audio_file(tmp_path, "mix2.m4a")).manifest
    remixed = {**paced, "cues": [{"kind": "BED", "desc": "rain", "asset": "sfx/rain.wav", "start": 0.0}]}
    v3 = write_version(work, 1, remixed, audio=audio_file(tmp_path, "mix3.m4a")).manifest

    for later in (v2, v3):
        assert later["changed_lines"] == []
        assert [line["take"] for line in later["lines"]] == [line["take"] for line in v1["lines"]]  # type: ignore[union-attr,index]
    assert (v2["parent"], v3["parent"]) == (1, 2)
    assert v2["pace_policy"] == {"target_wps": 2.6, "min_stretch": 0.75}
    assert list_take_keys(work) == takes_before
    # Every version keeps its own audio; the link follows the newest.
    root = episode_dir(work, 1)
    assert sorted(p.name for p in root.iterdir() if not p.is_symlink()) == ["ep01.v1.m4a", "ep01.v2.m4a", "ep01.v3.m4a", "v1.json", "v2.json", "v3.json"]
    assert (root / "ep01.v1.m4a").read_bytes() == b"mix1.m4a"
    assert os.readlink(root / "ep01.m4a") == "ep01.v3.m4a"
    assert read_version(work, 1, 1) == v1


def test_the_writer_ignores_caller_supplied_bookkeeping(work: Path) -> None:
    write_version(work, 1, proposal(work))
    forged = {**proposal(work), "version": 9, "parent": 0, "changed_lines": [], "flags_applied": ["x"]}
    v2 = write_version(work, 1, forged).manifest
    assert (v2["version"], v2["parent"], v2["flags_applied"]) == (2, 1, [])


# takes gc -----------------------------------------------------------------


def test_gc_lists_unreferenced_takes_and_touches_nothing_without_yes(work: Path) -> None:
    write_version(work, 1, proposal(work))
    stray = take_for(work, 1, attempt=9)
    before = tree(work)
    (body, code), _ = run(["takes", "gc", "--work", str(work), "--json"])
    assert code == 0
    assert [entry["key"] for entry in body["unreferenced"]] == [stray]  # type: ignore[union-attr,index]
    assert body["archived"] == []
    assert tree(work) == before


def test_gc_with_yes_archives_only_the_listed_keys_and_never_deletes(work: Path) -> None:
    write_version(work, 1, proposal(work))
    stray = take_for(work, 1, attempt=9)
    other = take_for(work, 2, attempt=9)
    stray_bytes = (takes_dir(work) / stray / "take.wav").read_bytes()
    (body, code), _ = run(["takes", "gc", "--work", str(work), "--yes", "--key", stray, "--json"])
    assert code == 0
    assert [entry["key"] for entry in body["archived"]] == [stray]  # type: ignore[union-attr,index]
    assert not (takes_dir(work) / stray).exists()
    assert (takes_dir(work) / other).is_dir()
    archived = Path(body["archived"][0]["to"])  # type: ignore[index]
    assert archived.parent.parent.name == "takes" and archived.parent.parent.parent.name == "archive"
    assert (archived / "take.wav").read_bytes() == stray_bytes
    # A referenced key named by --key is skipped, not moved.
    referenced = read_version(work, 1, 1)["lines"][0]["take"]  # type: ignore[index]
    (body, code), _ = run(["takes", "gc", "--work", str(work), "--yes", "--key", referenced, "--json"])
    assert code == 0 and body["archived"] == [] and body["skipped"] == [referenced]
    assert (takes_dir(work) / referenced).is_dir()


def test_gc_refuses_to_collect_when_a_manifest_is_unreadable(work: Path) -> None:
    write_version(work, 1, proposal(work))
    take_for(work, 1, attempt=9)
    (episode_dir(work, 2)).mkdir(parents=True)
    (episode_dir(work, 2) / "v1.json").write_text("{not json")
    before = tree(work)
    (body, code), _ = run(["takes", "gc", "--work", str(work), "--yes", "--json"])
    assert code == 1
    assert tree(work) == before


def test_takes_and_manifest_need_a_work_and_a_known_subcommand(work: Path) -> None:
    assert run(["takes", "gc", "--json"])[0][1] == 1
    assert run(["takes", "burn", "--work", str(work), "--json"])[0][1] == 1
    assert run(["manifest", "write", "--work", str(work), "--json"])[0][1] == 1
    assert run(["version", "extra", "--json"])[0][1] == 1
