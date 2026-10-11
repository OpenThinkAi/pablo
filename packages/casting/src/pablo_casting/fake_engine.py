"""A model-free engine: silence of the right shape (AGT-1681).

It stands in for a real cloner until C11 lands one: 24 kHz mono 16-bit PCM,
as long as the lines would take to say at `wps` words per second plus the
180 ms tail a real take keeps after its last word, with evenly spaced word
timings. Deterministic in its inputs, so tests can count on it.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from pablo_casting.takes import EngineId, Synthesis, TakeInputs, WordTiming
from pablo_casting.wav import silence

TAIL_SECONDS = 0.18


@dataclass(frozen=True)
class FakeEngine:
    identity: EngineId = field(default_factory=lambda: EngineId(id="fake", weights_sha256="0" * 64, mlx_audio="none", mlx="none"))
    sample_rate: int = 24_000
    wps: float = 2.8
    calls: list[str] = field(default_factory=list, compare=False)

    def synthesize(self, inputs: TakeInputs) -> Synthesis:
        self.calls.append(" / ".join(line.text for line in inputs.lines))
        words = [word for line in inputs.lines for word in line.text.split()]
        per_word = 1.0 / self.wps
        timings = tuple(
            WordTiming(word=word, start=round(i * per_word, 3), end=round((i + 1) * per_word, 3)) for i, word in enumerate(words)
        )
        return Synthesis(audio=silence(len(words) * per_word + TAIL_SECONDS, self.sample_rate), words=timings)
