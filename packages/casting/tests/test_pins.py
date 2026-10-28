"""AGT-2274: every built-in model download names a pinned commit revision.

Model-free: each loader's library is replaced in `sys.modules` by a fake that
records what it was asked to fetch, so these tests check the revision each
loader passes through, and never download or load a model.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path
from typing import Any

import pytest

from pablo_casting import cues, engines, scorers
from pablo_casting.pins import PINS, is_commit, pinned
from pablo_casting.toolkit import DEFAULT_DESIGNER_MODELS, designer_revision


def fake_module(monkeypatch: pytest.MonkeyPatch, name: str, **attrs: Any) -> types.ModuleType:
    """Installs a fake module (and its parents) in `sys.modules` for this test."""
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    monkeypatch.setitem(sys.modules, name, module)
    parent, _, child = name.rpartition(".")
    if parent:
        holder = sys.modules[parent] if parent in _FAKED else fake_module(monkeypatch, parent)
        setattr(holder, child, module)
    _FAKED.add(name)
    return module


_FAKED: set[str] = set()


@pytest.fixture(autouse=True)
def _reset_faked() -> None:
    _FAKED.clear()


def fake_torch(monkeypatch: pytest.MonkeyPatch) -> None:
    torch = fake_module(monkeypatch, "torch", device=lambda name: f"device:{name}", float32="float32")
    torch.cuda = types.SimpleNamespace(is_available=lambda: False)  # type: ignore[attr-defined]
    torch.backends = types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: False))  # type: ignore[attr-defined]


# --- the registry ---------------------------------------------------------------


def test_every_pin_is_a_full_commit_sha() -> None:
    assert PINS, "pins.py lists no models"
    for repo, revision in PINS.items():
        assert is_commit(revision), f"{repo} is pinned to {revision!r}, not a 40-hex commit"


def test_every_hub_scorer_and_default_designer_and_engine_has_a_pin() -> None:
    for info in scorers.SCORERS:
        if info.name == "dnsmos":
            continue  # its ONNX files ship inside the speechmos wheel, which uv.lock hashes
        assert info.revision is not None and is_commit(info.revision), info.name
    for repo in DEFAULT_DESIGNER_MODELS.values():
        assert is_commit(pinned(repo))
    for spec in (engines.TURBO, engines.DIA, engines.CHATTERBOX):
        assert spec.revision == pinned(spec.repo)
    assert cues.SAO_REVISION == pinned(cues.SAO_MODEL)


def test_is_commit_refuses_branches_and_short_shas() -> None:
    assert not is_commit("main")
    assert not is_commit("v1.2.0")
    assert not is_commit(PINS["tarepan/SpeechMOS"][:12])


# --- each scorer loader ---------------------------------------------------------------


def test_whisper_loads_from_the_pinned_snapshot(monkeypatch: pytest.MonkeyPatch) -> None:
    asked: list[tuple[str, str]] = []
    monkeypatch.setattr(scorers, "_snapshot", lambda repo, revision: asked.append((repo, revision)) or "/snap/whisper")
    transcribed: dict[str, object] = {}

    def transcribe(audio: object, **kwargs: object) -> dict[str, object]:
        transcribed.update(kwargs)
        return {"segments": []}

    fake_module(monkeypatch, "mlx_whisper", transcribe=transcribe)
    monkeypatch.setattr(scorers, "_load_mono", lambda path: ([0.0] * 16000, 16000))
    monkeypatch.setattr(scorers, "_resample", lambda audio, sr, target: audio)
    scorer = scorers.WhisperScorer()
    scorer.score(scorers.Take(audio=Path("take.wav"), line="hello", seconds=1.0))
    assert asked == [("mlx-community/whisper-large-v3-turbo", pinned("mlx-community/whisper-large-v3-turbo"))]
    assert transcribed["path_or_hf_repo"] == "/snap/whisper"


def test_aligner_passes_the_revision_to_mlx_audio(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, dict[str, object]]] = []
    fake_module(monkeypatch, "mlx_audio.stt.utils", load=lambda path, **kwargs: calls.append((path, kwargs)) or object())
    scorers.AlignerScorer().model()
    assert calls == [("mlx-community/Qwen3-ForcedAligner-0.6B-bf16", {"revision": pinned("mlx-community/Qwen3-ForcedAligner-0.6B-bf16")})]


def test_ecapa_passes_the_revision_in_speechbrain_fetch_config(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []

    class FetchConfig:
        def __init__(self, revision: str | None = None) -> None:
            self.revision = revision

    class EncoderClassifier:
        @classmethod
        def from_hparams(cls, **kwargs: object) -> object:
            calls.append(kwargs)
            return object()

    fake_module(monkeypatch, "speechbrain.utils.fetching", FetchConfig=FetchConfig)
    fake_module(monkeypatch, "speechbrain.inference.speaker", EncoderClassifier=EncoderClassifier)
    scorers.EcapaScorer().model()
    assert len(calls) == 1
    assert calls[0]["source"] == "speechbrain/spkrec-ecapa-voxceleb"
    assert calls[0]["fetch_config"].revision == pinned("speechbrain/spkrec-ecapa-voxceleb")  # type: ignore[attr-defined]


def test_utmos_loads_torch_hub_at_the_pinned_commit(monkeypatch: pytest.MonkeyPatch) -> None:
    loads: list[str] = []

    class Model:
        def eval(self) -> Model:
            return self

    fake_torch(monkeypatch)
    sys.modules["torch"].hub = types.SimpleNamespace(load=lambda ref, *args, **kwargs: loads.append(ref) or Model())  # type: ignore[attr-defined]
    scorers.UtmosScorer().model()
    assert loads == [f"tarepan/SpeechMOS:{pinned('tarepan/SpeechMOS')}"]


def test_audiobox_loads_the_pinned_revision(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, dict[str, object]]] = []

    class Model:
        def to(self, device: object) -> Model:
            return self

        def eval(self) -> Model:
            return self

    class AesMultiOutput:
        @classmethod
        def from_pretrained(cls, repo: str, **kwargs: object) -> Model:
            calls.append((repo, kwargs))
            return Model()

    class AesPredictor:
        # The library's shape: a dataclass whose __post_init__ calls setup_model.
        def __init__(self, checkpoint_pth: str | None, data_col: str = "path") -> None:
            self.checkpoint_pth = checkpoint_pth
            self.setup_model()

        def setup_model(self) -> None:  # the unpinned original
            raise AssertionError("the library's own setup_model fetches the Hub's current revision")

    fake_torch(monkeypatch)
    fake_module(monkeypatch, "audiobox_aesthetics.model.aes", AesMultiOutput=AesMultiOutput)
    fake_module(monkeypatch, "audiobox_aesthetics.infer", AesPredictor=AesPredictor)
    predictor = scorers.AudioboxScorer().model()
    assert calls == [("facebook/audiobox-aesthetics", {"revision": pinned("facebook/audiobox-aesthetics")})]
    assert isinstance(predictor.model, Model)  # type: ignore[attr-defined]


def test_emotion2vec_loads_from_the_pinned_snapshot(monkeypatch: pytest.MonkeyPatch) -> None:
    asked: list[tuple[str, str]] = []
    built: list[dict[str, object]] = []
    monkeypatch.setattr(scorers, "_snapshot", lambda repo, revision: asked.append((repo, revision)) or "/snap/emotion")
    fake_module(monkeypatch, "funasr", AutoModel=lambda **kwargs: built.append(kwargs) or object())
    scorers.EmotionScorer().model()
    assert asked == [("emotion2vec/emotion2vec_plus_large", pinned("emotion2vec/emotion2vec_plus_large"))]
    assert built[0]["model"] == "/snap/emotion"


def test_snapshot_passes_the_revision_to_huggingface_hub(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []
    fake_module(monkeypatch, "huggingface_hub", snapshot_download=lambda **kwargs: calls.append(kwargs) or "/snap")
    assert scorers._snapshot("org/name", "a" * 40) == "/snap"
    assert calls == [{"repo_id": "org/name", "revision": "a" * 40}]


# --- the cue model and the designers ---------------------------------------------------


def test_stable_audio_open_loads_at_its_pinned_revision(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, dict[str, object]]] = []

    class Pipe:
        def to(self, device: object) -> Pipe:
            return self

    class StableAudioPipeline:
        @classmethod
        def from_pretrained(cls, repo: str, **kwargs: object) -> Pipe:
            calls.append((repo, kwargs))
            return Pipe()

    fake_torch(monkeypatch)
    fake_module(monkeypatch, "diffusers", StableAudioPipeline=StableAudioPipeline)
    fake_module(monkeypatch, "diffusers.schedulers.scheduling_cosine_dpmsolver_multistep")
    cues.StableAudioGenerator()._load()
    assert calls == [("stabilityai/stable-audio-open-1.0", {"revision": pinned("stabilityai/stable-audio-open-1.0"), "torch_dtype": "float32"})]


def test_default_designers_are_pinned_and_an_override_carries_its_own_revision() -> None:
    assert designer_revision("qwen3", {}) == pinned(DEFAULT_DESIGNER_MODELS["qwen3"])
    assert designer_revision("voxcpm2", {}) == pinned(DEFAULT_DESIGNER_MODELS["voxcpm2"])
    named = {"designers": {"qwen3": {"model": "org/other", "revision": "b" * 40}, "voxcpm2": {"model": "org/loose"}}}
    assert designer_revision("qwen3", named) == "b" * 40
    assert designer_revision("voxcpm2", named) is None


def test_real_designer_passes_the_revision_and_warns_when_an_override_has_none(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from pablo_casting.real import real_toolkit

    loads: list[tuple[str, dict[str, object]]] = []
    fake_module(monkeypatch, "mlx_audio.tts.utils", load_model=lambda path, **kwargs: loads.append((path, kwargs)) or object())
    fake_module(monkeypatch, "mlx.core")
    toolkit = real_toolkit({}, {"designers": {"voxcpm2": {"model": "org/loose"}}})
    toolkit.designer("qwen3")
    assert capsys.readouterr().err == ""
    toolkit.designer("voxcpm2")
    assert loads == [
        (DEFAULT_DESIGNER_MODELS["qwen3"], {"revision": pinned(DEFAULT_DESIGNER_MODELS["qwen3"])}),
        ("org/loose", {}),
    ]
    assert "designer voxcpm2 model org/loose has no `revision`" in capsys.readouterr().err
