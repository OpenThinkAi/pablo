"""The real casting toolkit: Qwen3-TTS VoiceDesign and VoxCPM2 as designers,
and the gate's own scorer backends (AGT-1682, `scorers.py`) for the rest:
speechbrain ECAPA as the embedder, UTMOS22-strong (pinned to a commit) as the
MOS scorer, and Qwen3-ForcedAligner as the aligner. One loader per model, so
an audition and a gate score with the same weights.

Every import of a model stack happens when a toolkit piece is built, never at
import, so importing this module (and running the default test suite) loads
nothing. The stacks are the optional `scorers` extra (mlx-audio included, for
the designers); until it is installed in the casting venv, building a piece
is a `ToolkitUnavailable` refusal naming what is missing. The adapters are
exercised only by `-m models` tests, run by hand on the Studio.
"""

from __future__ import annotations

import sys
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import numpy as np

from pablo_casting.audio import resample, write_wav
from pablo_casting.hfcache import weights_sha256
from pablo_casting.scorers import ALIGNER, ECAPA, UTMOS, AlignerScorer, EcapaScorer, ScorerUnavailable, Take, UtmosScorer
from pablo_casting.toolkit import DESIGNER_NAMES, Toolkit, ToolkitUnavailable, Word, designer_model, designer_revision

SR_16K = 16_000


def _need(module: str, packages: str) -> Any:
    import importlib

    try:
        return importlib.import_module(module)
    except ImportError as error:
        raise ToolkitUnavailable(f"this needs {packages} in the casting venv (the `scorers` extra), which is not installed: {error}") from error


def _loaded(scorer: Any) -> Any:
    """Loads a `scorers.py` backend now, turning a missing extra into a refusal."""
    try:
        scorer.model()
    except ScorerUnavailable as missing:
        raise ToolkitUnavailable(str(missing)) from missing
    return scorer


class _MlxDesigner:
    """Shared by both designers: load through mlx-audio, seed MLX's RNG, concatenate the chunks."""

    def __init__(self, name: str, engine: str, env: Mapping[str, str], revision: str | None = None) -> None:
        utils = _need("mlx_audio.tts.utils", "mlx-audio")
        self._mx = _need("mlx.core", "mlx")
        self.name = name
        self.engine = engine
        self.revision = revision
        self._env = env
        self._model = utils.load_model(engine) if revision is None else utils.load_model(engine, revision=revision)

    def weights_sha256(self) -> str:
        return weights_sha256(self.engine, self._env, self.revision) or "unknown"

    def _chunks(self, instruct: str, text: str) -> Any:
        raise NotImplementedError

    def render(self, instruct: str, text: str, seed: int) -> tuple[np.ndarray, int]:
        self._mx.random.seed(seed)
        parts = [np.asarray(chunk.audio, dtype=np.float32).reshape(-1) for chunk in self._chunks(instruct, text)]
        return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32), int(self._model.sample_rate)


class QwenDesigner(_MlxDesigner):
    def _chunks(self, instruct: str, text: str) -> Any:
        return self._model.generate_voice_design(text=text, language="English", instruct=instruct)


class VoxcpmDesigner(_MlxDesigner):
    def _chunks(self, instruct: str, text: str) -> Any:
        # No reference: VoxCPM2 builds "(instruct)text", its voice-design mode.
        return self._model.generate(text=text, instruct=instruct)


class EcapaEmbedder:
    model = ECAPA.weights

    def __init__(self) -> None:
        self._scorer = _loaded(EcapaScorer())
        self._torch = _need("torch", "torch")

    def embed(self, audio: np.ndarray, rate: int) -> np.ndarray:
        with self._torch.no_grad():
            wav = self._torch.from_numpy(resample(audio, rate, SR_16K))[None]
            embedding = self._scorer.model().encode_batch(wav)
        return embedding.squeeze().cpu().numpy().astype(np.float32)


class UtmosMos:
    model = UTMOS.weights

    def __init__(self) -> None:
        self._scorer = _loaded(UtmosScorer())
        self._torch = _need("torch", "torch")

    def score(self, audio: np.ndarray, rate: int) -> float:
        with self._torch.no_grad():
            mos = self._scorer.model()(self._torch.from_numpy(resample(audio, rate, SR_16K))[None], SR_16K)
        return round(float(mos.item()), 3)


class ForcedAligner:
    """The gate's Qwen3-ForcedAligner (it reads a file, so the candidate is written to a temp wav)."""

    model = ALIGNER.weights

    def __init__(self) -> None:
        self._scorer = _loaded(AlignerScorer())

    def align(self, audio: np.ndarray, rate: int, text: str) -> list[Word]:
        with tempfile.TemporaryDirectory(prefix="pablo-align-") as folder:
            path = Path(folder) / "candidate.wav"
            write_wav(path, audio, rate)
            result = self._scorer.score(Take(audio=path, line=text, seconds=len(audio) / float(rate)))
        return [Word(str(t["word"]), float(t["start"]), float(t["end"])) for t in result["timings"]]  # type: ignore[union-attr]


def real_toolkit(env: Mapping[str, str], engines: Mapping[str, Mapping[str, object]]) -> Toolkit:
    def designer(name: str) -> _MlxDesigner:
        if name not in DESIGNER_NAMES:
            raise ToolkitUnavailable(f'unknown designer "{name}": one of {", ".join(DESIGNER_NAMES)}')
        engine = designer_model(name, engines)
        revision = designer_revision(name, engines)
        if revision is None:
            print(
                f"pablo casting: designer {name} model {engine} has no `revision` in casting.json, so it fetches the Hub's "
                f'current revision; pin one with engines.designers.{name}.revision: "<commit sha>"',
                file=sys.stderr,
                flush=True,
            )
        return (QwenDesigner if name == "qwen3" else VoxcpmDesigner)(name, engine, env, revision)

    return Toolkit(designer=designer, embedder=EcapaEmbedder, mos=UtmosMos, aligner=ForcedAligner, kind="real")
