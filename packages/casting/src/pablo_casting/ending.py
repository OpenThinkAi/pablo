"""How a take ends: where its voice stops, where it is cut, and whether it was clipped (AGT-1789).

Three things live here, all model-free (numpy only):

**Levels.** A take is read as 20 ms RMS windows every 10 ms, in dB relative to
the take's own speech level (the 90th percentile of its non-silent windows), so
one threshold fits a soft line and a shouted one alike.

**Finishing** (`finish`): the take as stored. The old trim cut at Whisper's
last-word end + 180 ms with a 40 ms fade; Whisper puts word ends early, so that
cut into speech that was still voiced. Now:

- the *voice end* is the end of the last window above `VOICED_DB` in the voiced
  run that holds the last script word (gaps under `BRIDGE_SECONDS` bridged, so
  a breath inside the word does not end it, and a later throwaway word, e.g.
  Dia's `Mm.`, is never reached);
- the cut is `max(voice end, last-word end) + air` (`DEFAULT_AIR`, 0.18 s,
  configurable), held short of the next voiced onset when one follows within
  the air; it is never before the last word's end or the voice end;
- the fade is a raised cosine over at most `FADE_MAX_SECONDS` that lies wholly
  inside the air, never over voiced audio;
- an engine that hard-gates to digital zero (Chatterbox-Turbo does, 100-150 ms
  after its last word), or whose audio ends before the cut, has the rest of the
  air filled with **room tone**: noise at the take's own floor (the median of
  its quiet, non-zero windows), so the line decays into a floor and then fades,
  instead of stopping dead.

**The clipping detector** (`measure_ending`): the tail gate's audio measure.
A voice that is cut off is still loud right before the silence starts; a voice
that finishes has decayed. `end_db` is the level 20 ms before the first window
after the last voiced one that is at or below `SILENCE_DB` (or before the end of
the file, when no such window comes); `fall_ms` is how long the level took to go
from `LOUD_DB` to that silence. A take is `clipped` when `end_db` is above
`CLIP_END_DB` or the fall is shorter than `FALL_MIN_MS`. Measured on the
2026-10-11 engine A/B (24 untrimmed Chatterbox and Turbo takes, every ending
whole): `end_db` -38 to -57 on 23 of them; the 24th, a plain-Chatterbox take
whose file ends while a breath after the word still sounds, is flagged; on episode 1's takes trimmed into speech
by the old cut (lines 5, 6, 11, 12, 27, 31, 33, every one of which Matt heard
cut off): -10 to -26.

`perform` measures the take's own audio up to the cut, before any room tone or
fade, so the detector judges what the engine (and the cut) did, never the
padding pablo adds.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

import numpy as np

WINDOW_SECONDS = 0.02
HOP_SECONDS = 0.01

VOICED_DB = -40.0
"""A window above this (dB re the speech level) is voice."""
SILENCE_DB = -60.0
"""At or below this the voice has gone."""
LOUD_DB = -20.0
"""Speech at full voice, for the fall time."""
CLIP_END_DB = -35.0
"""`end_db` above this is a voice cut off while still sounding."""
FALL_MIN_MS = 20.0
"""A fall from full voice to silence faster than this is a cut."""

DEFAULT_AIR = 0.18
"""Seconds of air kept after the voice end (or the last word's end, when later)."""
AIR_RANGE = (0.05, 0.6)
BRIDGE_SECONDS = 0.06
FADE_MAX_SECONDS = 0.08
ROOM_TONE_RANGE = (-72.0, -48.0)
"""The room tone's level is clamped to this band, dB re the speech level."""
ZERO = 2.0 / 32768.0
"""At or below this a sample is digital silence (16-bit PCM's last bit)."""
HARD_GATE_SECONDS = 0.005


def last_word_end(scores: Mapping[str, object]) -> float | None:
    """Where the last script word ends: the later of Whisper's `word_end` and the aligner's last timing, `None` when neither has it."""
    ends: list[float] = []
    heard = scores.get("word_end")
    if isinstance(heard, (int, float)) and not isinstance(heard, bool) and heard > 0:
        ends.append(float(heard))
    timings = scores.get("timings")
    if isinstance(timings, list) and timings and isinstance(timings[-1], dict):
        end = timings[-1].get("end")
        if isinstance(end, (int, float)) and not isinstance(end, bool) and end > 0:
            ends.append(float(end))
    return max(ends) if ends else None


@dataclass(frozen=True)
class Levels:
    """Windowed RMS levels: `db[k]` is window k (samples `[k*hop, k*hop+win)`) re `speech_dbfs`."""

    db: np.ndarray
    speech_dbfs: float
    hop: float
    window: float

    def time_after(self, k: int) -> float:
        """Seconds at the end of window k."""
        return k * self.hop + self.window


def levels(samples: np.ndarray, rate: int) -> Levels | None:
    """The take's window levels, or `None` when nothing in it sounds."""
    x = np.asarray(samples, dtype=np.float64).reshape(-1)
    win = max(1, int(round(rate * WINDOW_SECONDS)))
    hop = max(1, int(round(rate * HOP_SECONDS)))
    if len(x) < win:
        x = np.concatenate([x, np.zeros(win - len(x))])
    n = (len(x) - win) // hop + 1
    index = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    rms = np.sqrt(np.mean(x[index] ** 2, axis=1))
    dbfs = 20.0 * np.log10(np.maximum(rms, 1e-10))
    sounding = dbfs[rms > ZERO]
    if sounding.size == 0:
        return None
    speech = float(np.percentile(sounding, 90))
    return Levels(db=dbfs - speech, speech_dbfs=speech, hop=hop / rate, window=win / rate)


def _voiced_run_end(lv: Levels, anchor: float | None) -> tuple[int | None, int | None]:
    """(last voiced window of the run holding `anchor`, the next voiced window after it)."""
    voiced = lv.db > VOICED_DB
    n = len(voiced)
    if not voiced.any():
        return None, None
    if anchor is None:
        return int(np.flatnonzero(voiced)[-1]), None
    k = min(n - 1, max(0, int(anchor / lv.hop)))
    # The run holding the anchor: step back to a voiced window if the anchor sits in a short gap.
    back = k
    while back > 0 and not voiced[back] and (k - back) * lv.hop <= BRIDGE_SECONDS:
        back -= 1
    last: int | None = back if voiced[back] else None
    gap = 0
    j = max(k, back)
    while j < n:
        if voiced[j]:
            last, gap = j, 0
        else:
            gap += 1
            if gap * lv.hop > BRIDGE_SECONDS:
                break
        j += 1
    following = np.flatnonzero(voiced[j:]) if j < n else np.array([], dtype=int)
    return last, (int(following[0]) + j if following.size else None)


def voice_end(samples: np.ndarray, rate: int, anchor: float | None = None) -> float | None:
    """Seconds where the voice holding `anchor` (else the last voice in the take) stops; `None` when nothing sounds."""
    lv = levels(samples, rate)
    if lv is None:
        return None
    last, _ = _voiced_run_end(lv, anchor)
    return None if last is None else round(lv.time_after(last), 3)


def measure_ending(samples: np.ndarray, rate: int, anchor: float | None = None) -> dict[str, object]:
    """The clipping detector: `clipped`, `end_db`, `fall_ms` and `hard_gate` for how the voice in `samples` ends.

    `anchor` (seconds, the last script word's end when known) picks the voiced
    run to judge, so a stray sound after the line is not mistaken for its end;
    without it the take's last voiced run is judged.
    """
    x = np.asarray(samples, dtype=np.float32).reshape(-1)
    lv = levels(x, rate)
    if lv is None:
        return {"clipped": False, "end_db": None, "fall_ms": None, "hard_gate": False}
    db = lv.db
    last, following = _voiced_run_end(lv, anchor)
    if last is None:
        return {"clipped": False, "end_db": None, "fall_ms": None, "hard_gate": zero_run(x, rate, 0) is not None}
    region_end = following if following is not None else len(db)
    after = np.flatnonzero(db[last + 1 : region_end] <= SILENCE_DB)
    # The file's end counts as silence: a voice still sounding in the last window is cut by the end itself.
    onset = last + 1 + int(after[0]) if after.size else region_end
    end_db = float(db[onset - 2]) if onset - 2 >= 0 else float(db[0])
    loud = np.flatnonzero(db[: last + 1] >= LOUD_DB)
    fall_ms = round((onset - int(loud[-1])) * lv.hop * 1000.0, 1) if loud.size else None
    clipped = end_db > CLIP_END_DB or (fall_ms is not None and fall_ms < FALL_MIN_MS)
    gate = zero_run(x, rate, int(round(lv.time_after(last) * rate)))
    return {"clipped": bool(clipped), "end_db": round(end_db, 1), "fall_ms": fall_ms, "hard_gate": gate is not None}


def zero_run(x: np.ndarray, rate: int, start: int) -> int | None:
    """Where the first run of digital zero at least `HARD_GATE_SECONDS` long begins at or after `start` (an engine's hard gate)."""
    zero = np.abs(np.asarray(x[start:])) <= ZERO
    if not zero.any():
        return None
    need = max(1, int(rate * HARD_GATE_SECONDS))
    edges = np.diff(np.concatenate([[0], zero.astype(np.int8), [0]]))
    begins, ends = np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)
    for b, e in zip(begins, ends):
        if e - b >= need:
            return start + int(b)
    return None


def room_tone(n: int, rate: int, level_dbfs: float, seed: int) -> np.ndarray:
    """`n` samples of soft noise at `level_dbfs` RMS: white noise through a short moving average (darker, like a room)."""
    if n <= 0:
        return np.zeros(0, dtype=np.float32)
    rng = np.random.default_rng(seed)
    taps = max(1, int(rate / 4000))
    noise = np.convolve(rng.standard_normal(n + taps), np.ones(taps) / taps, mode="valid")[:n]
    rms = float(np.sqrt(np.mean(noise**2))) or 1.0
    return (noise / rms * 10.0 ** (level_dbfs / 20.0)).astype(np.float32)


def _floor_dbfs(lv: Levels) -> float:
    """The take's own noise floor: the median of its quiet, non-zero windows, clamped to the room-tone band."""
    quiet = lv.db[(lv.db < VOICED_DB - 10.0) & (lv.db > -110.0)]
    rel = float(np.median(quiet)) if quiet.size else SILENCE_DB
    rel = min(ROOM_TONE_RANGE[1], max(ROOM_TONE_RANGE[0], rel))
    return lv.speech_dbfs + rel


def finish(samples: np.ndarray, rate: int, word_end: float | None, air: float = DEFAULT_AIR) -> tuple[np.ndarray, dict[str, object]]:
    """The take as stored, and how it was finished (see the module docstring).

    Returns `(samples, info)`: `info` has `voice_end`, `word_end`, `cut`, `air`,
    `fade`, `room_tone` (seconds of room tone added) and `hard_gate`, plus
    `measured` (the samples the clipping detector should judge: the take's own
    audio up to the cut, unpadded and unfaded).
    """
    x = np.asarray(samples, dtype=np.float32).reshape(-1)
    air = min(AIR_RANGE[1], max(AIR_RANGE[0], float(air)))
    lv = levels(x, rate)
    base: dict[str, object] = {"voice_end": None, "word_end": word_end, "cut": None, "air": air, "fade": 0.0, "room_tone": 0.0, "hard_gate": False}
    if lv is None:
        return x.copy(), {**base, "measured": x}
    last, following = _voiced_run_end(lv, word_end)
    if last is None:
        if word_end is None:
            return x.copy(), {**base, "measured": x}
        v_end = None
        anchor = float(word_end)
    else:
        v_end = lv.time_after(last)
        anchor = max(v_end, float(word_end)) if word_end is not None else v_end
    cut = anchor + air
    if following is not None:
        # Stop short of a voice that starts inside the air (a throwaway word): keep at least 50 ms.
        cut = max(anchor + min(air, 0.05), min(cut, following * lv.hop - 0.02))
    n_cut = int(round(cut * rate))
    own = x[: min(n_cut, len(x))]

    v_end_n = min(len(own), int(round((v_end if v_end is not None else anchor) * rate)))
    gate_at = zero_run(own, rate, v_end_n)
    hard_gate = gate_at is not None
    # From a hard gate on, the engine's audio is digital zero (Turbo then clicks once): room tone instead.
    fill_from = gate_at if gate_at is not None else len(own)
    out = own[:fill_from].copy()
    filled = 0
    if fill_from < n_cut:
        filled = n_cut - fill_from
        tone = room_tone(filled, rate, _floor_dbfs(lv), seed=len(x))
        ramp = min(filled, int(rate * 0.005))
        if ramp:
            tone[:ramp] *= np.linspace(0.0, 1.0, ramp, dtype=np.float32)
        out = np.concatenate([out, tone])

    fade_n = min(int(rate * min(FADE_MAX_SECONDS, air / 2.0)), max(0, len(out) - v_end_n))
    if fade_n > 0:
        out[-fade_n:] *= (0.5 * (1.0 + np.cos(np.linspace(0.0, np.pi, fade_n)))).astype(np.float32)
    info = {
        **base,
        "voice_end": None if v_end is None else round(v_end, 3),
        "cut": round(len(out) / rate, 3),
        "fade": round(fade_n / rate, 3),
        "room_tone": round(filled / rate, 3),
        "hard_gate": hard_gate,
        "measured": own,
    }
    return out.astype(np.float32), info
