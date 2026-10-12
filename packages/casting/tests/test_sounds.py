"""The CC0 sound library (AGT-1799): licence records, deterministic matching, cues built from recordings,
rhythmic beds looped at their period, and per-kind loudness. Model-free.

Every recording here is invented: synthetic signals written to a temporary
library with invented records (an example.org source URL, a test author). No
real recording is in the repo.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from test_mix import fake_pacer, work, cues_dir  # noqa: F401 (fixtures)
from test_mix_beds import BedCues, beds_only, cue, episode

from pablo_casting.cli import run
from pablo_casting.cues import CUE_RATE, CueLibrary, cue_key
from pablo_casting.loudness import DEFAULT_TARGETS, PEAK_CEILING, integrated_lufs, normalisation, targets_from
from pablo_casting.mix import SR, LoopPlan, Sources, Timeline, _group_lines, _lines, auto_timeline, render_document
from pablo_casting.mixdoc import clips
from pablo_casting.sounds import SoundLibrary, SoundRefusal, record_problems, rhythm_loop, stem, terms, tick_jitter

RATE = 48_000
CLOCK_SECONDS = 20.0


def record(sid: str, **over: object) -> dict[str, object]:
    base: dict[str, object] = {
        "id": sid,
        "title": f"Invented {sid}",
        "source_url": f"https://example.org/sounds/{sid}",
        "licence": "CC0-1.0",
        "author": "pablo tests",
        "kinds": ["SFX"],
        "subjects": ["door"],
        "tags": [],
    }
    return {**base, **over}


def tone(seconds: float, freq: float, amp: float = 0.3, rate: int = RATE) -> np.ndarray:
    t = np.arange(int(seconds * rate)) / rate
    return (amp * np.sin(2 * np.pi * freq * t) * np.exp(-t * 3)).astype(np.float32)


def clock(seconds: float = CLOCK_SECONDS, period: float = 0.9, wobble: float = 0.02, rate: int = RATE, seed: int = 7) -> tuple[np.ndarray, list[int]]:
    """A ticking clock: a short 2.5 kHz knock every `period` s give or take `wobble` (a real clock is not a metronome), over room noise."""
    rng = np.random.default_rng(seed)
    audio = (rng.standard_normal(int(seconds * rate)) * 0.002).astype(np.float32)
    knock = int(0.012 * rate)
    shape = (np.sin(2 * np.pi * 2500 * np.arange(knock) / rate) * np.exp(-np.arange(knock) / (0.002 * rate))).astype(np.float32)
    at, ticks = int(0.3 * rate), []
    while at + knock < len(audio):
        audio[at : at + knock] += 0.6 * shape
        ticks.append(at)
        at += int((period + rng.uniform(-wobble, wobble)) * rate)
    return audio, ticks


def write(path: Path, audio: np.ndarray, rate: int = RATE) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), audio, rate, format="FLAC", subtype="PCM_24")
    return path


@pytest.fixture
def downloads(tmp_path: Path) -> Path:
    return tmp_path / "downloads"


@pytest.fixture
def library(tmp_path: Path, downloads: Path) -> SoundLibrary:
    lib = SoundLibrary(tmp_path / "sounds", [])
    lib.add(write(downloads / "door.flac", tone(2.0, 180)), record("test-oak-door", subjects=["door"], tags=["oak", "wood", "heavy", "open", "close"]))
    lib.add(write(downloads / "glass.flac", tone(0.6, 3200)), record("test-glass-clink", subjects=["glass", "clink"], tags=["toast"]))
    lib.add(write(downloads / "glass2.flac", tone(0.6, 2900)), record("test-glass-cheers", subjects=["glass", "clink"], tags=["cheers"]))
    noise = (np.random.default_rng(3).standard_normal(int(30 * RATE)) * 0.05).astype(np.float32)
    lib.add(write(downloads / "porch.flac", noise), record("test-porch-evening", kinds=["BED"], subjects=["porch", "evening"], tags=["breeze", "distant"]))
    lib.add(write(downloads / "clock.flac", clock()[0]), record("test-clock", kinds=["BED", "SFX"], subjects=["clock", "tick"], tags=["grandfather", "pendulum", "heavy"], rhythmic=True))
    return lib


# --- AC1: only CC0 / public domain, each with its source and author ------------------------------------------


@pytest.mark.parametrize(
    ("change", "complaint"),
    [
        ({"licence": None}, "licence"),
        ({"licence": "CC-BY-4.0"}, "licence"),
        ({"licence": "CC-BY-SA-4.0"}, "licence"),
        ({"source_url": None}, "source_url"),
        ({"source_url": "a page somewhere"}, "source_url"),
        ({"author": ""}, "author"),
        ({"kinds": ["MUSIC"]}, "kinds"),
        ({"subjects": []}, "subjects"),
    ],
)
def test_a_recording_without_a_cc0_licence_record_and_its_source_is_refused(tmp_path: Path, downloads: Path, change: dict[str, object], complaint: str) -> None:
    lib = SoundLibrary(tmp_path / "sounds", [])
    raw = {k: v for k, v in {**record("test-x"), **change}.items() if v is not None}
    with pytest.raises(SoundRefusal) as refused:
        lib.add(write(downloads / "x.flac", tone(1.0, 400)), raw)
    assert complaint in str(refused.value)
    assert not (tmp_path / "sounds").exists() or not list((tmp_path / "sounds").glob("test-x*"))


def test_public_domain_is_allowed_as_well_as_cc0() -> None:
    assert record_problems(record("test-pd", licence="public-domain")) == []
    assert record_problems(record("test-cc0")) == []


def test_a_library_holding_an_unlicensed_record_is_a_refusal_naming_it(library: SoundLibrary) -> None:
    assert len(SoundLibrary.load(library.root).sounds) == 5
    planted = json.loads((library.root / "test-oak-door.json").read_text())
    (library.root / "test-oak-door.json").write_text(json.dumps({**planted, "licence": "CC-BY-NC-4.0"}))
    with pytest.raises(SoundRefusal) as refused:
        SoundLibrary.load(library.root)
    assert "test-oak-door.json" in str(refused.value) and "licence" in str(refused.value)


def test_add_never_executes_or_trusts_a_download_it_reads_it_only_as_audio(tmp_path: Path, downloads: Path) -> None:
    lib = SoundLibrary(tmp_path / "sounds", [])
    downloads.mkdir(parents=True)
    (downloads / "evil.flac").write_text("#!/bin/sh\necho not audio\n")
    with pytest.raises(SoundRefusal, match="does not decode as audio"):
        lib.add(downloads / "evil.flac", record("test-evil"))
    with pytest.raises(SoundRefusal, match="only"):
        lib.add(write(downloads / "a.flac", tone(1, 300)).rename(downloads / "a.sh"), record("test-sh"))


def test_the_record_keeps_provenance_and_the_file_is_copied_unchanged(library: SoundLibrary, downloads: Path) -> None:
    door = library.get("test-oak-door")
    assert door is not None
    assert door.provenance()["source_url"] == "https://example.org/sounds/test-oak-door" and door.licence == "CC0-1.0"
    assert door.path.read_bytes() == (downloads / "door.flac").read_bytes()
    assert (library.root / ".gitignore").read_text().strip().endswith("*")


# --- matching: deterministic and explainable -----------------------------------------------------------------


def test_stems_are_consistent_between_descriptions_and_tags() -> None:
    assert stem("clinking") == stem("clink") == stem("clinks")
    assert stem("ticking") == stem("tick") and stem("glasses") == stem("glass") and stem("dripping") == stem("drip")
    assert "sound" not in {w for w in terms("the sound of a door")}


def test_a_description_matches_by_subject_and_tags_and_the_kind_decides(library: SoundLibrary) -> None:
    best = library.best("SFX", "A heavy oak door opens and closes", "seed")
    assert best is not None and best.sound.id == "test-oak-door" and best.subjects == ("door",)
    assert set(best.tags) == {stem(w) for w in ("heavy", "oak", "open", "close")}
    assert library.best("BED", "A heavy oak door opens and closes", "seed") is None  # the door is not a bed
    assert library.best("SFX", "A heavy breeze", "seed") is None  # a tag alone is never a match
    assert library.best("BED", "Porch ambience, a light breeze", "seed").sound.id == "test-porch-evening"  # type: ignore[union-attr]


def test_a_tie_is_broken_by_the_cue_seed_and_never_by_file_order(library: SoundLibrary) -> None:
    picks = {library.best("SFX", "Glasses clinking", seed).sound.id for seed in ("a", "b", "c", "d", "e", "f", "g", "h")}  # type: ignore[union-attr]
    assert picks == {"test-glass-clink", "test-glass-cheers"}
    again = SoundLibrary(library.root, list(reversed(SoundLibrary.load(library.root).sounds)))
    for seed in ("a", "b", "c"):
        assert again.best("SFX", "Glasses clinking", seed).sound.id == library.best("SFX", "Glasses clinking", seed).sound.id  # type: ignore[union-attr]


# --- AC2: a cue is built from its recording, else generated, and says which --------------------------------


class Counting(BedCues):
    def __init__(self) -> None:
        self.made: list[tuple[str, str]] = []

    def generate(self, kind: str, desc: str, seed: int) -> np.ndarray:
        self.made.append((kind, desc))
        return super().generate(kind, desc, seed)


def test_a_matched_cue_is_built_from_the_recording_and_an_unmatched_one_is_generated(cues_dir: Path, library: SoundLibrary) -> None:
    gen = Counting()
    cues = CueLibrary(cues_dir, lambda kind: gen, library)
    door = cues.ensure("SFX", "A heavy oak door opens and closes")
    assert door.sound == "test-oak-door" and door.generator == "sound-library" and gen.made == []
    assert door.key == cue_key("SFX", "A heavy oak door opens and closes", "test-oak-door") != cue_key("SFX", "A heavy oak door opens and closes")
    side = cues.sidecar(door.key)
    assert side["sound"]["source_url"] == "https://example.org/sounds/test-oak-door" and side["sound"]["licence"] == "CC0-1.0"
    assert side["match"]["subjects"] == ["door"] and side["match"]["chosen"] is False
    assert side["loudness"]["lufs"] < 0 and side["excerpt"][0] >= 0
    odd = cues.ensure("SFX", "A theremin warbles")
    assert odd.sound is None and odd.generator == BedCues.id and gen.made == [("SFX", "A theremin warbles")]
    assert odd.key == cue_key("SFX", "A theremin warbles")
    # the same description is the same asset on the next ask: nothing is made twice
    assert cues.ensure("SFX", "A heavy oak door opens and closes").generated is False


def test_a_swap_picks_another_match_as_a_new_asset_and_records_the_choice(cues_dir: Path, library: SoundLibrary) -> None:
    cues = CueLibrary(cues_dir, lambda kind: BedCues(), library)
    first = cues.ensure("SFX", "Glasses clinking")
    alternatives = cues.sidecar(first.key)["match"]["alternatives"]
    assert len(alternatives) == 1
    swapped = cues.ensure("SFX", "Glasses clinking", sound=alternatives[0])
    assert swapped.sound == alternatives[0] and swapped.key != first.key and first.path.is_file()
    assert cues.sidecar(swapped.key)["match"]["chosen"] is True


def test_a_long_sfx_recording_is_cut_short_where_it_is_quiet(cues_dir: Path, tmp_path: Path, downloads: Path) -> None:
    lib = SoundLibrary(tmp_path / "sounds", [])
    long = np.concatenate([tone(1.0, 300), np.zeros(RATE // 2, np.float32)] * 12)  # 18 s of knocks
    lib.add(write(downloads / "knocks.flac", long), record("test-knocks", subjects=["knock"]))
    asset = CueLibrary(cues_dir, lambda kind: BedCues(), lib).ensure("SFX", "A knock at the door")
    assert 2.5 <= asset.seconds <= 5.0


def test_the_mix_reports_every_cues_source(work: Path, cues_dir: Path, library: SoundLibrary) -> None:
    from pablo_casting.mix import MixRequest, Seams, mix
    from test_mix import fake_encoder

    episode(work, [cue("BED", "Porch ambience, a light breeze", -1), cue("SFX", "A heavy oak door opens and closes", 2), cue("SFX", "A theremin warbles", 4)])
    body, code = mix(MixRequest(work=work, episode=1, cues_dir=cues_dir), Seams(generators=lambda kind: BedCues(), pacer=fake_pacer, encoder=fake_encoder, sounds=library))
    assert code == 0, body
    sources = {entry["desc"]: entry for entry in body["cueSources"]}  # type: ignore[union-attr]
    assert sources["Porch ambience, a light breeze"]["sound"]["id"] == "test-porch-evening"
    assert sources["A heavy oak door opens and closes"]["sound"]["licence"] == "CC0-1.0"
    assert sources["A theremin warbles"]["generator"] == BedCues.id and "sound" not in sources["A theremin warbles"]


# --- AC3: a rhythmic bed loops at its period ----------------------------------------------------------------


def test_the_regularised_loop_puts_every_tick_on_the_grid() -> None:
    audio, _ = clock(rate=CUE_RATE)
    assert tick_jitter(audio, CUE_RATE)["max_ms"] > 10  # the control: the recording itself wobbles
    regular, loop = rhythm_loop(audio, CUE_RATE)  # type: ignore[misc]
    assert loop.cycles == 1 and loop.ticks >= 15 and loop.start >= loop.xfade
    looped = np.concatenate([regular[loop.start : loop.start + loop.length]] * 5)
    measured = tick_jitter(looped, CUE_RATE)
    assert measured["max_ms"] < 1.0 and measured["cycle_ms"] == pytest.approx(900, abs=15)


def test_a_tick_tock_out_of_beat_keeps_its_two_intervals() -> None:
    rng = np.random.default_rng(1)
    audio = (rng.standard_normal(20 * CUE_RATE) * 0.002).astype(np.float32)
    at, k = int(0.3 * CUE_RATE), 0
    while at + 600 < len(audio):
        audio[at : at + 200] += 0.5
        at += int(((0.8 if k % 2 == 0 else 1.3) + rng.uniform(-0.02, 0.02)) * CUE_RATE)
        k += 1
    regular, loop = rhythm_loop(audio, CUE_RATE)  # type: ignore[misc]
    assert loop.cycles == 2 and sorted(round(p / CUE_RATE, 1) for p in loop.periods) == [0.8, 1.3]
    looped = np.concatenate([regular[loop.start : loop.start + loop.length]] * 4)
    assert tick_jitter(looped, CUE_RATE, cycles=2)["max_ms"] < 1.0


def test_no_steady_tick_is_no_loop() -> None:
    noise = (np.random.default_rng(2).standard_normal(10 * CUE_RATE) * 0.1).astype(np.float32)
    assert rhythm_loop(noise, CUE_RATE) is None


def test_a_loop_plan_lays_the_loop_back_to_back_on_its_period() -> None:
    plan = LoopPlan(1000, 40_000, 800)
    segments = plan.upto(200_000)
    assert segments[0] == (0, 1000, 40_000)
    for k, (start, source_in, length) in enumerate(segments[1:], start=1):
        assert (start, source_in, length) == (k * 40_000 - 800, 200, 40_800)
        assert start + (1000 - source_in) == k * 40_000  # the loop's own start lands on the period
    assert plan.upto(50_000) == segments[:2]


def clock_episode(work: Path, cues_dir: Path, library: SoundLibrary) -> tuple[dict[str, object], Sources, Timeline]:
    manifest = episode(work, [cue("BED", "Ticking of a heavy grandfather clock, the rustle of parchment", -1)])
    sources = Sources(work, CueLibrary(cues_dir, lambda kind: BedCues(), library), fake_pacer)
    return manifest, sources, auto_timeline(manifest, sources)


def test_the_clock_bed_ticks_on_its_period_across_the_whole_bed(work: Path, cues_dir: Path, library: SoundLibrary) -> None:
    manifest, sources, timeline = clock_episode(work, cues_dir, library)
    audio, placed = beds_only(manifest, timeline.document(), sources)
    start, end = float(placed[0]["start"]), float(placed[0]["end"])  # type: ignore[arg-type]
    assert end - start > 120
    body = audio[int((start + 2) * SR) : int((end - 2) * SR)]
    measured = tick_jitter(body, SR)
    assert measured["ticks"] > 120 and measured["max_ms"] < 5.0  # AC3
    # the bed is the loop again and again, never BedPlan's varied segments
    beds = [clip for track, _, _, clip in clips(timeline.document()) if track == "beds"]
    assert len({(clip["in"], round(float(clip["out"]) - float(clip["in"]), 6)) for clip in beds[1:-1]}) == 1
    assert library.get("test-clock").rhythmic  # type: ignore[union-attr]


def test_a_non_rhythmic_bed_keeps_its_varied_segments(work: Path, cues_dir: Path, library: SoundLibrary) -> None:
    manifest = episode(work, [cue("BED", "Porch ambience, a light breeze", -1)])
    sources = Sources(work, CueLibrary(cues_dir, lambda kind: BedCues(), library), fake_pacer)
    timeline = auto_timeline(manifest, sources)
    beds = [clip for track, _, _, clip in clips(timeline.document()) if track == "beds"]
    assert len({round(float(clip["out"]) - float(clip["in"]), 3) for clip in beds}) > 3
    asset = sources.library.ensure("BED", "Porch ambience, a light breeze")
    assert asset.loop is None


def test_a_streamed_clock_bed_equals_the_document_render(work: Path, cues_dir: Path, library: SoundLibrary) -> None:
    manifest = episode(work, [cue("BED", "Ticking of a heavy grandfather clock", -1), cue("MUSIC", "Organ swell", 6), cue("MUSIC", "Closing theme", 13)])
    sources = Sources(work, CueLibrary(cues_dir, lambda kind: BedCues(), library), fake_pacer)
    timeline = Timeline(work, manifest["cues"], sources.library, fake_pacer, sources=sources, manifest_version=1)  # type: ignore[arg-type]
    pieces: list[np.ndarray] = []
    emitted = 0
    for group in _group_lines(_lines(manifest)):
        timeline.add(group)
        frontier = timeline.frontier()
        if frontier > emitted:
            pieces.append(timeline.mixdown(emitted, frontier))
            emitted = frontier
    total = timeline.finish()
    pieces.append(timeline.mixdown(emitted, total))
    streamed = np.concatenate(pieces)
    rendered = render_document(manifest, timeline.document(), sources)
    assert len(streamed) == len(rendered.audio) and len(pieces) > 5
    gain = float(np.dot(rendered.audio, streamed) / np.dot(streamed, streamed))
    assert float(np.abs(rendered.audio - gain * streamed).max()) < 1e-5


# --- AC4 (AGT-1786): every cue at its kind's loudness before its gain ------------------------------------------


def test_integrated_loudness_follows_bs1770() -> None:
    t = np.arange(5 * 48_000) / 48_000
    assert integrated_lufs(np.sin(2 * np.pi * 997 * t), 48_000) == pytest.approx(-3.01, abs=0.02)
    t44 = np.arange(5 * 44_100) / 44_100
    assert integrated_lufs(0.1 * np.sin(2 * np.pi * 997 * t44), 44_100) == pytest.approx(-23.01, abs=0.05)
    assert integrated_lufs(np.zeros(48_000), 48_000) == float("-inf")


def test_normalisation_is_capped_under_the_peak_ceiling() -> None:
    plain = normalisation(-30.0, 0.1, -24.0)
    assert plain.gain_db == pytest.approx(6.0) and not plain.limited
    capped = normalisation(-40.0, 0.5, -24.0)
    assert capped.limited and 0.5 * 10 ** (capped.gain_db / 20) == pytest.approx(PEAK_CEILING, rel=1e-4)
    assert normalisation(float("-inf"), 0.0, -24.0).gain_db == 0.0


def test_every_cue_is_loaded_at_its_kinds_target_and_a_legacy_sidecar_learns_its_loudness(cues_dir: Path, library: SoundLibrary) -> None:
    cues = CueLibrary(cues_dir, lambda kind: BedCues(), library, targets_from({"SFX": -26.0}))
    assert cues.targets == {**DEFAULT_TARGETS, "SFX": -26.0}
    door = cues.ensure("SFX", "A heavy oak door opens and closes")
    assert integrated_lufs(cues.load(door), CUE_RATE) == pytest.approx(-26.0, abs=0.3)
    hot = cues.ensure("SFX", "A theremin warbles")  # generated: 0.5 s at half scale, far hotter than -26
    legacy = cues.sidecar(hot.key)
    del legacy["loudness"]
    (cues_dir / f"{hot.key}.json").write_text(json.dumps(legacy))
    before = hot.path.read_bytes()
    assert integrated_lufs(cues.load(hot), CUE_RATE) == pytest.approx(-26.0, abs=0.3)
    assert "loudness" in cues.sidecar(hot.key) and hot.path.read_bytes() == before  # cached in the sidecar; the WAV untouched


def test_the_config_names_the_library_and_the_targets(tmp_path: Path, library: SoundLibrary) -> None:
    from pablo_casting.config import ConfigRefusal, load_config

    home = tmp_path / "xdg"
    (home / "pablo").mkdir(parents=True)
    (home / "pablo" / "casting.json").write_text(json.dumps({"sounds": str(library.root), "loudness": {"BED": -34}}))
    config = load_config({"XDG_CONFIG_HOME": str(home)})
    assert config.sounds == str(library.root) and config.loudness == {"BED": -34.0}
    (home / "pablo" / "casting.json").write_text(json.dumps({"loudness": {"BED": 5}}))
    with pytest.raises(ConfigRefusal):
        load_config({"XDG_CONFIG_HOME": str(home)})


# --- the command line ---------------------------------------------------------------------------------------


def test_sounds_commands_list_check_match_and_add(tmp_path: Path, library: SoundLibrary, downloads: Path) -> None:
    env = {"XDG_CONFIG_HOME": str(tmp_path / "none"), "HOME": str(tmp_path)}
    root = str(library.root)
    (body, code), _ = run(["sounds", "check", "--sounds", root, "--json"], env)
    assert code == 0 and body["count"] == 5
    (body, code), _ = run(["sounds", "match", "--kind", "SFX", "--describe", "A heavy oak door opens and closes", "--sounds", root, "--json"], env)
    assert code == 0 and body["matches"][0]["id"] == "test-oak-door"  # type: ignore[index]
    (tmp_path / "rec.json").write_text(json.dumps(record("test-chair", subjects=["chair"], licence="CC-BY-3.0")))
    (body, code), _ = run(["sounds", "add", str(write(downloads / "chair.flac", tone(1, 220))), "--from", str(tmp_path / "rec.json"), "--sounds", root, "--json"], env)
    assert code == 2 and "licence" in str(body["message"])
    (tmp_path / "rec.json").write_text(json.dumps(record("test-chair", subjects=["chair"])))
    (body, code), _ = run(["sounds", "add", str(downloads / "chair.flac"), "--from", str(tmp_path / "rec.json"), "--sounds", root, "--json"], env)
    assert code == 0 and body["sound"]["id"] == "test-chair"  # type: ignore[index]
    (body, code), _ = run(["sounds", "list", "--sounds", root, "--json"], env)
    assert code == 0 and len(body["sounds"]) == 6  # type: ignore[arg-type]
    (body, code), _ = run(["sounds", "list", "--sounds", str(tmp_path / "missing"), "--json"], env)
    assert code == 2
