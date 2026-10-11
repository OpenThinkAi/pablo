"""Audio plumbing for cast cards: read and write WAV/FLAC, mono, resampling,
trimming, a model-free pitch estimate and file hashes.

Nothing here loads a model. A cast card's reference is 24 kHz mono FLAC
(design: "The cast card and the voice library"), so every candidate a designer
renders at its own rate is brought to `REFERENCE_RATE` here.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np
import soundfile as sf
import soxr

REFERENCE_RATE = 24_000
"""The sample rate of every card's `reference.flac`."""

REFERENCE_MIN_SECONDS = 20.0
REFERENCE_MAX_SECONDS = 30.0


def to_mono(audio: np.ndarray) -> np.ndarray:
    """A float32 mono signal from mono `(n,)` or multi-channel `(n, ch)` audio."""
    data = np.asarray(audio, dtype=np.float32)
    if data.ndim == 2:
        data = data.mean(axis=1)
    return data.reshape(-1).astype(np.float32, copy=False)


def resample(audio: np.ndarray, rate: int, target: int) -> np.ndarray:
    mono = to_mono(audio)
    if rate == target:
        return mono
    return np.asarray(soxr.resample(mono, rate, target), dtype=np.float32)


def read_audio(path: Path) -> tuple[np.ndarray, int]:
    data, rate = sf.read(str(path), dtype="float32", always_2d=False)
    return to_mono(data), int(rate)


def write_wav(path: Path, audio: np.ndarray, rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), to_mono(audio), rate, format="WAV", subtype="FLOAT")


def write_flac(path: Path, audio: np.ndarray, rate: int) -> None:
    """16-bit FLAC, the format the library tracks in git (about 1 MB for 25 s at 24 kHz)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    data = np.clip(to_mono(audio), -1.0, 1.0)
    sf.write(str(path), data, rate, format="FLAC", subtype="PCM_16")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def seconds(audio: np.ndarray, rate: int) -> float:
    return round(len(audio) / float(rate), 3)


def trim(audio: np.ndarray, rate: int, start: float, end: float) -> np.ndarray:
    """The samples between `start` and `end` seconds, clamped to the signal."""
    first = max(0, int(round(start * rate)))
    last = min(len(audio), int(round(end * rate)))
    return audio[first:last]


def estimate_pitch(audio: np.ndarray, rate: int, low: float = 60.0, high: float = 400.0) -> float | None:
    """Median fundamental frequency (Hz) over the voiced frames, by autocorrelation.

    Model-free and approximate: good enough to show a candidate's pitch next to
    the asked band and to sort candidates, not a gate. `None` when nothing in
    the signal is voiced.
    """
    mono = to_mono(audio)
    frame = int(rate * 0.04)
    hop = int(rate * 0.02)
    if frame <= 0 or len(mono) < frame:
        return None
    lag_min = max(1, int(rate / high))
    lag_max = min(frame - 1, int(rate / low))
    peak = float(np.max(np.abs(mono))) or 1.0
    estimates: list[float] = []
    for begin in range(0, len(mono) - frame, hop):
        chunk = mono[begin : begin + frame]
        if float(np.sqrt(np.mean(chunk**2))) < 0.05 * peak:
            continue
        chunk = chunk - chunk.mean()
        corr = np.correlate(chunk, chunk, mode="full")[frame - 1 :]
        if corr[0] <= 0:
            continue
        window = corr[lag_min : lag_max + 1]
        if window.size == 0:
            continue
        lag = int(np.argmax(window)) + lag_min
        if corr[lag] / corr[0] < 0.3:
            continue
        estimates.append(rate / lag)
    if not estimates:
        return None
    return round(float(np.median(estimates)), 1)


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    left = np.asarray(a, dtype=np.float64).reshape(-1)
    right = np.asarray(b, dtype=np.float64).reshape(-1)
    norm = float(np.linalg.norm(left) * np.linalg.norm(right))
    if norm == 0.0:
        return 0.0
    return round(float(np.dot(left, right) / norm), 4)
