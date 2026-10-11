"""PCM WAV in and out with the standard library only (no numpy until an engine lands)."""

from __future__ import annotations

import io
import wave
from dataclasses import dataclass


@dataclass(frozen=True)
class Audio:
    """Raw interleaved PCM frames and their shape."""

    frames: bytes
    sample_rate: int
    channels: int = 1
    sample_width: int = 2  # bytes per sample: 16-bit PCM

    @property
    def frame_count(self) -> int:
        return len(self.frames) // (self.channels * self.sample_width)

    @property
    def duration(self) -> float:
        return self.frame_count / self.sample_rate

    def to_wav(self) -> bytes:
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as out:
            out.setnchannels(self.channels)
            out.setsampwidth(self.sample_width)
            out.setframerate(self.sample_rate)
            out.writeframes(self.frames)
        return buffer.getvalue()


def silence(seconds: float, sample_rate: int = 24_000) -> Audio:
    """`seconds` of 16-bit mono digital silence."""
    frames = max(0, round(seconds * sample_rate))
    return Audio(frames=b"\x00\x00" * frames, sample_rate=sample_rate)


def read_wav(data: bytes) -> Audio:
    with wave.open(io.BytesIO(data), "rb") as source:
        return Audio(
            frames=source.readframes(source.getnframes()),
            sample_rate=source.getframerate(),
            channels=source.getnchannels(),
            sample_width=source.getsampwidth(),
        )
