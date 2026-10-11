"""`mix` over invented takes, a fake cue generator, a fake pacer and encoder (AGT-1684). Model-free.

Every script line, cue description and voice here is invented; the fake
generator and the tone engine write sine waves, and the "m4a" the fake encoder
makes is the mixed WAV itself, so a test can read the final file back.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from pablo_casting.cli import run
from pablo_casting.cues import CUE_RATE, CueLibrary, CueUnavailable, cue_key, is_stop, normalise_desc
from pablo_casting.manifest import ManifestError, attach_mix, episode_dir, flags_path, read_version, versions, write_version
from pablo_casting.mix import SR, MixRequest, Seams, check_timings, mix, sox_pacer
from pablo_casting.takes import Direction, EngineId, Line, TakeInputs, record_take
from pablo_casting.wav import Audio

ENGINE = EngineId(id="tone", weights_sha256="0" * 64, mlx_audio="none", mlx="none")
RATE = 24_000


class ToneEngine:
    """One sine tone per take: 0.4 s a word from 0.1 s in, plus the 180 ms tail a real take keeps."""

    identity = ENGINE

    def synthesize(self, inputs: TakeInputs):  # type: ignore[no-untyped-def]
        from pablo_casting.takes import Synthesis, WordTiming

        words = [w for line in inputs.lines for w in line.text.split()]
        seconds = 0.1 + 0.4 * len(words) + 0.18
        t = np.arange(int(seconds * RATE)) / RATE
        wave = (0.4 * np.sin(2 * np.pi * 220 * t) * (t >= 0.1) * (t < 0.1 + 0.4 * len(words))).astype(np.float32)
        pcm = (wave * 32767).astype("<i2").tobytes()
        timings = tuple(WordTiming(word=w, start=round(0.1 + 0.4 * k, 3), end=round(0.1 + 0.4 * (k + 1), 3)) for k, w in enumerate(words))
        return Synthesis(audio=Audio(frames=pcm, sample_rate=RATE), words=timings)


class FakeCues:
    """Deterministic 0.5 s tones, counting what it was asked to make."""

    id = "fake-cues/1"

    def __init__(self) -> None:
        self.made: list[tuple[str, str]] = []

    def generate(self, kind: str, desc: str, seed: int) -> np.ndarray:
        self.made.append((kind, desc))
        t = np.arange(int(0.5 * CUE_RATE)) / CUE_RATE
        return (0.5 * np.sin(2 * np.pi * (300 + seed % 400) * t)).astype(np.float32)


def fake_pacer(audio: np.ndarray, rate: int, stretch: float) -> np.ndarray:
    """A resample-based stand-in for sox's tempo: same length change, no pitch care."""
    if stretch == 1.0:
        return audio
    n = int(len(audio) / stretch)
    return np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)


def fake_encoder(wav: Path, destination: Path) -> None:
    shutil.copyfile(wav, destination)


def seams(cues: FakeCues | None = None) -> tuple[Seams, FakeCues]:
    cues = cues or FakeCues()
    return Seams(generators=lambda kind: cues, pacer=fake_pacer, encoder=fake_encoder), cues


@pytest.fixture
def work(tmp_path: Path) -> Path:
    path = tmp_path / "work"
    path.mkdir()
    return path


@pytest.fixture
def cues_dir(tmp_path: Path) -> Path:
    return tmp_path / "cues"


SCRIPT = [
    ("ANNOUNCER", "Good evening from the harbour."),  # 5 words -> 2.0 s of words
    ("MAVIS", "The fog is in."),  # 4
    ("OTTO", "Mind the step."),  # 3
    ("MAVIS", "Always the same."),  # 3
]


def take_for(work: Path, i: int, attempt: int = 0) -> str:
    speaker, text = SCRIPT[i]
    inputs = TakeInputs(engine=ENGINE, voice=f"card-{speaker.lower()}", lines=(Line(speaker, text),), seed=10 + attempt, direction=Direction())
    take, _ = record_take(work, ToneEngine(), inputs, attempt=attempt)
    return take.key


def proposal(work: Path, cues: list[dict[str, object]] | None = None, stretch: dict[int, float] | None = None) -> dict[str, object]:
    stretch = stretch or {}
    return {
        "script_sha256": "s" * 64,
        "cast_hash": "c" * 64,
        "engine": {"id": ENGINE.id, "weights_sha256": ENGINE.weights_sha256},
        "pace_policy": {"stretch_range": [0.75, 1.05]},
        "lines": [
            {"i": i, "speaker": s, "text": text, "take": take_for(work, i), "stretch": stretch.get(i, 1.0)} for i, (s, text) in enumerate(SCRIPT)
        ],
        "cues": cues or [],
        "duration": 9.0,
        "rtf_total": 1.0,
    }


def cue(kind: str, desc: str, after: int) -> dict[str, object]:
    return {"kind": kind, "desc": desc, "after": after, "line": 10 + after}


def performed(work: Path, **kwargs: object) -> dict[str, object]:
    """A `perform`-shaped v1: takes, cues, `audio: null`, no line timings."""
    return write_version(work, 1, proposal(work, **kwargs)).manifest  # type: ignore[arg-type]


def mixed(work: Path, cues_dir: Path, *, version: int | None = None, cues: FakeCues | None = None, episode: int = 1) -> dict[str, object]:
    s, _ = seams(cues)
    body, code = mix(MixRequest(work=work, episode=episode, cues_dir=cues_dir, version=version), s)
    assert code == 0, body
    return body


def tree(work: Path) -> dict[str, bytes]:
    root = work / "outputs" / "radio" / "casting"
    return {str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file() and not p.is_symlink()}


def final_audio(work: Path, episode: int = 1) -> tuple[np.ndarray, int]:
    data, rate = sf.read(str(episode_dir(work, episode) / f"ep{episode:02d}.m4a"), dtype="float32")
    return data, rate


def rms(samples: np.ndarray, start: float, end: float, rate: int) -> float:
    chunk = samples[int(start * rate) : int(end * rate)]
    return float(np.sqrt(np.mean(chunk**2))) if len(chunk) else 0.0


# --- the voice track and the timings ---------------------------------------------------------


def test_a_mix_completes_the_performed_version_in_place(work: Path, cues_dir: Path) -> None:
    v1 = performed(work)
    assert v1["audio"] is None and "start" not in v1["lines"][0]  # type: ignore[index]
    body = mixed(work, cues_dir)

    assert (body["version"], body["newVersion"], body["linkMoved"]) == (1, False, True)
    assert versions(work, 1) == [1]
    done = read_version(work, 1, 1)
    assert done["audio"] == "ep01.v1.m4a"
    assert os.readlink(episode_dir(work, 1) / "ep01.m4a") == "ep01.v1.m4a"
    assert [l["take"] for l in done["lines"]] == [l["take"] for l in v1["lines"]]  # type: ignore[index,union-attr]
    assert done["changed_lines"] == v1["changed_lines"]
    assert all(isinstance(l["start"], float) and l["end"] > l["start"] for l in done["lines"])  # type: ignore[index,union-attr]
    assert done["mix"]["sample_rate"] == SR  # type: ignore[index]
    assert done["duration"] == body["duration"]


def test_each_line_is_audible_exactly_where_the_manifest_says(work: Path, cues_dir: Path) -> None:
    performed(work)
    mixed(work, cues_dir)
    done = read_version(work, 1, 1)
    audio, rate = final_audio(work)
    assert rate == SR
    for line in done["lines"]:  # type: ignore[union-attr]
        assert rms(audio, line["start"] + 0.05, line["end"] - 0.05, rate) > 0.1, line
    # the air between two lines is silent
    first, second = done["lines"][0], done["lines"][1]  # type: ignore[index]
    assert rms(audio, first["end"] + 0.05, second["start"] - 0.05, rate) < 0.01
    # a line lasts as long as its words: 5 words x 0.4 s
    assert first["end"] - first["start"] == pytest.approx(2.0, abs=0.01)


def test_a_paced_take_is_shortened_and_its_timings_follow(work: Path, cues_dir: Path) -> None:
    performed(work, stretch={0: 1.25})
    mixed(work, cues_dir)
    first = read_version(work, 1, 1)["lines"][0]  # type: ignore[index]
    assert first["end"] - first["start"] == pytest.approx(2.0 / 1.25, abs=0.02)
    audio, rate = final_audio(work)
    assert rms(audio, first["start"] + 0.05, first["end"] - 0.05, rate) > 0.1
    assert rms(audio, first["end"] + 0.1, first["end"] + 0.25, rate) < 0.01


def test_a_last_word_that_ends_after_the_trimmed_take_is_clamped_to_the_take(work: Path, cues_dir: Path) -> None:
    class Overrun(ToneEngine):
        def synthesize(self, inputs: TakeInputs):  # type: ignore[no-untyped-def]
            from pablo_casting.takes import Synthesis, WordTiming

            base = super().synthesize(inputs)
            *head, last = base.words
            return Synthesis(audio=base.audio, words=(*head, WordTiming(word=last.word, start=last.start, end=last.end + 0.5)))

    inputs = TakeInputs(engine=ENGINE, voice="card-x", lines=(Line("MAVIS", "One two three."),), seed=9)
    take, _ = record_take(work, Overrun(), inputs)
    base = proposal(work)
    base["lines"] = [{"i": 0, "speaker": "MAVIS", "text": "One two three.", "take": take.key, "stretch": 1.0}]
    write_version(work, 1, base)
    mixed(work, cues_dir)
    line = read_version(work, 1, 1)["lines"][0]  # type: ignore[index]
    # the take is 0.1 + 1.2 + 0.18 s long; the stored last word ends 0.5 s later than its 1.3 s
    assert line["end"] - line["start"] == pytest.approx(1.48 - 0.1, abs=0.01)


def test_lines_that_share_a_take_split_its_words(work: Path, cues_dir: Path) -> None:
    two = TakeInputs(
        engine=ENGINE,
        voice="card-pair",
        lines=(Line("MAVIS", "One two three."), Line("OTTO", "Four five.")),
        seed=3,
    )
    pair, _ = record_take(work, ToneEngine(), two)
    base = proposal(work)
    base["lines"] = [
        {"i": 0, "speaker": "MAVIS", "text": "One two three.", "take": pair.key, "stretch": 1.0},
        {"i": 1, "speaker": "OTTO", "text": "Four five.", "take": pair.key, "stretch": 1.0},
    ]
    write_version(work, 1, base)
    mixed(work, cues_dir)
    lines = read_version(work, 1, 1)["lines"]  # type: ignore[index]
    # words run 0.1 + 0.4 k: line 0 = words 0-2 -> 0.1..1.3, line 1 = words 3-4 -> 1.3..2.1 (one take, one offset)
    assert lines[0]["end"] - lines[0]["start"] == pytest.approx(1.2, abs=0.01)
    assert lines[1]["start"] == pytest.approx(lines[0]["end"], abs=0.01)
    assert lines[1]["end"] - lines[1]["start"] == pytest.approx(0.8, abs=0.01)


# --- cues -------------------------------------------------------------------------------------


def test_cues_sit_where_the_manifest_puts_them_and_hold_the_voice(work: Path, cues_dir: Path) -> None:
    performed(
        work,
        cues=[
            cue("MUSIC", "A brass sting", -1),
            cue("SFX", "A door creaks", 0),
            cue("BED", "Rain on a tin roof", 1),
            cue("BED", "off", 2),
        ],
    )
    body = mixed(work, cues_dir)
    done = read_version(work, 1, 1)
    music, sfx, bed, off = done["cues"]  # type: ignore[misc]
    lines = done["lines"]  # type: ignore[assignment]

    # MUSIC opens the episode at 0 and the first line waits for it (+0.2 s)
    assert music["start"] == 0.0 and music["end"] == pytest.approx(0.5, abs=0.001)
    assert lines[0]["start"] - 0.1 == pytest.approx(0.5 + 0.2, abs=0.01)
    # the SFX starts 0.4 s early, over the air after line 0, and holds line 1 until it ends + 0.2 s
    line0_take_end = lines[0]["end"] + 0.18  # the tail, then 0.35 s of air
    assert sfx["start"] == pytest.approx(line0_take_end + 0.35 - 0.4, abs=0.02)
    assert lines[1]["start"] - 0.1 == pytest.approx(sfx["end"] + 0.2, abs=0.02)
    # the bed runs from after line 1 to the `off` cue after line 2, and `off` has no asset
    assert bed["asset"].startswith("cues/") and bed["end"] == off["start"]  # type: ignore[union-attr]
    assert off["asset"] is None
    assert off["start"] > bed["start"] > lines[1]["end"]
    assert (body["cues"], body["cuesGenerated"], body["cuesReused"]) == (4, 3, 0)  # `off` makes no asset
    audio, rate = final_audio(work)
    assert rms(audio, music["start"] + 0.05, music["end"] - 0.05, rate) > 0.1


def test_the_loudest_sample_is_normalised_to_minus_one_dbfs(work: Path, cues_dir: Path) -> None:
    performed(work, cues=[cue("SFX", "Loud crash", 0)])
    mixed(work, cues_dir)
    audio, _ = final_audio(work)
    assert float(np.abs(audio).max()) == pytest.approx(10 ** (-1 / 20), abs=0.002)


# --- AC3: the cue library ---------------------------------------------------------------------


def test_the_same_description_is_the_same_asset_across_episodes_and_runs(work: Path, cues_dir: Path) -> None:
    performed(work, cues=[cue("SFX", "Glasses clinking", 0), cue("BED", "Porch ambience", 1)])
    # episode 2 asks for the same sounds, spelled a little differently
    write_version(work, 2, proposal(work, cues=[cue("SFX", "  glasses  CLINKING ", 1), cue("MUSIC", "Theme opens", -1)]))
    generator = FakeCues()

    first = mixed(work, cues_dir, cues=generator)
    assert (first["cuesGenerated"], first["cuesReused"]) == (2, 0)
    second = mixed(work, cues_dir, cues=generator, episode=2)
    assert (second["cuesGenerated"], second["cuesReused"]) == (1, 1)  # only the theme is new
    assert [kind for kind, _ in generator.made] == ["SFX", "BED", "MUSIC"]

    wavs = sorted(p.name for p in cues_dir.glob("*.wav"))
    assert wavs == sorted(f"{cue_key(k, d)}.wav" for k, d in [("SFX", "Glasses clinking"), ("BED", "Porch ambience"), ("MUSIC", "Theme opens")])
    one = read_version(work, 1, 1)["cues"][0]["asset"]  # type: ignore[index]
    two = read_version(work, 2, 1)["cues"][0]["asset"]  # type: ignore[index]
    assert one == two
    sidecar = json.loads((cues_dir / f"{cue_key('SFX', 'Glasses clinking')}.json").read_text())
    assert (sidecar["kind"], sidecar["desc"], sidecar["generator"]) == ("SFX", "Glasses clinking", "fake-cues/1")


def test_a_second_run_of_the_same_episode_generates_nothing(work: Path, cues_dir: Path) -> None:
    performed(work, cues=[cue("SFX", "A door creaks", 0), cue("MUSIC", "Closing theme", 3)])
    generator = FakeCues()
    assert mixed(work, cues_dir, cues=generator)["cuesGenerated"] == 2
    again = mixed(work, cues_dir, cues=generator)
    assert (again["cuesGenerated"], again["cuesReused"]) == (0, 2)
    assert len(generator.made) == 2


def test_an_existing_asset_is_never_regenerated_or_overwritten(cues_dir: Path) -> None:
    library = CueLibrary(cues_dir, lambda kind: FakeCues())
    first = library.ensure("SFX", "A bell")
    before = hashlib.sha256(first.path.read_bytes()).hexdigest()
    swapped = CueLibrary(cues_dir, lambda kind: pytest.fail("a present asset must not reach a generator"))
    again = swapped.ensure("SFX", "A  BELL")
    assert (again.generated, again.key, again.generator) == (False, first.key, "fake-cues/1")
    assert hashlib.sha256(again.path.read_bytes()).hexdigest() == before
    assert (cues_dir / ".gitignore").read_text().count("*.wav") == 1


def test_cue_keys_depend_on_kind_and_normalised_description_only() -> None:
    assert cue_key("SFX", "A  Door") == cue_key("SFX", "a door")
    assert cue_key("SFX", "a door") != cue_key("BED", "a door")
    assert normalise_desc("  Rain \n on  ROOF ") == "rain on roof"
    assert is_stop(" Off ") and is_stop("none") and not is_stop("offshore wind")


# --- AC2: versions -----------------------------------------------------------------------------


def test_mixing_a_mixed_version_makes_a_new_one_and_leaves_the_old_audio_alone(work: Path, cues_dir: Path) -> None:
    performed(work, cues=[cue("SFX", "A door creaks", 0)])
    mixed(work, cues_dir)
    v1_audio = episode_dir(work, 1) / "ep01.v1.m4a"
    v1_json = episode_dir(work, 1) / "v1.json"
    audio_before, json_before = v1_audio.read_bytes(), v1_json.read_bytes()

    body = mixed(work, cues_dir)

    assert (body["version"], body["mixedFrom"], body["newVersion"]) == (2, 1, True)
    assert v1_audio.read_bytes() == audio_before and v1_json.read_bytes() == json_before
    v2 = read_version(work, 1, 2)
    assert (v2["parent"], v2["changed_lines"], v2["flags_applied"], v2["audio"]) == (1, [], [], "ep01.v2.m4a")
    assert [l["take"] for l in v2["lines"]] == [l["take"] for l in read_version(work, 1, 1)["lines"]]  # type: ignore[index,union-attr]
    assert os.readlink(episode_dir(work, 1) / "ep01.m4a") == "ep01.v2.m4a"
    assert (episode_dir(work, 1) / "ep01.v2.m4a").read_bytes() == audio_before  # identical inputs, identical mix


def test_an_older_mixed_version_cannot_be_remixed_in_place(work: Path, cues_dir: Path) -> None:
    performed(work)
    mixed(work, cues_dir)
    mixed(work, cues_dir)  # v2
    before = tree(work)
    s, _ = seams()
    body, code = mix(MixRequest(work=work, episode=1, cues_dir=cues_dir, version=1), s)
    assert code == 2 and body["latest"] == 2 and "newest" in str(body["message"])
    assert tree(work) == before


def test_mixing_an_unmixed_older_version_does_not_pull_the_link_back(work: Path, cues_dir: Path, tmp_path: Path) -> None:
    v1 = performed(work)
    flags_path(work).parent.mkdir(parents=True, exist_ok=True)
    flags_path(work).write_text(json.dumps({"flags": [{"id": "f-1", "episode": 1, "line": 1, "reason": "flat"}]}))
    takes = {l["i"]: l["take"] for l in v1["lines"]}  # type: ignore[union-attr,index]
    retake = proposal(work)
    retake["lines"][1]["take"] = take_for(work, 1, attempt=1)  # type: ignore[index]
    write_version(work, 1, retake, flags_applied=["f-1"])
    s, _ = seams()
    assert mix(MixRequest(work=work, episode=1, cues_dir=cues_dir), s)[0]["version"] == 2
    body = mixed(work, cues_dir, version=1)

    assert (body["version"], body["newVersion"], body["linkMoved"]) == (1, False, False)
    assert os.readlink(episode_dir(work, 1) / "ep01.m4a") == "ep01.v2.m4a"
    assert read_version(work, 1, 1)["audio"] == "ep01.v1.m4a"
    assert takes == {l["i"]: l["take"] for l in read_version(work, 1, 1)["lines"]}  # type: ignore[union-attr,index]


def test_attach_mix_only_fills_an_unmixed_manifest(work: Path, tmp_path: Path) -> None:
    performed(work)
    audio = tmp_path / "x.m4a"
    audio.write_bytes(b"x")
    completed = read_version(work, 1, 1)
    completed["lines"] = [{**l, "start": 1.0, "end": 2.0} for l in completed["lines"]]  # type: ignore[union-attr]
    attach_mix(work, 1, 1, completed, audio, link=True)
    with pytest.raises(ManifestError, match="already has audio"):
        attach_mix(work, 1, 1, completed, audio, link=True)

    performed_again = tmp_path / "w2"
    performed_again.mkdir()
    write_version(performed_again, 1, proposal(performed_again))
    drift = read_version(performed_again, 1, 1)
    drift["lines"] = [{**l, "start": 0.0, "end": 1.0, "take": "0" * 64} for l in drift["lines"]]  # type: ignore[union-attr]
    with pytest.raises(ManifestError, match="only adds timings"):
        attach_mix(performed_again, 1, 1, drift, audio, link=True)
    assert read_version(performed_again, 1, 1)["audio"] is None


# --- refusals ------------------------------------------------------------------------------------


def test_refusals_write_nothing(work: Path, cues_dir: Path) -> None:
    s, _ = seams()
    body, code = mix(MixRequest(work=work, episode=1, cues_dir=cues_dir), s)
    assert code == 2 and "pablo perform" in str(body["message"])

    performed(work, cues=[cue("SFX", "A door creaks", 0)])
    body, code = mix(MixRequest(work=work, episode=1, cues_dir=cues_dir, version=7), s)
    assert code == 2 and body["versions"] == [1]

    before = tree(work)

    class Missing:
        id = "none"

        def generate(self, kind: str, desc: str, seed: int) -> np.ndarray:
            raise CueUnavailable("SFX and BED cues need Stable Audio Open (the `mix` extra)")

    body, code = mix(MixRequest(work=work, episode=1, cues_dir=cues_dir), Seams(generators=lambda kind: Missing(), pacer=fake_pacer, encoder=fake_encoder))
    assert code == 2 and "mix` extra" in str(body["message"])
    assert tree(work) == before and read_version(work, 1, 1)["audio"] is None
    assert not (episode_dir(work, 1) / "ep01.m4a").exists()


def test_a_take_missing_from_the_store_is_a_refusal(work: Path, cues_dir: Path) -> None:
    performed(work)
    lost = str(read_version(work, 1, 1)["lines"][2]["take"])  # type: ignore[index]
    # write_version validated the takes when v1 was written; a store that lost one since must not mix a hole
    (work / "outputs" / "radio" / "casting" / "takes" / lost / "take.wav").unlink()
    before = tree(work)
    s, _ = seams()
    body, code = mix(MixRequest(work=work, episode=1, cues_dir=cues_dir), s)
    assert code == 2 and body["missing_takes"] == [lost]
    assert tree(work) == before


# --- AC1: the aligner on the final file -----------------------------------------------------------


def exact_aligner(work: Path, offset: float = 0.0):  # type: ignore[no-untyped-def]
    """A stand-in aligner that finds the tone: first and last loud sample of the window."""

    def align(window: Path, text: str):  # type: ignore[no-untyped-def]
        data, rate = sf.read(str(window), dtype="float32")
        loud = np.flatnonzero(np.abs(data) > 0.05)
        if not len(loud):
            return []
        return [{"word": text.split()[0], "start": loud[0] / rate + offset, "end": loud[-1] / rate + offset}]

    return align


def test_check_timings_measures_the_final_file_against_the_manifest(work: Path, cues_dir: Path) -> None:
    performed(work, cues=[cue("SFX", "A door creaks", 0)], stretch={1: 1.1})
    mixed(work, cues_dir)
    manifest = read_version(work, 1, 1)
    audio = episode_dir(work, 1) / "ep01.m4a"

    good = check_timings(manifest, audio, exact_aligner(work), pad=0.1)
    assert (good["lines"], good["within"], good["share"]) == (4, 4, 1.0)

    # the SFX tone is quieter than the voice, so the voice windows stay clean; shift every answer 0.4 s
    off = check_timings(manifest, audio, exact_aligner(work, offset=0.4), pad=0.1)
    assert off["within"] == 0 and off["share"] == 0.0
    near = check_timings(manifest, audio, exact_aligner(work, offset=0.1), pad=0.1)
    assert near["share"] == 1.0


# --- the real pacer and the command line ------------------------------------------------------------


@pytest.mark.skipif(shutil.which("sox") is None, reason="sox is not installed")
def test_sox_tempo_changes_the_length_by_the_stretch() -> None:
    t = np.arange(RATE * 2) / RATE
    tone = (0.4 * np.sin(2 * np.pi * 180 * t)).astype(np.float32)
    faster = sox_pacer(tone, RATE, 1.25)
    assert len(faster) == pytest.approx(len(tone) / 1.25, rel=0.02)
    assert sox_pacer(tone, RATE, 1.0) is tone


@pytest.mark.skipif(shutil.which("sox") is None, reason="sox is not installed")
def test_the_organ_is_deterministic_and_a_sting_is_shorter_than_a_theme() -> None:
    from pablo_casting.organ import organ_cue

    sting, again = organ_cue("a sudden sting"), organ_cue("a sudden sting")
    theme = organ_cue("Theme opens, warm")
    assert len(sting) == len(again) and np.allclose(sting, again, atol=0.02)  # sox's reverb dithers: close, not bit-equal
    assert 2.0 < len(sting) / SR < 6.0 and len(theme) > len(sting)
    assert 0.5 < float(np.abs(sting).max()) <= 1.0


def test_the_command_line_mixes_and_reports_json(work: Path, cues_dir: Path, capsys: pytest.CaptureFixture[str]) -> None:
    performed(work, cues=[cue("SFX", "A door creaks", 0)])
    s, _ = seams()
    argv = ["mix", "--work", str(work), "--episode", "1", "--cues", str(cues_dir), "--json"]
    (body, code), wants_json = run(argv, mixer=s)
    assert (code, wants_json, body["ok"], body["version"], body["cuesGenerated"]) == (0, True, True, 1, 1)
    (body, code), _ = run([*argv, "--version", "1"], mixer=s)  # v1 is mixed and newest: a remix
    assert (code, body["version"], body["newVersion"], body["cuesReused"]) == (0, 2, True, 1)
    (body, code), _ = run(["mix", "--work", str(work), "--json"], mixer=s)
    assert code == 2 and "--episode" in str(body["message"])
    (body, code), _ = run(["mix", "--work", str(work), "--episode", "x", "--json"], mixer=s)
    assert code == 1
    (body, code), _ = run(["mix", "--episode", "1", "--json"], mixer=s)
    assert code == 2 and "--work" in str(body["message"])


def test_the_cue_library_defaults_to_the_voice_librarys_cues_directory(work: Path, tmp_path: Path) -> None:
    from pablo_casting.mix import cues_dir_for

    assert cues_dir_for(work, None, str(tmp_path / "lib"), None) == tmp_path / "lib" / "cues"
    assert cues_dir_for(work, None, None, str(tmp_path / "vault")) == tmp_path / "vault" / "casting" / "cues"
    assert cues_dir_for(work, None, None, None) == work / "outputs" / "radio" / "casting" / "cues"
    assert cues_dir_for(work, str(tmp_path / "x"), str(tmp_path / "lib"), None) == tmp_path / "x"


@pytest.mark.models
def test_stable_audio_makes_a_real_sfx_and_a_second_ask_is_a_hit(tmp_path: Path) -> None:
    """Loads Stable Audio Open (the `mix` extra, ~2 GB of weights in the HF cache); run by hand with `-m models`."""
    from pablo_casting.cues import real_generators

    library = CueLibrary(tmp_path / "cues", real_generators())
    first = library.ensure("SFX", "a small bell ringing once")
    assert first.generated and 3.5 < first.seconds < 4.5
    samples = library.load(first)
    assert 0.1 < float(np.abs(samples).max()) <= 0.81
    second = CueLibrary(tmp_path / "cues", lambda kind: pytest.fail("a hit must not load a model")).ensure("SFX", "A small bell ringing once")
    assert not second.generated and second.path == first.path
