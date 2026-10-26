"""The mixer's host side (AGT-1766): load, peaks cached by content key, paced clip audio, saving versions. Model-free.

Takes, cues and the pacer are test_mix's invented stand-ins (sine tones, a resample pacer); nothing is a real work.
"""

from __future__ import annotations

import base64
import copy
import io
import json
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from test_mix import cue, cues_dir, fake_pacer, mixed, performed, proposal, seams, take_for, work  # noqa: F401 (fixtures)

from pablo_casting.cli import run
from pablo_casting.cues import cue_key
from pablo_casting.loudness import DEFAULT_TARGETS, integrated_lufs
from pablo_casting.manifest import audio_versions, flags_path, read_version, write_version
from pablo_casting.mix import SR, Seams
from pablo_casting.mixdoc import mix_path, mix_versions, read_mix
from pablo_casting.mixer import PEAKS_PER_SECOND, compute_peaks, peaks_path


class CountingPacer:
    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, audio: np.ndarray, rate: int, stretch: float) -> np.ndarray:
        self.calls += 1
        return fake_pacer(audio, rate, stretch)


def ask(work: Path, cues_dir: Path, s: Seams, *argv: str) -> tuple[dict[str, object], int]:
    (body, code), _ = run(["mixer", *argv, "--work", str(work), "--cues", str(cues_dir), "--json"], mixer=s)
    return body, code


@pytest.fixture
def episode(work: Path, cues_dir: Path) -> dict[str, object]:
    performed(work, cues=[cue("SFX", "A door creaks", 0), cue("BED", "Rain on a tin roof", 1)])
    mixed(work, cues_dir)
    return read_version(work, 1, 1)


def first_dialogue_clip(doc: dict[str, object]) -> dict[str, object]:
    lanes = doc["tracks"]["dialogue"]["lanes"]  # type: ignore[index]
    return next(iter(lanes.values()))["clips"][0]  # type: ignore[no-any-return]


def save(work: Path, cues_dir: Path, s: Seams, tmp_path: Path, doc: dict[str, object], base: int) -> tuple[dict[str, object], int]:
    path = tmp_path / "proposal.json"
    path.write_text(json.dumps(doc))
    return ask(work, cues_dir, s, "save", "--episode", "1", "--base", str(base), "--from", str(path))


# --- load -----------------------------------------------------------------------------------------------------


def test_load_returns_the_document_the_manifest_and_the_layout(work: Path, cues_dir: Path, episode: dict[str, object]) -> None:
    s, _ = seams()
    body, code = ask(work, cues_dir, s, "load", "--episode", "1")
    assert code == 0 and body["ok"] and (body["version"], body["newest"]) == (1, 1)
    assert body["document"] == read_mix(work, 1, 1)
    assert [v["by"] for v in body["versions"]] == ["auto"]  # type: ignore[union-attr]
    manifest = body["manifest"]
    assert [l["i"] for l in manifest["lines"]] == [0, 1, 2, 3] and manifest["lines"][0]["speaker"] == "ANNOUNCER"  # type: ignore[index]
    assert manifest["lines"][0]["take"] == episode["lines"][0]["take"]  # type: ignore[index]
    assert [(c["kind"], c["key"]) for c in manifest["cues"]] == [("SFX", cue_key("SFX", "A door creaks")), ("BED", cue_key("BED", "Rain on a tin roof"))]  # type: ignore[index]
    layout = {t["track"]: t for t in body["layout"]}  # type: ignore[union-attr]
    assert list(layout) == ["dialogue", "sfx", "beds", "music"]
    assert sorted(lane["name"] for lane in layout["dialogue"]["lanes"]) == ["ANNOUNCER", "MAVIS", "OTTO"]


def test_load_refuses_an_unmixed_episode_and_an_unknown_version(work: Path, cues_dir: Path, episode: dict[str, object]) -> None:
    s, _ = seams()
    body, code = ask(work, cues_dir, s, "load", "--episode", "2")
    assert code == 2 and "no mix document" in str(body["message"])
    body, code = ask(work, cues_dir, s, "load", "--episode", "1", "--version", "5")
    assert code == 2 and "v5" in str(body["message"])


# --- AC1: peaks are computed once and reused ------------------------------------------------------------------


def test_peaks_are_cached_by_content_key_and_reused(work: Path, cues_dir: Path, episode: dict[str, object]) -> None:
    pacer = CountingPacer()
    s = Seams(generators=lambda kind: None, pacer=pacer)  # type: ignore[arg-type,return-value]
    key = episode["lines"][1]["take"]  # type: ignore[index]
    body, code = ask(work, cues_dir, s, "peaks", "--source", f"take:{key}", "--stretch", "0.8")
    assert code == 0 and body["cached"] is False and pacer.calls == 1
    assert body["per_second"] == PEAKS_PER_SECOND and len(body["peaks"]) == pytest.approx(body["seconds"] * PEAKS_PER_SECOND, abs=1)  # type: ignore[arg-type,operator]
    assert max(body["peaks"]) > 0.3  # type: ignore[type-var]
    assert peaks_path(work, "take", key, 0.8).is_file()

    again, code = ask(work, cues_dir, s, "peaks", "--source", f"take:{key}", "--stretch", "0.8")
    assert code == 0 and again["cached"] is True and pacer.calls == 1  # nothing decoded or paced
    assert again["peaks"] == body["peaks"]

    other, _ = ask(work, cues_dir, s, "peaks", "--source", f"take:{key}", "--stretch", "1.25")  # a different pace is a different waveform
    assert other["cached"] is False and pacer.calls == 2 and other["seconds"] != body["seconds"]


def test_a_cue_has_peaks_too_and_a_missing_source_is_a_refusal(work: Path, cues_dir: Path, episode: dict[str, object]) -> None:
    s, _ = seams()
    key = cue_key("SFX", "A door creaks")
    body, code = ask(work, cues_dir, s, "peaks", "--source", f"cue:{key}")
    assert code == 0 and body["cached"] is False and body["source"] == {"kind": "cue", "key": key}
    assert ask(work, cues_dir, s, "peaks", "--source", f"cue:{key}")[0]["cached"] is True
    for bad, word in (("cue:" + "a" * 64, "not in the cue library"), ("take:" + "b" * 64, "no take"), ("take:xyz", "64 hex"), ("tape:" + "a" * 64, "take or cue"), ("nope", "take:<key>")):
        refusal, code = ask(work, cues_dir, s, "peaks", "--source", bad)
        assert code == 2 and word in str(refusal["message"]), bad
    assert ask(work, cues_dir, s, "peaks", "--source", f"cue:{key}", "--stretch", "0.9")[1] == 2  # only a take is paced


def test_compute_peaks_is_the_window_maximum() -> None:
    audio = np.zeros(SR // 2, dtype=np.float32)
    audio[10] = 0.5
    audio[-1] = -0.25
    peaks = compute_peaks(audio)
    assert len(peaks) == PEAKS_PER_SECOND // 2 and peaks[0] == 0.5 and peaks[-1] == 0.25 and sum(1 for p in peaks if p) == 2


# --- AC3: clip audio is the paced take ------------------------------------------------------------------------


def decode(body: dict[str, object]) -> tuple[np.ndarray, int]:
    assert body["mime"] == "audio/wav"
    data, rate = sf.read(io.BytesIO(base64.b64decode(str(body["b64"]))), dtype="float32")
    return data, rate


def test_clip_audio_for_dialogue_is_the_paced_take(work: Path, cues_dir: Path, episode: dict[str, object]) -> None:
    s, _ = seams()
    key = episode["lines"][0]["take"]  # type: ignore[index]
    natural, code = ask(work, cues_dir, s, "audio", "--source", f"take:{key}", "--stretch", "1.0")
    quicker, code2 = ask(work, cues_dir, s, "audio", "--source", f"take:{key}", "--stretch", "1.25")
    assert code == 0 and code2 == 0
    plain, rate = decode(natural)
    paced, rate2 = decode(quicker)
    assert rate == rate2 == SR == natural["sample_rate"]
    assert len(paced) == pytest.approx(len(plain) / 1.25, rel=0.01)  # paced before it reaches the view
    assert quicker["seconds"] == pytest.approx(len(paced) / SR, abs=1e-3)


def test_clip_audio_for_a_cue_is_the_library_asset(work: Path, cues_dir: Path, episode: dict[str, object]) -> None:
    s, _ = seams()
    body, code = ask(work, cues_dir, s, "audio", "--source", f"cue:{cue_key('SFX', 'A door creaks')}")
    assert code == 0
    audio, rate = decode(body)
    assert rate == SR and len(audio) == pytest.approx(0.5 * SR, abs=2) and np.max(np.abs(audio)) > 0.05
    # the asset as the mix plays it: brought to the SFX loudness target, as the export does (AGT-1799)
    assert integrated_lufs(audio, SR) == pytest.approx(DEFAULT_TARGETS["SFX"], abs=0.5)
    assert ask(work, cues_dir, s, "audio", "--source", "take:" + "c" * 64)[1] == 2


# --- AC2: save writes the next version and never rewrites one -------------------------------------------------


def edited(doc: dict[str, object]) -> dict[str, object]:
    out = copy.deepcopy(doc)
    first_dialogue_clip(out)["gain"] = -3.0
    out["tracks"]["beds"]["volume"] = -2.0  # type: ignore[index]
    return out


def test_save_writes_the_next_version_by_human_with_a_diff_and_leaves_the_old_one(work: Path, cues_dir: Path, episode: dict[str, object], tmp_path: Path) -> None:
    s, _ = seams()
    v1_before = mix_path(work, 1, 1).read_bytes()
    body, code = save(work, cues_dir, s, tmp_path, edited(read_mix(work, 1, 1)), 1)
    assert code == 0 and (body["version"], body["parent"], body["by"]) == (2, 1, "human")
    assert body["summary"]["changed"] == [first_dialogue_clip(read_mix(work, 1, 1))["id"]] and body["summary"]["tracks"] == ["beds"]  # type: ignore[index]
    assert mix_versions(work, 1) == [1, 2] and mix_path(work, 1, 1).read_bytes() == v1_before
    saved = read_mix(work, 1, 2)
    assert (saved["by"], saved["parent"], saved["version"], saved["manifest_version"]) == ("human", 1, 2, 1)
    assert "1 changed" in saved["summary"] and first_dialogue_clip(saved)["gain"] == -3.0  # type: ignore[operator]
    assert [v["version"] for v in body["versions"]] == [1, 2]  # type: ignore[union-attr]

    loaded, _ = ask(work, cues_dir, s, "load", "--episode", "1")
    assert (loaded["version"], loaded["newest"]) == (2, 2) and [v["by"] for v in loaded["versions"]] == ["auto", "human"]  # type: ignore[union-attr]


def test_save_refuses_a_base_that_is_not_the_newest_and_writes_nothing(work: Path, cues_dir: Path, episode: dict[str, object], tmp_path: Path) -> None:
    s, _ = seams()
    assert save(work, cues_dir, s, tmp_path, edited(read_mix(work, 1, 1)), 1)[1] == 0
    again = edited(read_mix(work, 1, 1))
    again["tracks"]["sfx"]["volume"] = -9.0  # type: ignore[index]
    body, code = save(work, cues_dir, s, tmp_path, again, 1)  # v1 is no longer the newest
    assert code == 2 and body["stale"] is True and body["newest"] == 2 and "not the newest" in str(body["message"])
    assert mix_versions(work, 1) == [1, 2]


def test_save_refuses_an_invalid_document_naming_the_field_and_writes_nothing(work: Path, cues_dir: Path, episode: dict[str, object], tmp_path: Path) -> None:
    s, _ = seams()
    bad = edited(read_mix(work, 1, 1))
    first_dialogue_clip(bad)["fade_in"] = {"len": 0.1, "curve": "wobble"}
    body, code = save(work, cues_dir, s, tmp_path, bad, 1)
    assert code == 2 and "fade_in.curve" in str(body["field"])
    missing = edited(read_mix(work, 1, 1))
    missing["manifest_version"] = 7
    assert save(work, cues_dir, s, tmp_path, missing, 1)[1] == 2
    unvoiced = edited(read_mix(work, 1, 1))
    del unvoiced["tracks"]["dialogue"]["lanes"]["OTTO"]  # type: ignore[attr-defined,index]
    body, code = save(work, cues_dir, s, tmp_path, unvoiced, 1)
    assert code == 2 and "no dialogue clip" in str(body["message"]) + json.dumps(body.get("problems"))
    assert mix_versions(work, 1) == [1]


def test_saving_an_unchanged_document_writes_nothing(work: Path, cues_dir: Path, episode: dict[str, object], tmp_path: Path) -> None:
    s, _ = seams()
    body, code = save(work, cues_dir, s, tmp_path, read_mix(work, 1, 1), 1)
    assert code == 2 and body["unchanged"] is True and mix_versions(work, 1) == [1]


def test_save_and_the_mixer_need_their_arguments(work: Path, cues_dir: Path, episode: dict[str, object]) -> None:
    s, _ = seams()
    assert ask(work, cues_dir, s, "save", "--episode", "1")[1] == 2
    assert ask(work, cues_dir, s, "save")[1] == 2
    assert ask(work, cues_dir, s, "load", "--episode", "x")[1] == 1
    assert ask(work, cues_dir, s, "rewind")[1] == 1


# --- AGT-2152: render from the mixer window -------------------------------------------------------------------


def test_load_says_which_mix_version_the_audio_on_disk_was_rendered_from(work: Path, cues_dir: Path, episode: dict[str, object], tmp_path: Path) -> None:
    s, _ = seams()
    body, _ = ask(work, cues_dir, s, "load", "--episode", "1")
    assert body["rendered"] == {"manifest": 1, "mix": 1}
    assert save(work, cues_dir, s, tmp_path, edited(read_mix(work, 1, 1)), 1)[1] == 0
    body, _ = ask(work, cues_dir, s, "load", "--episode", "1")
    assert (body["newest"], body["rendered"]) == (2, {"manifest": 1, "mix": 1})  # the audio is older than mix v2


def test_render_mixes_the_saved_document_into_a_new_episode_file(work: Path, cues_dir: Path, episode: dict[str, object], tmp_path: Path) -> None:
    s, _ = seams()
    assert save(work, cues_dir, s, tmp_path, edited(read_mix(work, 1, 1)), 1)[1] == 0
    body, code = ask(work, cues_dir, s, "render", "--episode", "1", "--base", "2")
    assert code == 0 and body["ok"], body
    assert body["mixWritten"] is False and str(body["mixDocument"]).endswith("mix.v2.json")
    assert body["rendered"] == {"manifest": 2, "mix": 2} and audio_versions(work, 1) == [1, 2]
    assert mix_versions(work, 1) == [1, 2]  # rendering writes no mix version
    loaded, _ = ask(work, cues_dir, s, "load", "--episode", "1")
    assert loaded["rendered"] == {"manifest": 2, "mix": 2}


def test_render_refuses_a_stale_base_and_a_document_that_no_longer_fits(work: Path, cues_dir: Path, episode: dict[str, object], tmp_path: Path) -> None:
    s, _ = seams()
    assert save(work, cues_dir, s, tmp_path, edited(read_mix(work, 1, 1)), 1)[1] == 0
    body, code = ask(work, cues_dir, s, "render", "--episode", "1", "--base", "1")
    assert code == 2 and body["stale"] is True and body["newest"] == 2
    assert ask(work, cues_dir, s, "render", "--episode", "1")[1] == 2  # --base is required
    retake = proposal(work, cues=[cue("SFX", "A door creaks", 0), cue("BED", "Rain on a tin roof", 1)])
    retake["lines"][1]["take"] = take_for(work, 1, attempt=1)  # type: ignore[index]
    flags_path(work).parent.mkdir(parents=True, exist_ok=True)
    flags_path(work).write_text(json.dumps({"flags": [{"id": "f-1", "episode": 1, "line": 1, "reason": "flat"}]}))
    write_version(work, 1, retake, flags_applied=["f-1"])  # a fix re-took line 1: mix v2 no longer voices the manifest's takes
    body, code = ask(work, cues_dir, s, "render", "--episode", "1", "--base", "2")
    assert code == 2 and "does not fit" in str(body["message"])
    assert audio_versions(work, 1) == [1] and mix_versions(work, 1) == [1, 2]  # nothing rendered, no auto mix written


# --- AGT-2156: regenerate a cue from the mixer ------------------------------------------------------------------


def cue_clip(doc: dict[str, object], track: str = "sfx") -> dict[str, object]:
    return next(iter(doc["tracks"][track]["lanes"].values()))["clips"][0]  # type: ignore[index,no-any-return]


def test_cue_options_list_the_generated_asset_for_the_clips_description(work: Path, cues_dir: Path, episode: dict[str, object]) -> None:
    s, _ = seams()
    clip = cue_clip(read_mix(work, 1, 1))
    body, code = ask(work, cues_dir, s, "cue-options", "--episode", "1", "--clip", str(clip["id"]))
    assert code == 0 and (body["kind"], body["desc"]) == ("SFX", "A door creaks")
    assert [(o["generated"], o["current"]) for o in body["options"]] == [(True, True)]  # type: ignore[union-attr]
    edited, _ = ask(work, cues_dir, s, "cue-options", "--episode", "1", "--clip", str(clip["id"]), "--describe", "A heavy door slams")
    assert edited["options"][0]["key"] == cue_key("SFX", "A heavy door slams") and edited["options"][0]["current"] is False  # type: ignore[index]
    assert edited["options"][0]["made"] is False  # type: ignore[index]


def test_regenerating_a_cue_swaps_the_source_and_keeps_position_fades_and_gain(work: Path, cues_dir: Path, episode: dict[str, object]) -> None:
    s, cues = seams()
    old = read_mix(work, 1, 1)
    clip = cue_clip(old)
    body, code = ask(work, cues_dir, s, "cue", "--episode", "1", "--base", "1", "--clip", str(clip["id"]), "--describe", "A heavy door slams")
    assert code == 0 and body["version"] == 2 and body["by"] == "human" and body["made"] is True
    assert ("SFX", "A heavy door slams") in cues.made
    new = read_mix(work, 1, 2)
    swapped = cue_clip(new)
    assert swapped["source"] == {"kind": "cue", "key": cue_key("SFX", "A heavy door slams")}
    assert {k: v for k, v in swapped.items() if k != "source"} == {k: v for k, v in clip.items() if k != "source"}
    assert read_mix(work, 1, 1) == old  # the old version is untouched: it is the undo
    assert new["by"] == "human" and "regenerated" in str(new["summary"])


def test_regenerating_refuses_a_stale_base_a_dialogue_clip_and_an_unchanged_cue(work: Path, cues_dir: Path, episode: dict[str, object]) -> None:
    s, _ = seams()
    doc = read_mix(work, 1, 1)
    cid = str(cue_clip(doc)["id"])
    body, code = ask(work, cues_dir, s, "cue", "--episode", "1", "--base", "9", "--clip", cid, "--describe", "x")
    assert code == 2 and "not the newest" in str(body["message"])
    body, code = ask(work, cues_dir, s, "cue", "--episode", "1", "--base", "1", "--clip", str(first_dialogue_clip(doc)["id"]), "--describe", "x")
    assert code == 2 and "not a cue clip" in str(body["message"])
    body, code = ask(work, cues_dir, s, "cue", "--episode", "1", "--base", "1", "--clip", cid)
    assert code == 2 and "already plays" in str(body["message"])
    assert ask(work, cues_dir, s, "cue", "--episode", "1", "--base", "1", "--clip", "nope", "--describe", "x")[1] == 2
    assert mix_versions(work, 1) == [1]  # nothing was written
