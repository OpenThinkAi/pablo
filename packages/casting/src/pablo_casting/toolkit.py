"""The model seams casting goes through: a designer, a speaker embedder, a
naturalness (MOS) scorer and an aligner.

`audition` and `cast` only ever talk to these protocols, so the default test
run (and stamp's `casting-test`) drives them with the deterministic fakes in
`pablo_casting.fakes` and never loads a model. The real adapters live in
`pablo_casting.real` and are imported lazily, only when a real toolkit is
built.

Which toolkit a command gets is `select_toolkit`'s call: the real one, unless
`PABLO_CASTING_TOOLKIT=fake` is set (a test and smoke-test hook: it renders
synthetic tones, never a voice, and its cards say so in their provenance).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Protocol

import numpy as np

DESIGNER_NAMES = ("qwen3", "voxcpm2")
DEFAULT_DESIGNER = "qwen3"

DEFAULT_DESIGNER_MODELS: dict[str, str] = {
    "qwen3": "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16",
    "voxcpm2": "mlx-community/VoxCPM2-bf16",
}

TOOLKIT_ENV = "PABLO_CASTING_TOOLKIT"


@dataclass(frozen=True)
class Word:
    text: str
    start: float
    end: float


class Designer(Protocol):
    """Renders a described voice reading a text. The only source of a card's reference."""

    name: str
    """`qwen3` or `voxcpm2` (or `fake`)."""
    engine: str
    """The weights id, as the card's `designed.engine` records it."""

    def weights_sha256(self) -> str: ...

    def render(self, instruct: str, text: str, seed: int) -> tuple[np.ndarray, int]:
        """Mono float audio and its sample rate."""
        ...


class Embedder(Protocol):
    model: str
    """The embedding model id, as the card's `embedding.model` records it."""

    def embed(self, audio: np.ndarray, rate: int) -> np.ndarray:
        """A speaker embedding (192-d for ECAPA)."""
        ...


class MosScorer(Protocol):
    model: str

    def score(self, audio: np.ndarray, rate: int) -> float: ...


class Aligner(Protocol):
    model: str

    def align(self, audio: np.ndarray, rate: int, text: str) -> list[Word]:
        """Word timings, in seconds, for `text` as spoken in `audio`."""
        ...


@dataclass(frozen=True)
class Toolkit:
    designer: Callable[[str], Designer]
    """Builds the named designer (lazily: a real designer loads its weights here)."""
    embedder: Callable[[], Embedder]
    mos: Callable[[], MosScorer]
    aligner: Callable[[], Aligner]
    kind: str = "real"


class ToolkitUnavailable(Exception):
    """A model the command needs cannot be loaded here; a refusal (exit 2)."""


def designer_model(name: str, engines: Mapping[str, Mapping[str, object]]) -> str:
    """The weights id for a designer: `engines.designers.<name>.model` in the config, else the default."""
    designers = engines.get("designers")
    if isinstance(designers, Mapping):
        entry = designers.get(name)
        if isinstance(entry, Mapping) and isinstance(entry.get("model"), str):
            return str(entry["model"])
    return DEFAULT_DESIGNER_MODELS[name]


def designer_revision(name: str, engines: Mapping[str, Mapping[str, object]]) -> str | None:
    """The revision a designer's weights are fetched at (AGT-2274).

    The default model's is its pin (`pins.py`); an `engines.designers.<name>.model` the
    author names carries its own optional `revision`, and `None` (the Hub's current
    revision, which `real_toolkit` warns about) when it has none.
    """
    from pablo_casting.pins import pinned

    designers = engines.get("designers")
    entry = designers.get(name) if isinstance(designers, Mapping) else None
    if isinstance(entry, Mapping) and isinstance(entry.get("model"), str):
        revision = entry.get("revision")
        return revision if isinstance(revision, str) and revision else None
    return pinned(DEFAULT_DESIGNER_MODELS[name])


def select_toolkit(env: Mapping[str, str], engines: Mapping[str, Mapping[str, object]]) -> Toolkit:
    if env.get(TOOLKIT_ENV) == "fake":
        from pablo_casting.fakes import fake_toolkit

        return fake_toolkit()
    from pablo_casting.real import real_toolkit

    return real_toolkit(env, engines)
