"""How a take ends: the finishing cut, room tone and the clipping detector (AGT-1789), on synthetic signals."""

from __future__ import annotations

import numpy as np
import pytest

from pablo_casting.ending import (
    CLIP_END_DB,
    DEFAULT_AIR,
    finish,
    last_word_end,
    levels,
    measure_ending,
    voice_end,
    zero_run,
)
from pablo_casting.perform import finish_take

RATE = 24_000


def voice(seconds: float, level: float = 0.2, f0: float = 140.0) -> np.ndarray:
    """A steady voiced vowel: a few harmonics of f0 at a fixed amplitude."""
    t = np.arange(int(seconds * RATE)) / RATE
    wave = sum(np.sin(2 * np.pi * f0 * k * t) / k for k in range(1, 6))
    return (level * wave / np.max(np.abs(wave))).astype(np.float32)


def decay(seconds: float, level: float = 0.2, drop_db: float = 50.0) -> np.ndarray:
    """The voice dying away by `drop_db` over `seconds` (a natural ending)."""
    tone = voice(seconds, level)
    gain = 10 ** (-drop_db * np.linspace(0, 1, len(tone)) / 20)
    return (tone * gain).astype(np.float32)


def floor(seconds: float, dbfs: float = -75.0, seed: int = 1) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return (rng.standard_normal(int(seconds * RATE)) * 10 ** (dbfs / 20)).astype(np.float32)


def zeros(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * RATE), dtype=np.float32)


def take(*parts: np.ndarray) -> np.ndarray:
    return np.concatenate(parts).astype(np.float32)


def level_at(samples: np.ndarray, start: float, end: float) -> float:
    """dB of the RMS between two times, relative to the take's speech level."""
    lv = levels(samples, RATE)
    assert lv is not None
    a, b = int(start * RATE), int(end * RATE)
    rms = float(np.sqrt(np.mean(samples[a:b].astype(np.float64) ** 2)) + 1e-12)
    return 20 * np.log10(rms) - lv.speech_dbfs


# --- the voice end ---------------------------------------------------------------------


def test_the_voice_end_is_where_the_sound_stops_not_where_whisper_says_the_word_ends() -> None:
    samples = take(floor(0.3), voice(1.2), decay(0.12), floor(0.6))
    # Whisper put the word end 250 ms early; the voice (and its decay above -40 dB) runs to about 1.6 s.
    assert voice_end(samples, RATE, anchor=1.25) == pytest.approx(1.6, abs=0.03)


def test_a_later_throwaway_word_is_not_part_of_the_line() -> None:
    samples = take(floor(0.2), voice(1.0), decay(0.1), floor(0.4), voice(0.3), floor(0.3))
    assert voice_end(samples, RATE, anchor=1.1) == pytest.approx(1.3, abs=0.05)
    assert voice_end(samples, RATE) == pytest.approx(2.0, abs=0.05)  # no anchor: the last voice in the take


def test_silence_has_no_voice_end() -> None:
    assert voice_end(zeros(1.0), RATE) is None


# --- finishing ---------------------------------------------------------------------------


def test_finish_never_cuts_before_the_voice_or_the_word_and_fades_only_inside_the_air() -> None:
    samples = take(floor(0.3), voice(1.2), decay(0.12), floor(0.8))
    out, info = finish(samples, RATE, word_end=1.25)
    assert info["voice_end"] == pytest.approx(1.6, abs=0.03)
    assert info["cut"] == pytest.approx(float(info["voice_end"]) + DEFAULT_AIR, abs=0.011)  # type: ignore[arg-type]
    # Everything up to the voice end is the engine's audio, untouched by the fade.
    v = int(float(info["voice_end"]) * RATE)  # type: ignore[arg-type]
    assert np.array_equal(out[:v], samples[:v])
    assert info["fade"] <= DEFAULT_AIR / 2 + 1e-9  # type: ignore[operator]
    assert abs(float(out[-1])) < 1e-4


def test_a_word_end_later_than_the_voice_end_holds_the_cut_back() -> None:
    samples = take(floor(0.3), voice(1.0), floor(1.0))
    _, info = finish(samples, RATE, word_end=1.6)
    assert info["cut"] == pytest.approx(1.6 + DEFAULT_AIR, abs=0.011)


def test_the_air_is_configurable() -> None:
    samples = take(floor(0.3), voice(1.0), floor(1.0))
    _, info = finish(samples, RATE, word_end=1.3, air=0.15)
    assert info["cut"] == pytest.approx(1.3 + 0.15, abs=0.011)


def test_a_hard_gate_is_replaced_by_room_tone_and_a_gentle_fade() -> None:
    # Turbo-like: voice, a quick fall, then digital zero 120 ms after the word and one click at the end.
    click = np.full(10, 0.002, dtype=np.float32)
    samples = take(floor(0.3, -70.0), voice(1.0), decay(0.08), floor(0.04, -70.0), zeros(0.12), click)
    out, info = finish(samples, RATE, word_end=1.3)
    assert info["hard_gate"] is True
    assert info["room_tone"] > 0.05  # type: ignore[operator]
    gate = int(float(info["voice_end"]) * RATE)  # type: ignore[arg-type]
    after = out[gate : len(out) - int(float(info["fade"]) * RATE)]  # type: ignore[arg-type]
    assert zero_run(after, RATE, 0) is None  # no digital zero left inside the air, before the fade
    assert np.max(np.abs(out[-20:])) < np.max(np.abs(out[gate : gate + 400]))  # it fades
    assert not np.any(out[-10:] == 0.002)  # the click is gone


def test_audio_that_ends_before_the_cut_is_padded_with_room_tone() -> None:
    samples = take(floor(0.3, -70.0), voice(1.0), decay(0.1))
    out, info = finish(samples, RATE, word_end=1.35)
    assert info["cut"] == pytest.approx(1.4 + DEFAULT_AIR, abs=0.02)
    assert len(out) / RATE == pytest.approx(info["cut"], abs=1e-3)
    assert info["room_tone"] > 0.1  # type: ignore[operator]
    # The room tone sits at the take's floor, far below the voice.
    assert level_at(out, 1.45, 1.5) < -40


def test_a_silent_take_is_left_as_it_is() -> None:
    out, info = finish(zeros(1.0), RATE, word_end=None)
    assert len(out) == RATE and info["cut"] is None


# --- the clipping detector ------------------------------------------------------------------


def test_a_natural_ending_is_not_clipped() -> None:
    samples = take(floor(0.3), voice(1.0), decay(0.15, drop_db=55), floor(0.3))
    result = measure_ending(samples, RATE, anchor=1.2)
    assert result["clipped"] is False
    assert result["end_db"] < CLIP_END_DB  # type: ignore[operator]


def test_a_voice_cut_by_the_file_end_is_clipped() -> None:
    samples = take(floor(0.3), voice(1.0))
    result = measure_ending(samples, RATE, anchor=1.2)
    assert result["clipped"] is True
    assert result["end_db"] > CLIP_END_DB  # type: ignore[operator]


def test_the_old_trim_with_a_40_ms_fade_into_voice_is_clipped() -> None:
    samples = take(floor(0.3), voice(1.0))
    fade = int(0.04 * RATE)
    samples[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)
    assert measure_ending(samples, RATE)["clipped"] is True


def test_a_voice_dropping_straight_to_digital_zero_is_clipped_and_hard_gated() -> None:
    samples = take(floor(0.3), voice(1.0), zeros(0.3))
    result = measure_ending(samples, RATE)
    assert result["clipped"] is True
    assert result["hard_gate"] is True


def test_a_stray_sound_after_the_line_is_not_its_ending() -> None:
    samples = take(floor(0.3), voice(1.0), decay(0.15, drop_db=55), floor(0.5), voice(0.05))
    assert measure_ending(samples, RATE)["clipped"] is True  # judged at the stray burst
    assert measure_ending(samples, RATE, anchor=1.2)["clipped"] is False  # judged at the line


def test_finishing_never_clips_what_the_engine_ended_well() -> None:
    samples = take(floor(0.3, -70.0), voice(1.0), decay(0.08), zeros(0.1))
    out, info = finish(samples, RATE, word_end=1.1)
    assert measure_ending(info["measured"], RATE, anchor=1.1)["clipped"] is False  # type: ignore[arg-type]
    assert measure_ending(out, RATE, anchor=1.1)["clipped"] is False


# --- perform's use ---------------------------------------------------------------------------


def test_last_word_end_takes_the_later_of_whisper_and_the_aligner() -> None:
    assert last_word_end({"word_end": 1.2, "timings": [{"word": "x", "start": 0.0, "end": 1.4}]}) == 1.4
    assert last_word_end({"word_end": 1.2}) == 1.2
    assert last_word_end({"timings": []}) is None


def test_finish_take_measures_the_engine_audio_not_the_padding() -> None:
    # The engine stopped mid-voice: room tone after it must not hide the cut.
    samples = take(floor(0.3, -70.0), voice(1.0))
    out, ending = finish_take(samples, RATE, {"word_end": 1.25})
    assert ending["clipped"] is True
    assert len(out) > len(samples)
    assert set(ending) >= {"clipped", "end_db", "fall_ms", "hard_gate", "voice_end", "cut", "room_tone", "word_end"}
