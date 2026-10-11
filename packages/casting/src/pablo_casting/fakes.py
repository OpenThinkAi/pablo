"""Deterministic, model-free stand-ins for the casting toolkit.

The fake designer renders a "voice" as a harmonic tone: one burst per word of
the text at a steady words-per-second, a longer gap after each sentence, and
silence before and after (so the aligner's trim is exercised). Its pitch is a
function of the instruct and the seed, so different candidates differ and the
same inputs reproduce exactly. The fake aligner finds the bursts by energy, the
fake embedder is a log-spaced spectrum (same pitch, same embedding: a near
duplicate), and the fake MOS scorer is a constant. Nothing here is a voice;
its provenance names `fake/...` engines so a fake card can never pass for a
real one.

Used by the default pytest run and by `PABLO_CASTING_TOOLKIT=fake` smoke runs.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Callable

import numpy as np

from pablo_casting.toolkit import Toolkit, Word

FAKE_RATE = 24_000
_SENTENCE_END = re.compile(r"[.!?;:]$")


def _pitch_from(instruct: str, seed: int) -> float:
    digest = hashlib.sha256(f"{instruct}\0{seed}".encode()).digest()
    return 90.0 + (digest[0] % 12) * 15.0  # 90..255 Hz in 15 Hz steps


class FakeDesigner:
    def __init__(
        self,
        name: str = "fake",
        rate: int = FAKE_RATE,
        wps: float = 3.0,
        lead: float = 0.6,
        tail: float = 1.2,
        pitch: Callable[[str, int], float] | None = None,
        weights: str = "0" * 64,
    ) -> None:
        self.name = name
        self.engine = f"fake/{name}-designer"
        self.rate = rate
        self.wps = wps
        self.lead = lead
        self.tail = tail
        self._pitch = pitch or _pitch_from
        self._weights = weights
        self.calls: list[tuple[str, str, int]] = []

    def weights_sha256(self) -> str:
        return self._weights

    def render(self, instruct: str, text: str, seed: int) -> tuple[np.ndarray, int]:
        self.calls.append((instruct, text, seed))
        f0 = self._pitch(instruct, seed)
        period = 1.0 / self.wps
        burst = period * 0.7
        pieces: list[np.ndarray] = [np.zeros(int(self.lead * self.rate), dtype=np.float32)]
        t = np.arange(int(burst * self.rate)) / self.rate
        envelope = np.sin(np.pi * t / burst) ** 0.5
        tone = (0.5 * np.sin(2 * np.pi * f0 * t) + 0.25 * np.sin(4 * np.pi * f0 * t) + 0.12 * np.sin(6 * np.pi * f0 * t)) * envelope
        for word in text.split():
            pieces.append((0.6 * tone).astype(np.float32))
            gap = period - burst + (0.25 if _SENTENCE_END.search(word) else 0.0)
            pieces.append(np.zeros(int(gap * self.rate), dtype=np.float32))
        pieces.append(np.zeros(int(self.tail * self.rate), dtype=np.float32))
        return np.concatenate(pieces), self.rate


class FakeAligner:
    model = "fake/energy-aligner"

    def align(self, audio: np.ndarray, rate: int, text: str) -> list[Word]:
        hop = int(rate * 0.01)
        frames = len(audio) // hop
        if frames == 0:
            return []
        energy = np.sqrt(np.mean(audio[: frames * hop].reshape(frames, hop) ** 2, axis=1))
        voiced = energy > max(1e-4, 0.05 * float(energy.max()))
        segments: list[tuple[int, int]] = []
        start: int | None = None
        for index, on in enumerate(voiced):
            if on and start is None:
                start = index
            elif not on and start is not None:
                segments.append((start, index))
                start = None
        if start is not None:
            segments.append((start, frames))
        words = text.split()
        return [Word(words[i] if i < len(words) else "", s * hop / rate, e * hop / rate) for i, (s, e) in enumerate(segments)]


class FakeEmbedder:
    model = "fake/spectrum-embedder"

    def embed(self, audio: np.ndarray, rate: int) -> np.ndarray:
        spectrum = np.abs(np.fft.rfft(audio.astype(np.float64)))
        freqs = np.fft.rfftfreq(len(audio), 1.0 / rate)
        edges = np.geomspace(60.0, 2000.0, 193)
        bins = np.array([spectrum[(freqs >= lo) & (freqs < hi)].sum() for lo, hi in zip(edges[:-1], edges[1:])])
        norm = float(np.linalg.norm(bins)) or 1.0
        return (bins / norm).astype(np.float32)


class FakeMos:
    model = "fake/mos"

    def __init__(self, value: float = 4.1) -> None:
        self.value = value

    def score(self, audio: np.ndarray, rate: int) -> float:
        return self.value


def fake_toolkit(designer: FakeDesigner | None = None, mos: float = 4.1) -> Toolkit:
    """A whole fake toolkit; `designer` lets a test pin the pitch, rate or pace."""

    def build(name: str) -> FakeDesigner:
        if designer is not None:
            return designer
        return FakeDesigner(name=name)

    return Toolkit(designer=build, embedder=FakeEmbedder, mos=lambda: FakeMos(mos), aligner=FakeAligner, kind="fake")
