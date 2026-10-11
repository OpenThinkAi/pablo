"""A tonewheel organ for the MUSIC cues (AGT-1684), ported from the Valley's
Shadow sandbox (`radio/organ.py`): the 1940s radio-drama sound is a Hammond
playing slow swelling chords, not a cathedral pipe organ. Additive drawbars, a
little vibrato, a rotating-speaker wobble, then a room.

Synthesis is deterministic numpy; the lowpass and reverb are sox, as in the
prototype. What changed from the port's source: it returns the samples instead
of writing a path (the cue library owns the files), and a missing `sox` is a
`SoxUnavailable` the mix turns into a refusal.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 44_100
# Drawbar footages as harmonics of the played note, with levels (a mellow 888 registration).
DRAWBARS = [(0.5, 0.55), (1.0, 1.0), (1.5, 0.35), (2.0, 0.5), (3.0, 0.12), (4.0, 0.08)]

MINOR = [[57, 60, 64], [53, 57, 60], [50, 53, 57], [52, 56, 59], [57, 60, 64]]  # Am F Dm E Am
MAJOR = [[48, 52, 55], [45, 48, 52], [53, 57, 60], [55, 59, 62], [48, 52, 55]]  # C Am F G C
STING = [[47, 50, 53, 56]]  # B diminished 7th

BRIGHT_WORDS = ("light", "warm", "social", "gentle", "happy", "bright", "cheer")


class SoxUnavailable(Exception):
    """`sox` is not on the PATH (`brew install sox`)."""


def require_sox() -> str:
    found = shutil.which("sox")
    if found is None:
        raise SoxUnavailable("sox is not installed (brew install sox): the mix paces takes and the organ cues with it")
    return found


def midi(n: int) -> float:
    return 440.0 * 2 ** ((n - 69) / 12)


def chord(notes: list[int], seconds: float, swell: float = 0.35, release: float = 0.6) -> np.ndarray:
    n = int(seconds * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    vibrato = 1 + 0.0025 * np.sin(2 * np.pi * 6.4 * t)
    for note in notes + [notes[0] - 12]:  # left hand doubles the root an octave down
        f = midi(note)
        phase = 2 * np.pi * np.cumsum(f * vibrato) / SR
        for mult, level in DRAWBARS:
            if f * mult < 5000:
                out += level * np.sin(phase * mult)
    env = np.ones(n)
    a, r = int(swell * SR), int(release * SR)
    env[:a] = np.linspace(0, 1, a) ** 1.5
    env[-r:] *= np.linspace(1, 0, r) ** 1.2
    leslie = 1 + 0.18 * np.sin(2 * np.pi * 5.8 * t)
    return out * env * leslie


def organ_parts(desc: str) -> list[np.ndarray]:
    """The chords a cue description asks for: a sting, a theme (open/close), or a bridge."""
    d = desc.lower()
    if "sting" in d or "stab" in d or "sudden" in d:
        return [chord(STING[0], 2.6, swell=0.05, release=1.4)]
    prog = MAJOR if any(word in d for word in BRIGHT_WORDS) else MINOR
    if "theme" in d or "open" in d or "clos" in d:
        return [chord(c, 1.9, swell=0.5) for c in prog]
    return [chord(c, 2.0, swell=0.6) for c in prog[1:3]]  # bridge, swell, transition


def organ_cue(desc: str) -> np.ndarray:
    """The cue as mono float32 at 44.1 kHz, lowpassed and reverbed, peak about -2 dB."""
    sox = require_sox()
    raw = np.concatenate(organ_parts(desc))
    raw = raw / (np.abs(raw).max() + 1e-9) * 0.7
    with tempfile.TemporaryDirectory(prefix="pablo-organ-") as scratch:
        source, rendered = Path(scratch) / "raw.wav", Path(scratch) / "organ.wav"
        sf.write(str(source), raw.astype(np.float32), SR)
        subprocess.run(
            [sox, str(source), str(rendered), "lowpass", "3800", "reverb", "45", "60", "80", "gain", "-n", "-2"],
            check=True,
            stderr=subprocess.DEVNULL,
        )
        audio, rate = sf.read(str(rendered), dtype="float32", always_2d=True)
    assert rate == SR
    return np.ascontiguousarray(audio.mean(axis=1), dtype=np.float32)
