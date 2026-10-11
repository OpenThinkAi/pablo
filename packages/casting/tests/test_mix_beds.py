"""The auto mix's bed rules (AGT-1767): beds that never repeat on a period, go out under music, end at the closing theme. Model-free.

Every line, cue and voice here is invented. The fake bed is a 20 s clip of quiet
noise with one loud 1 kHz "clink" at 7 s, so an audible repeat of the asset is
one the envelope can find.
"""

from __future__ import annotations

import copy
from pathlib import Path

import numpy as np
import pytest

from test_mix import ENGINE, ToneEngine, fake_pacer, tree, work, cues_dir  # noqa: F401 (fixtures)

from pablo_casting.cues import CUE_RATE, CueLibrary
from pablo_casting.manifest import read_version, write_version
from pablo_casting.mix import SR, BedPlan, Sources, Timeline, _group_lines, _lines, auto_document, auto_timeline, render_document
from pablo_casting.mixdoc import check_against, clips, validate
from pablo_casting.takes import Direction, Line, TakeInputs, record_take

BED_SECONDS = 20.0
CLINK_AT = 7.0
LINES = 15
WORDS = 25  # 0.1 + 0.4 * 25 + 0.18 = 10.28 s a line


class BedCues:
    """A 20 s bed with one clink at 7 s; 3 s music; 0.5 s everything else. Deterministic."""

    id = "bed-cues/1"

    def generate(self, kind: str, desc: str, seed: int) -> np.ndarray:
        if kind == "BED":
            n = int(BED_SECONDS * CUE_RATE)
            audio = (np.random.default_rng(seed).standard_normal(n) * 0.01).astype(np.float32)
            at = int(CLINK_AT * CUE_RATE)
            burst = int(0.15 * CUE_RATE)
            audio[at : at + burst] += (0.8 * np.sin(2 * np.pi * 1000 * np.arange(burst) / CUE_RATE)).astype(np.float32)
            return audio
        seconds = 3.0 if kind == "MUSIC" else 0.5
        t = np.arange(int(seconds * CUE_RATE)) / CUE_RATE
        return (0.5 * np.sin(2 * np.pi * (300 + seed % 400) * t)).astype(np.float32)


def cue(kind: str, desc: str, after: int) -> dict[str, object]:
    return {"kind": kind, "desc": desc, "after": after, "line": 100 + after}


def episode(work: Path, cues: list[dict[str, object]]) -> dict[str, object]:
    lines = []
    for i in range(LINES):
        text = " ".join(f"w{i}x{j}" for j in range(WORDS))
        take, _ = record_take(work, ToneEngine(), TakeInputs(engine=ENGINE, voice="card-x", lines=(Line("MAVIS", text),), seed=40 + i, direction=Direction()))
        lines.append({"i": i, "speaker": "MAVIS", "text": text, "take": take.key, "stretch": 1.0})
    proposal = {
        "script_sha256": "s" * 64,
        "cast_hash": "c" * 64,
        "engine": {"id": ENGINE.id, "weights_sha256": ENGINE.weights_sha256},
        "pace_policy": {"stretch_range": [0.75, 1.05]},
        "lines": lines,
        "cues": cues,
        "duration": 9.0,
        "rtf_total": 1.0,
    }
    return write_version(work, 1, proposal).manifest  # type: ignore[arg-type]


def sources_for(work: Path, cues_dir: Path) -> Sources:
    return Sources(work, CueLibrary(cues_dir, lambda kind: BedCues()), fake_pacer)


def built(work: Path, cues_dir: Path, cues: list[dict[str, object]]) -> tuple[dict[str, object], Sources, Timeline]:
    manifest = episode(work, cues)
    sources = sources_for(work, cues_dir)
    return manifest, sources, auto_timeline(manifest, sources)


def beds_only(manifest: dict[str, object], doc: dict[str, object], sources: Sources) -> tuple[np.ndarray, list[dict[str, object]]]:
    """The document with every track but the beds muted: the rendered bed, and where each cue landed."""
    solo = copy.deepcopy(doc)
    for name, track in solo["tracks"].items():  # type: ignore[union-attr]
        track["mute"] = name != "beds"
    rendered = render_document(manifest, solo, sources)
    return rendered.audio, rendered.cues


def rms_between(audio: np.ndarray, start: float, end: float) -> float:
    chunk = audio[int(start * SR) : int(end * SR)]
    return float(np.sqrt(np.mean(chunk**2))) if len(chunk) else 0.0


def level(audio: np.ndarray, start: float, end: float) -> float:
    """The bed's steady level over a window: the median of its half-second RMS values (a clink is the odd one out)."""
    return float(np.median([rms_between(audio, t, t + 0.5) for t in np.arange(start, end - 0.5, 0.5)]))


# --- (a) a bed is segments at varied offsets, never a fixed period --------------------------------


def clink_times(plan: BedPlan, span: int) -> list[float]:
    """When the asset's clink sounds in a bed of `span` samples: once per segment that contains it."""
    at = int(CLINK_AT * SR)
    return [(start + at - source_in) / SR for start, source_in, length in plan.upto(span) if source_in <= at < source_in + length]


def test_a_bed_plan_is_deterministic_by_key_and_independent_of_how_far_it_runs() -> None:
    size = int(BED_SECONDS * SR)
    a, b, other = BedPlan("key-a", size), BedPlan("key-a", size), BedPlan("key-b", size)
    short = list(a.upto(30 * SR))
    long = b.upto(300 * SR)
    assert long[: len(short)] == short and len(long) > len(short)
    assert other.upto(300 * SR) != long
    # every segment is inside the asset, 40-80% of it, and overlaps the next by the crossfade
    for (start, source_in, length), (next_start, _, _) in zip(long, long[1:]):
        assert 0 <= source_in and source_in + length <= size and 0.4 * size <= length <= 0.8 * size
        assert next_start == start + length - a.xfade
    assert a.xfade == int(1.5 * SR)


def test_the_clink_never_comes_back_on_the_assets_period() -> None:
    plan = BedPlan("78f40e32e840cf6af688f76a89e7b4f66201409ac4bfb18a48f606b1ceb7944d", int(BED_SECONDS * SR))
    times = clink_times(plan, 400 * SR)
    gaps = np.diff(times)
    assert len(times) > 15
    assert np.ptp(gaps) > 2.0 and not np.any(np.abs(gaps - BED_SECONDS) < 0.5)
    # a tiled loop is the control: the same count of clinks on a rigid 20 s period
    tiled = np.arange(len(times)) * BED_SECONDS
    assert np.ptp(np.diff(tiled)) == 0


def envelope(audio: np.ndarray, rate: int = 100) -> np.ndarray:
    hop = SR // rate
    frames = len(audio) // hop
    return np.abs(audio[: frames * hop]).reshape(frames, hop).max(axis=1)


def autocorrelation_near(env: np.ndarray, lag_s: float, rate: int = 100, width_s: float = 0.2) -> float:
    """The largest normalised autocorrelation within `width_s` of `lag_s`."""
    x = env - env.mean()
    full = np.correlate(x, x, mode="full")[len(x) - 1 :]
    full = full / full[0]
    lo, hi = int((lag_s - width_s) * rate), int((lag_s + width_s) * rate) + 1
    return float(full[lo:hi].max())


def test_the_rendered_porch_bed_has_no_autocorrelation_peak_at_the_assets_length(work: Path, cues_dir: Path) -> None:
    manifest, sources, timeline = built(work, cues_dir, [cue("BED", "Porch ambience, the clink of glassware", -1)])
    audio, _ = beds_only(manifest, timeline.document(), sources)
    assert len(audio) / SR > 150
    env = envelope(audio)
    # the control: the same bed as one asset tiled back to back repeats on its length
    asset = BedCues().generate("BED", "x", 3)
    tiled = np.tile(asset, int(len(audio) / len(asset)) + 1)[: len(audio)]
    assert autocorrelation_near(envelope(tiled), BED_SECONDS) > 0.8
    assert autocorrelation_near(env, BED_SECONDS) < 0.35
    assert autocorrelation_near(env, 2 * BED_SECONDS) < 0.35


def test_a_bed_is_ordinary_editable_clips_crossfading_on_one_lane(work: Path, cues_dir: Path) -> None:
    manifest, sources, timeline = built(work, cues_dir, [cue("BED", "Porch ambience, the clink of glassware", -1)])
    doc = {"schema": 1, "episode": 1, "version": 1, "parent": None, "by": "auto", **timeline.document()}
    assert validate(doc) == [] and check_against(doc, manifest) == []
    segments = [c for track, lane, k, c in clips(doc) if track == "beds"]
    assert len(segments) > 8 and {c["cue"] for c in segments} == {0}
    offsets = {round(c["in"], 3) for c in segments}
    assert len(offsets) > len(segments) // 2  # varied source offsets
    # the same input makes the same document
    again = auto_document(manifest, sources_for(work, cues_dir))
    assert again == timeline.document()


# --- (b) beds go out under music and come back --------------------------------------------------------


MIDDLE = [
    cue("MUSIC", "Theme opens", -1),
    cue("BED", "Porch ambience, the clink of glassware", 1),
    cue("MUSIC", "Organ swell", 5),
    cue("MUSIC", "Closing theme", 13),
]


def test_there_is_no_bed_energy_under_any_music_span(work: Path, cues_dir: Path) -> None:
    manifest, sources, timeline = built(work, cues_dir, MIDDLE)
    audio, places = beds_only(manifest, timeline.document(), sources)
    music = [p for p in places if p["kind"] == "MUSIC"]
    assert len(music) == 3
    typical = level(audio, places[1]["start"] + 3, places[2]["start"] - 1)  # type: ignore[operator]
    assert typical > 0.01
    for span in music:
        assert rms_between(audio, span["start"], span["end"]) < typical * 1e-3, span  # type: ignore[arg-type]
    # the bed is back after the swell (within the way back), and was there just before it
    swell = music[1]
    assert level(audio, swell["start"] - 8, swell["start"] - 1) > typical * 0.5  # type: ignore[operator]
    assert level(audio, swell["end"] + 1.0, swell["end"] + 8) > typical * 0.5  # type: ignore[operator]


def test_the_automation_is_out_before_the_music_and_back_after_it(work: Path, cues_dir: Path) -> None:
    manifest, sources, timeline = built(work, cues_dir, MIDDLE)
    points = timeline.document()["tracks"]["beds"]["automation"]  # type: ignore[index]
    assert [p["db"] for p in points] == [0.0, -96.0, -96.0, 0.0]
    times = [timeline._when(p["anchor"]) / SR for p in points]
    music = timeline.document()["tracks"]["music"]["lanes"]["main"]["clips"][1]  # type: ignore[index]
    start = timeline._when(music["anchor"]) / SR
    assert times[1] == pytest.approx(start, abs=1e-4) and times[0] == pytest.approx(start - 0.5, abs=1e-4)
    assert times[2] == pytest.approx(start + 3.0, abs=1e-4) and times[3] == pytest.approx(start + 3.5, abs=1e-4)


def test_a_new_bed_starting_at_the_music_is_not_held_down(work: Path, cues_dir: Path) -> None:
    cues = [cue("BED", "Porch ambience, the clink of glassware", 1), cue("MUSIC", "Organ swell", 5), cue("BED", "Cavern echo, dripping water", 5), cue("MUSIC", "Closing theme", 13)]
    manifest, sources, timeline = built(work, cues_dir, cues)
    doc = timeline.document()
    points = doc["tracks"]["beds"]["automation"]  # type: ignore[index]
    new_bed = [c for c in doc["tracks"]["beds"]["lanes"]["main"]["clips"] if c["cue"] == 2][0]  # type: ignore[index]
    begins = timeline._when(new_bed["anchor"])
    # the way back is over by the time the new bed starts, so its own fade-in is the whole fade
    assert timeline._when(points[-1]["anchor"]) <= begins and points[-1]["db"] == 0.0
    audio, _ = beds_only(manifest, doc, sources)
    assert level(audio, begins / SR + 1.6, begins / SR + 8) > 0.01


def test_two_music_cues_close_together_stay_down_between_them(work: Path, cues_dir: Path) -> None:
    cues = [cue("BED", "Porch ambience, the clink of glassware", 1), cue("MUSIC", "A sting", 5), cue("MUSIC", "A second sting", 5), cue("MUSIC", "Closing theme", 13)]
    manifest, sources, timeline = built(work, cues_dir, cues)
    points = timeline.document()["tracks"]["beds"]["automation"]  # type: ignore[index]
    assert [p["db"] for p in points] == [0.0, -96.0, -96.0, -96.0, -96.0, 0.0]  # one dip, not two
    times = [timeline._when(p["anchor"]) for p in points]
    assert times == sorted(times)


# --- (c) the closing theme ends every bed -------------------------------------------------------------


def test_the_last_music_cue_ends_every_bed_and_none_starts_after_it(work: Path, cues_dir: Path) -> None:
    cues = MIDDLE[:3] + [cue("MUSIC", "Closing theme", 13), cue("BED", "A clock ticking", 13)]
    manifest, sources, timeline = built(work, cues_dir, cues)
    doc = timeline.document()
    theme = [c for c in doc["tracks"]["music"]["lanes"]["main"]["clips"] if c["cue"] == 3][0]  # type: ignore[index]
    begins = timeline._when(theme["anchor"])
    beds = doc["tracks"]["beds"]["lanes"]["main"]["clips"]  # type: ignore[index]
    assert all(c["cue"] != 4 for c in beds)
    ends = max(timeline._when(c["anchor"]) + int(round((c["out"] - c["in"]) * SR)) for c in beds)
    assert ends <= begins
    audio, places = beds_only(manifest, doc, sources)
    assert rms_between(audio, begins / SR, len(audio) / SR) < 1e-3
    assert level(audio, begins / SR - 8, begins / SR - 2) > 0.01
    assert places[4]["asset"] is None  # the bed after the theme never sounded


def test_a_bed_cued_after_the_last_music_keeps_going(work: Path, cues_dir: Path) -> None:
    """A mid-show sting is not a closing theme when a bed is cued after it."""
    cues = [cue("MUSIC", "A sting", 3), cue("BED", "Porch ambience, the clink of glassware", 5)]
    manifest, sources, timeline = built(work, cues_dir, cues)
    assert timeline.closing is None
    assert any(track == "beds" for track, lane, k, c in clips({"tracks": timeline.document()["tracks"]}))


def test_an_opening_theme_alone_is_not_a_closing_theme(work: Path, cues_dir: Path) -> None:
    cues = [cue("MUSIC", "Theme opens", -1), cue("BED", "Porch ambience, the clink of glassware", 0)]
    manifest, sources, timeline = built(work, cues_dir, cues)
    assert timeline.closing is None
    audio, _ = beds_only(manifest, timeline.document(), sources)
    assert level(audio, 40, 60) > 0.01


# --- streaming parity: samples already cut never change --------------------------------------------------


def test_the_streamed_mixdown_with_ducks_and_a_closing_theme_equals_the_document_render(work: Path, cues_dir: Path) -> None:
    cues = [
        cue("MUSIC", "Theme opens", -1),
        cue("BED", "Porch ambience, the clink of glassware", 1),
        cue("MUSIC", "Organ swell", 5),
        cue("BED", "Cavern echo, dripping water", 5),
        cue("MUSIC", "A sting", 8),
        cue("SFX", "A door", 9),
        cue("MUSIC", "Closing theme", 13),
    ]
    manifest = episode(work, cues)
    sources = sources_for(work, cues_dir)
    timeline = Timeline(work, manifest["cues"], sources.library, fake_pacer, sources=sources, manifest_version=1)  # type: ignore[arg-type]
    pieces: list[np.ndarray] = []
    emitted = 0
    seen: list[tuple[int, int]] = []
    for group in _group_lines(_lines(manifest)):
        timeline.add(group)
        frontier = timeline.frontier()
        if frontier > emitted:
            pieces.append(timeline.mixdown(emitted, frontier))
            seen.append((emitted, frontier))
            emitted = frontier
    total = timeline.finish()
    pieces.append(timeline.mixdown(emitted, total))
    streamed = np.concatenate(pieces)
    rendered = render_document(manifest, timeline.document(), sources)
    assert len(streamed) == len(rendered.audio) and len(seen) > 5
    gain = float(np.dot(rendered.audio, streamed) / np.dot(streamed, streamed))
    assert float(np.abs(rendered.audio - gain * streamed).max()) < 1e-5
