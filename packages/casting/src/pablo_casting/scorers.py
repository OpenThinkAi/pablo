"""The scorer stack behind `pablo gate`: one interface, the real backends lazily imported.

Every scorer is a `Scorer`: static `ScorerInfo` (what it measures, its weights,
licenses, the distribution that runs it, where it runs) and `score(take)`
returning a dict of the measures it names. `gate` runs them in `SCORERS` order
and merges their answers; `gates.evaluate` judges the result.

The real backends need the optional `scorers` extra (and `emotion` for
emotion2vec), so nothing here imports torch, speechbrain, mlx or funasr at
module load: `doctor` lists the stack from metadata alone, and the default
test run uses fakes. A backend's heavy imports happen in `load()`, the first
time it scores; a missing extra is a `ScorerUnavailable`, which `gate` turns
into a refusal naming the extra (or, for the soft emotion scorer, a skipped
gate).

Where they run (design, "Research: quality gates on Apple Silicon"): Whisper
and the forced aligner on MLX; ECAPA, UTMOS, Audiobox and DNSMOS in PyTorch /
ONNX on the CPU; emotion2vec in PyTorch on the CPU.
"""

from __future__ import annotations

import importlib.util
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from importlib.metadata import PackageNotFoundError, version as dist_version
from pathlib import Path
from typing import Protocol

from pablo_casting.pins import pinned
from pablo_casting.words import Heard, words_check


@dataclass(frozen=True)
class ScorerInfo:
    name: str
    gate: str
    measures: tuple[str, ...]
    weights: str
    license_code: str
    license_weights: str
    package: str
    module: str
    runs: str
    extra: str
    revision: str | None = None
    soft: bool = False

    def installed(self) -> bool:
        return importlib.util.find_spec(self.module) is not None

    def version(self) -> str | None:
        try:
            return dist_version(self.package)
        except PackageNotFoundError:
            return None

    def as_body(self) -> dict[str, object]:
        body: dict[str, object] = {
            "name": self.name,
            "gate": self.gate,
            "measures": list(self.measures),
            "weights": self.weights,
            "license": {"code": self.license_code, "weights": self.license_weights},
            "package": self.package,
            "version": self.version(),
            "installed": self.installed(),
            "runs": self.runs,
            "extra": self.extra,
        }
        if self.revision is not None:
            body["revision"] = self.revision
        return body


@dataclass(frozen=True)
class Take:
    """One take to score: the audio, its script line and what it is compared with."""

    audio: Path
    line: str
    seconds: float
    card_embedding: Path | None = None
    card_reference: Path | None = None
    centroid: Sequence[float] | None = None
    # Lower-case script words the engine read respelt (AGT-1798): the words gate accepts whatever Whisper heard in their place.
    respelt: tuple[str, ...] = ()
    # Filled by earlier scorers in the stack (the aligner reads the line; nothing reads these yet).
    context: dict[str, object] = field(default_factory=dict)


class Scorer(Protocol):
    info: ScorerInfo

    def score(self, take: Take) -> Mapping[str, object]: ...


class ScorerUnavailable(Exception):
    """A real scorer's dependencies are not installed (the `scorers` / `emotion` extra)."""

    def __init__(self, info: ScorerInfo, cause: BaseException) -> None:
        super().__init__(f"the {info.name} scorer needs the `{info.extra}` extra ({info.package}): {cause}")
        self.info = info


WHISPER = ScorerInfo(
    name="whisper",
    gate="words, tail",
    measures=("wer", "inserted_span", "tail_ok", "word_end"),
    weights="mlx-community/whisper-large-v3-turbo",
    revision=pinned("mlx-community/whisper-large-v3-turbo"),
    license_code="MIT",
    license_weights="Apache-2.0",
    package="mlx-whisper",
    module="mlx_whisper",
    runs="MLX",
    extra="scorers",
)
ALIGNER = ScorerInfo(
    name="aligner",
    gate="pace, duration",
    measures=("timings",),
    weights="mlx-community/Qwen3-ForcedAligner-0.6B-bf16",
    revision=pinned("mlx-community/Qwen3-ForcedAligner-0.6B-bf16"),
    license_code="MIT",
    license_weights="Apache-2.0",
    package="mlx-audio",
    module="mlx_audio",
    runs="MLX",
    extra="scorers",
)
ECAPA = ScorerInfo(
    name="ecapa",
    gate="identity, consistency",
    measures=("sim_card", "sim_role_centroid"),
    weights="speechbrain/spkrec-ecapa-voxceleb",
    revision=pinned("speechbrain/spkrec-ecapa-voxceleb"),
    license_code="Apache-2.0",
    license_weights="Apache-2.0",
    package="speechbrain",
    module="speechbrain",
    runs="CPU (PyTorch)",
    extra="scorers",
)
UTMOS = ScorerInfo(
    name="utmos",
    gate="naturalness",
    measures=("utmos",),
    weights="tarepan/SpeechMOS utmos22_strong",
    # The commit tag v1.2.0 points at (git ls-remote, 2026-10-10); an immutable pin.
    revision=pinned("tarepan/SpeechMOS"),
    license_code="MIT",
    license_weights="MIT",
    package="torch",
    module="torch",
    runs="CPU (PyTorch)",
    extra="scorers",
)
AUDIOBOX = ScorerInfo(
    name="audiobox",
    gate="naturalness (second opinion)",
    measures=("pq",),
    weights="facebook/audiobox-aesthetics",
    revision=pinned("facebook/audiobox-aesthetics"),
    license_code="CC BY 4.0",
    license_weights="CC BY 4.0",
    package="audiobox_aesthetics",
    module="audiobox_aesthetics",
    runs="CPU (PyTorch)",
    extra="scorers",
)
DNSMOS = ScorerInfo(
    name="dnsmos",
    gate="artefacts",
    measures=("bak", "ovrl"),
    weights="microsoft DNSMOS sig_bak_ovr.onnx (bundled in speechmos)",
    license_code="MIT",
    license_weights="CC BY 4.0",
    package="speechmos",
    module="speechmos",
    runs="CPU (ONNX Runtime)",
    extra="scorers",
)
EMOTION = ScorerInfo(
    name="emotion",
    gate="emotion (soft)",
    measures=("emotion_top2",),
    weights="emotion2vec/emotion2vec_plus_large",
    revision=pinned("emotion2vec/emotion2vec_plus_large"),
    license_code="MIT",
    license_weights="unverified",
    package="funasr",
    module="funasr",
    runs="CPU (PyTorch)",
    extra="emotion",
    soft=True,
)

SCORERS: tuple[ScorerInfo, ...] = (WHISPER, ALIGNER, ECAPA, UTMOS, AUDIOBOX, DNSMOS, EMOTION)


def describe() -> list[dict[str, object]]:
    """The stack for `doctor`: weights, licenses and installed versions, without importing any backend."""
    return [info.as_body() for info in SCORERS]


# --- the real backends -------------------------------------------------------
#
# Each loads its model once, on first use, and never at import. None of them is
# exercised by the default test run; `tests/test_scorers_models.py` (marker
# `models`) runs them by hand on the Studio.

SR_16K = 16000


def _load_mono(path: Path):  # -> numpy array, sample rate
    import numpy as np
    import soundfile as sf

    audio, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return np.ascontiguousarray(audio.mean(axis=1)), sr


def _resample(audio, sr: int, target: int):
    import numpy as np

    if sr == target:
        return audio
    return np.interp(np.arange(0, len(audio), sr / target), np.arange(len(audio)), audio).astype(np.float32)


def _cosine(a, b) -> float:
    import numpy as np

    a = np.asarray(a, dtype=np.float64).ravel()
    b = np.asarray(b, dtype=np.float64).ravel()
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))


def _snapshot(repo: str, revision: str) -> str:
    """The local directory of `repo` at `revision`, downloading it into the HF cache if absent.

    For the loaders that take a repo id but no revision (mlx-whisper, funasr's `hub="hf"`
    path): pin here, then hand them the local path. Tests replace this function.
    """
    from huggingface_hub import snapshot_download

    return snapshot_download(repo_id=repo, revision=revision)


def _revision(info: ScorerInfo) -> str:
    assert info.revision is not None, f"{info.name} has no pinned revision (pins.py)"
    return info.revision


class _Lazy:
    info: ScorerInfo

    def __init__(self) -> None:
        self._model: object | None = None
        self._path: str | None = None

    def _load(self) -> object:
        raise NotImplementedError

    def model(self) -> object:
        if self._model is None:
            try:
                self._model = self._load()
            except ImportError as missing:
                raise ScorerUnavailable(self.info, missing) from missing
        return self._model


class WhisperScorer(_Lazy):
    info = WHISPER

    def _load(self) -> object:
        import mlx_whisper

        # mlx_whisper.transcribe takes a repo id or a path but no revision (it calls
        # snapshot_download(repo_id) itself), so pin at the snapshot and pass the path.
        self._path = _snapshot(self.info.weights, _revision(self.info))
        return mlx_whisper

    def score(self, take: Take) -> Mapping[str, object]:
        whisper = self.model()
        audio, sr = _load_mono(take.audio)
        result = whisper.transcribe(  # type: ignore[attr-defined]
            _resample(audio, sr, SR_16K),
            path_or_hf_repo=self._path,
            language="en",
            verbose=None,
            word_timestamps=True,
            condition_on_previous_text=False,
        )
        heard = [Heard(w["word"], float(w["start"]), float(w["end"])) for seg in result["segments"] for w in seg.get("words", [])]
        measured = words_check(take.line, heard, take.respelt)
        return {k: measured[k] for k in ("wer", "inserted_span", "tail_ok", "word_end")} | {"heard": " ".join(h.word.strip() for h in heard)}


class AlignerScorer(_Lazy):
    info = ALIGNER

    def _load(self) -> object:
        from mlx_audio.stt.utils import load

        return load(self.info.weights, revision=_revision(self.info))

    def score(self, take: Take) -> Mapping[str, object]:
        model = self.model()
        result = model.generate(str(take.audio), text=take.line, language="English")  # type: ignore[attr-defined]
        timings = [{"word": item.text, "start": round(float(item.start_time), 3), "end": round(float(item.end_time), 3)} for item in result]
        return {"timings": timings}


class EcapaScorer(_Lazy):
    info = ECAPA

    def _load(self) -> object:
        from speechbrain.inference.speaker import EncoderClassifier
        from speechbrain.utils.fetching import FetchConfig

        return EncoderClassifier.from_hparams(
            source=self.info.weights,
            run_opts={"device": "cpu"},
            fetch_config=FetchConfig(revision=_revision(self.info)),
        )

    def _embed(self, path: Path):
        import torch

        audio, sr = _load_mono(path)
        with torch.no_grad():
            embedding = self.model().encode_batch(torch.from_numpy(_resample(audio, sr, SR_16K))[None])  # type: ignore[attr-defined]
        return embedding.squeeze().cpu().numpy()

    def score(self, take: Take) -> Mapping[str, object]:
        import numpy as np

        mine = self._embed(take.audio)
        card = None
        if take.card_embedding is not None:
            card = np.load(take.card_embedding, allow_pickle=False)
        elif take.card_reference is not None:
            card = self._embed(take.card_reference)
        return {
            "sim_card": None if card is None else round(_cosine(mine, card), 4),
            "sim_role_centroid": None if take.centroid is None else round(_cosine(mine, take.centroid), 4),
        }


class UtmosScorer(_Lazy):
    info = UTMOS

    def _load(self) -> object:
        import torch

        # torch.hub runs the repo's hubconf.py, so the ref is a full commit SHA
        # (the v1.2.0 release's commit), never a tag or branch a force-push could
        # move. `trust_repo=True` only skips the interactive prompt, which would
        # hang under pablo's non-interactive subprocess; the SHA is the integrity check.
        import sys

        before = {name for name in sys.modules if name == "speechmos" or name.startswith("speechmos.")}
        model = torch.hub.load(f"tarepan/SpeechMOS:{self.info.revision}", "utmos22_strong", trust_repo=True).eval()
        # The hub repo's own package is also named `speechmos` and stays in sys.modules after the
        # load, shadowing the pip `speechmos` DNSMOS imports (`cannot import name 'dnsmos'`), so
        # forget it once the model is built. AGT-1683 found this on the first real perform.
        for name in [n for n in sys.modules if (n == "speechmos" or n.startswith("speechmos.")) and n not in before]:
            del sys.modules[name]
        return model

    def score(self, take: Take) -> Mapping[str, object]:
        import torch

        audio, sr = _load_mono(take.audio)
        with torch.no_grad():
            mos = self.model()(torch.from_numpy(_resample(audio, sr, SR_16K))[None], SR_16K)  # type: ignore[operator]
        return {"utmos": round(float(mos.item()), 3)}


class AudioboxScorer(_Lazy):
    info = AUDIOBOX

    def _load(self) -> object:
        from audiobox_aesthetics.infer import AesPredictor
        from audiobox_aesthetics.model.aes import AesMultiOutput

        repo, revision = self.info.weights, _revision(self.info)

        class PinnedPredictor(AesPredictor):
            # `initialize_predictor()` loads `AesMultiOutput.from_pretrained("facebook/audiobox-aesthetics")`
            # with no revision and no way to pass one; this is its `setup_model` (0.0.4) with the pin added.
            def setup_model(self) -> None:
                import torch

                if torch.cuda.is_available():
                    self.device = torch.device("cuda")
                elif torch.backends.mps.is_available():
                    self.device = torch.device("mps")
                else:
                    self.device = torch.device("cpu")
                model = AesMultiOutput.from_pretrained(repo, revision=revision)
                model.to(self.device)
                model.eval()
                self.model = model

        return PinnedPredictor(checkpoint_pth=None, data_col="path")

    def score(self, take: Take) -> Mapping[str, object]:
        import torch

        # Hand it the samples: given a path it loads through torchaudio, which now needs
        # torchcodec (not in the extra). AGT-1683 found this on the first real perform.
        audio, sr = _load_mono(take.audio)
        result = self.model().forward([{"path": torch.from_numpy(audio)[None], "sample_rate": sr}])  # type: ignore[attr-defined]
        return {"pq": round(float(result[0]["PQ"]), 3)}


class DnsmosScorer(_Lazy):
    info = DNSMOS

    def _load(self) -> object:
        from speechmos import dnsmos

        return dnsmos

    def score(self, take: Take) -> Mapping[str, object]:
        audio, sr = _load_mono(take.audio)
        # Non-personalised DNSMOS on 16 kHz audio; the ONNX models ship inside the package.
        out = self.model().run(_resample(audio, sr, SR_16K), sr=SR_16K)  # type: ignore[attr-defined]
        return {"bak": round(float(out["bak_mos"]), 3), "ovrl": round(float(out["ovrl_mos"]), 3)}


class EmotionScorer(_Lazy):
    info = EMOTION

    def _load(self) -> object:
        from funasr import AutoModel

        # funasr's `hub="hf"` download ignores `model_revision` (it calls snapshot_download(model)),
        # so pin at the snapshot; a local path is loaded as is.
        path = _snapshot(self.info.weights, _revision(self.info))
        return AutoModel(model=path, hub="hf", device="cpu", disable_update=True)

    def score(self, take: Take) -> Mapping[str, object]:
        result = self.model().generate(str(take.audio), granularity="utterance", extract_embedding=False)  # type: ignore[attr-defined]
        labels, scores = result[0]["labels"], result[0]["scores"]
        ranked = sorted(zip(scores, labels), reverse=True)[:2]
        # Labels are bilingual ("开心/happy"); keep the English half.
        return {"emotion_top2": [str(label).split("/")[-1] for _, label in ranked]}


ScorerFactory = Callable[[], Sequence[Scorer]]


def real_scorers() -> list[Scorer]:
    """The production stack, in `SCORERS` order. Nothing loads until a scorer scores."""
    return [WhisperScorer(), AlignerScorer(), EcapaScorer(), UtmosScorer(), AudioboxScorer(), DnsmosScorer(), EmotionScorer()]
