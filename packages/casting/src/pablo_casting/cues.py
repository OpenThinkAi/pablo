"""The cue library: content-addressed SFX, BED and MUSIC assets (AGT-1684).

A cue is a line of the script's `[SFX: ...]`, `[BED: ...]` or `[MUSIC: ...]`.
Its asset is addressed by what it is, not where it was used:

    key = sha256(canonical JSON of {cue_version, kind, desc})   desc: whitespace
                                                                 collapsed, case folded
    <root>/<key>.wav     mono float WAV at 44.1 kHz, written once, never modified
    <root>/<key>.json    kind, the description as first written, generator, seed,
                         seconds (written before the WAV, so a WAV is always complete)

The same description therefore resolves to the same file in every episode and
every work that shares the library root (the design's "the mixer treats cue
assets as content-addressed files so the generator can be swapped later without
touching takes"): `ensure` generates on a miss and only reads on a hit. A
swapped generator affects only descriptions nobody has generated yet; an
existing asset is never regenerated or overwritten.

Generators (`CueGenerator`) are built lazily per kind, so a library whose cues
are all present loads no model:

- `MUSIC`: the synthesized tonewheel organ (`organ.py`; Stable Audio's "organ"
  came out as high ringing in the prototype);
- `SFX` (4 s) and `BED` (20 s): Stable Audio Open 1.0 through `diffusers`, on
  MPS when present, with the prototype's patch for the BrownianTree noise
  sampler (it recurses until it crashes on MPS; its increments are unit
  Gaussian anyway, so fresh noise per step is the ancestral equivalent). The
  `mix` extra (`diffusers`, `torch`) is imported only when one is needed.

Nothing here knows an episode, a take or a manifest.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import numpy as np

from pablo_casting.audio import file_sha256, read_audio, resample, write_wav
from pablo_casting.receipts import now
from pablo_casting.takes import canonical_json

CUE_VERSION = 1
CUE_RATE = 44_100
KINDS = ("SFX", "BED", "MUSIC")
SECONDS = {"SFX": 4.0, "BED": 20.0, "MUSIC": 8.0}
"""Stable Audio's clip length per kind; MUSIC is the organ and sets its own."""
STOP_WORDS = ("off", "out", "stop", "none")
"""A `[BED: off]` ends the running bed instead of naming a sound."""
STAGING_PREFIX = ".staging-"
SAO_MODEL = "stabilityai/stable-audio-open-1.0"
SAO_STEPS = 60
SAO_NEGATIVE = "low quality, distorted, speech, voices"
PROMPTS = {
    "SFX": "{desc}, foley sound effect, close, clean recording, no music",
    "BED": "{desc}, ambient background, steady, no music",
    "MUSIC": "{desc}, 1940s radio drama pipe organ, solo organ, mono",
}

_SPACE = re.compile(r"\s+")


class CueUnavailable(Exception):
    """A generator's dependencies are missing (the `mix` extra, sox, the weights): a refusal (exit 2)."""


def normalise_desc(desc: str) -> str:
    return _SPACE.sub(" ", desc.strip()).casefold()


def is_stop(desc: str) -> bool:
    return normalise_desc(desc) in STOP_WORDS


def cue_key(kind: str, desc: str) -> str:
    if kind not in KINDS:
        raise ValueError(f"not a cue kind: {kind!r} (one of {', '.join(KINDS)})")
    body = {"cue_version": CUE_VERSION, "kind": kind, "desc": normalise_desc(desc)}
    return hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()


def cue_seed(key: str) -> int:
    return int(key[:8], 16)


class CueGenerator(Protocol):
    id: str

    def generate(self, kind: str, desc: str, seed: int) -> np.ndarray:
        """Mono float32 audio at `CUE_RATE`."""
        ...


GeneratorFactory = Callable[[str], CueGenerator]


@dataclass(frozen=True)
class CueAsset:
    key: str
    kind: str
    desc: str
    path: Path
    seconds: float
    generated: bool
    generator: str

    @property
    def ref(self) -> str:
        """The asset as a manifest names it, relative to the library root."""
        return f"cues/{self.key}.wav"


class CueLibrary:
    def __init__(self, root: Path, generators: GeneratorFactory) -> None:
        self.root = root
        self._factory = generators
        self._built: dict[str, CueGenerator] = {}

    def path(self, key: str) -> Path:
        return self.root / f"{key}.wav"

    def _generator(self, kind: str) -> CueGenerator:
        if kind not in self._built:
            self._built[kind] = self._factory(kind)
        return self._built[kind]

    def ensure(self, kind: str, desc: str) -> CueAsset:
        """The asset for `(kind, desc)`: read when it exists, generated and written once when it does not."""
        key = cue_key(kind, desc)
        final = self.path(key)
        if final.is_file():
            sidecar = self._sidecar(key)
            return CueAsset(
                key=key,
                kind=kind,
                desc=str(sidecar.get("desc", desc)),
                path=final,
                seconds=float(sidecar.get("seconds", 0.0)),
                generated=False,
                generator=str(sidecar.get("generator", "unknown")),
            )
        generator = self._generator(kind)
        seed = cue_seed(key)
        audio = np.asarray(generator.generate(kind, desc, seed), dtype=np.float32).reshape(-1)
        if audio.size == 0:
            raise CueUnavailable(f"the {generator.id} generator returned no audio for {kind}: {desc}")
        seconds = round(len(audio) / CUE_RATE, 3)
        self.root.mkdir(parents=True, exist_ok=True)
        ignore = self.root / ".gitignore"
        if not ignore.exists():
            ignore.write_text("# generated cue audio stays on disk, untracked; the .json sidecars say how each was made\n*.wav\n", encoding="utf-8")
        meta = {
            "key": key,
            "cue_version": CUE_VERSION,
            "kind": kind,
            "desc": desc,
            "generator": generator.id,
            "seed": seed,
            "seconds": seconds,
            "sample_rate": CUE_RATE,
            "created": now(),
        }
        stage = self.root / f"{STAGING_PREFIX}{key[:16]}-{uuid.uuid4().hex[:8]}.wav"
        write_wav(stage, audio, CUE_RATE)
        meta["sha256"] = file_sha256(stage)
        (self.root / f"{key}.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        try:
            os.link(stage, final)  # atomic, and never replaces: a racing identical cue keeps the first
            created = True
        except FileExistsError:
            created = False
        finally:
            stage.unlink()
        return CueAsset(key=key, kind=kind, desc=desc, path=final, seconds=seconds, generated=created, generator=generator.id)

    def _sidecar(self, key: str) -> dict[str, Any]:
        path = self.root / f"{key}.json"
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return raw if isinstance(raw, dict) else {}

    def load(self, asset: CueAsset) -> np.ndarray:
        """The asset's samples, mono float32 at `CUE_RATE`."""
        audio, rate = read_audio(asset.path)
        return resample(audio, rate, CUE_RATE)


# --- the real generators ---------------------------------------------------------------


class OrganGenerator:
    id = "organ/1"

    def generate(self, kind: str, desc: str, seed: int) -> np.ndarray:
        from pablo_casting.organ import SoxUnavailable, organ_cue

        try:
            return organ_cue(desc)
        except SoxUnavailable as missing:
            raise CueUnavailable(str(missing)) from missing


class StableAudioGenerator:
    """Stable Audio Open 1.0 on MPS (CPU when there is none), loaded on the first cue."""

    id = f"stable-audio-open-1.0/steps{SAO_STEPS}"

    def __init__(self) -> None:
        self._pipe: Any = None
        self._torch: Any = None

    def _load(self) -> None:
        try:
            import diffusers.schedulers.scheduling_cosine_dpmsolver_multistep as cosine
            import torch
            from diffusers import StableAudioPipeline
        except ImportError as missing:
            raise CueUnavailable(
                f"SFX and BED cues need Stable Audio Open (diffusers, torch) in the casting venv (the `mix` extra), which is not installed: {missing}"
            ) from missing

        class GaussianNoise:
            """Stand-in for torchsde's BrownianTree, which recurses until it crashes on MPS."""

            def __init__(self, x: Any, *args: object, **kwargs: object) -> None:
                self.shape, self.dtype = x.shape, x.dtype

            def __call__(self, sigma: object, sigma_next: object) -> Any:
                return torch.randn(self.shape, dtype=self.dtype)

        cosine.BrownianTreeNoiseSampler = GaussianNoise
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        try:
            self._pipe = StableAudioPipeline.from_pretrained(SAO_MODEL, torch_dtype=torch.float32).to(device)
        except OSError as missing:
            raise CueUnavailable(f"Stable Audio Open weights ({SAO_MODEL}) could not be loaded: {missing}") from missing
        self._torch = torch

    def generate(self, kind: str, desc: str, seed: int) -> np.ndarray:
        if self._pipe is None:
            self._load()
        torch = self._torch
        torch.manual_seed(seed)  # the patched sampler draws from the global CPU generator
        out = self._pipe(
            PROMPTS[kind].format(desc=desc),
            negative_prompt=SAO_NEGATIVE,
            num_inference_steps=SAO_STEPS,
            audio_end_in_s=SECONDS[kind],
            num_waveforms_per_prompt=1,
            generator=torch.Generator("cpu").manual_seed(seed),
        ).audios[0]
        audio = out.T.float().cpu().numpy().mean(axis=1)
        audio = resample(audio, int(self._pipe.vae.sampling_rate), CUE_RATE)
        audio = audio / (float(np.abs(audio).max()) + 1e-6) * 0.8
        fade = int(CUE_RATE * 0.08)
        audio[:fade] *= np.linspace(0, 1, fade, dtype=np.float32)
        audio[-fade * 4 :] *= np.linspace(1, 0, fade * 4, dtype=np.float32)
        return audio.astype(np.float32)


def real_generators() -> GeneratorFactory:
    """Organ for MUSIC; one shared Stable Audio pipeline for SFX and BED."""
    sao = StableAudioGenerator()
    organ = OrganGenerator()

    def build(kind: str) -> CueGenerator:
        return organ if kind == "MUSIC" else sao

    return build
