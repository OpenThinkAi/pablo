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

**Real recordings first (AGT-1799).** With a sound library (`sounds.py`), an
SFX or BED cue whose description matches a curated CC0 recording is built from
that recording, and only an unmatched one goes to the generator. Its key then
also names the recording (`cue_key(kind, desc, sound)`), so adding a better
recording later makes a new asset instead of changing an old one, and a "swap
cue" (`ensure(..., sound=ID)`) is just another key. The sidecar records the
recording's provenance (source URL, licence, author), the match (score, the
words that matched, the alternatives) and, for a rhythmic bed, the loop
(`sounds.rhythm_loop`): the asset is then the recording regularised onto its
tick grid, and the mix loops it at its period instead of chopping it.

**Loudness (AGT-1786).** Every asset is measured once (integrated LUFS and
peak, cached in its sidecar; an older sidecar gets them on first load) and
every load brings it to its kind's target (`loudness.py`) before any mix gain,
so the auto mix's gains and a document's clip gains are offsets from one
consistent level. The WAV itself is never modified.

Nothing here knows an episode, a take or a manifest.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import numpy as np

from pablo_casting.audio import file_sha256, read_audio, resample, write_wav
from pablo_casting.loudness import DEFAULT_TARGETS, PEAK_CEILING, PEAK_CEILINGS, integrated_lufs, normalisation
from pablo_casting.pins import pinned
from pablo_casting.receipts import now
from pablo_casting.sounds import Match, SoundLibrary, rhythm_loop
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
SAO_REVISION = pinned(SAO_MODEL)
"""The commit Stable Audio Open is fetched at (`pins.py`, AGT-2274)."""
SAO_STEPS = 60
SAO_NEGATIVE = "low quality, distorted, speech, voices"
PROMPTS = {
    "SFX": "{desc}, foley sound effect, close, clean recording, no music",
    "BED": "{desc}, ambient background, steady, no music",
    "MUSIC": "{desc}, 1940s radio drama pipe organ, solo organ, mono",
}

SOUND_GENERATOR = "sound-library"
SFX_MAX_SECONDS = 5.0
"""A recording is often longer than a cue should be: an SFX holds the dialogue for its whole length."""
BED_MAX_SECONDS = 120.0
SFX_TAIL_FADE = 0.25
EDGE_FADE = 0.005

_SPACE = re.compile(r"\s+")


class CueUnavailable(Exception):
    """A generator's dependencies are missing (the `mix` extra, sox, the weights): a refusal (exit 2)."""


def normalise_desc(desc: str) -> str:
    return _SPACE.sub(" ", desc.strip()).casefold()


def is_stop(desc: str) -> bool:
    return normalise_desc(desc) in STOP_WORDS


def cue_key(kind: str, desc: str, sound: str | None = None) -> str:
    """The asset's address: `(kind, desc)` for a generated cue, `(kind, desc, sound)` for one built from a recording."""
    if kind not in KINDS:
        raise ValueError(f"not a cue kind: {kind!r} (one of {', '.join(KINDS)})")
    body: dict[str, object] = {"cue_version": CUE_VERSION, "kind": kind, "desc": normalise_desc(desc)}
    if sound is not None:
        body["sound"] = sound
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
    loop: tuple[int, int, int] | None = None
    """A rhythmic bed's loop `(start, length, xfade)` in samples (`sounds.Loop`); None for everything else."""
    sound: str | None = None
    """The recording it was built from (a sound library id), or None when generated."""

    @property
    def ref(self) -> str:
        """The asset as a manifest names it, relative to the library root."""
        return f"cues/{self.key}.wav"


def _loop(sidecar: Mapping[str, Any]) -> tuple[int, int, int] | None:
    raw = sidecar.get("loop")
    if isinstance(raw, Mapping) and all(isinstance(raw.get(k), int) for k in ("start", "length", "xfade")):
        return int(raw["start"]), int(raw["length"]), int(raw["xfade"])
    return None


def _first_sound(audio: np.ndarray, rate: int) -> int:
    """The first sample within 40 dB of the peak, less 20 ms: a recording's leading silence is not part of the cue."""
    peak = float(np.abs(audio).max()) if len(audio) else 0.0
    if peak <= 0:
        return 0
    loud = np.flatnonzero(np.abs(audio) >= peak * 0.01)
    return max(0, int(loud[0]) - int(0.02 * rate)) if len(loud) else 0


def _quietest(audio: np.ndarray, lo: int, hi: int, window: int) -> int:
    """The end of the quietest `window` in `[lo, hi)`: where a long recording is cut."""
    if hi - lo <= window:
        return hi
    energy = np.convolve(audio[lo:hi].astype(np.float64) ** 2, np.ones(window), mode="valid")
    return lo + int(np.argmin(energy)) + window


def _fade(audio: np.ndarray, head: int, tail: int) -> np.ndarray:
    out = audio.astype(np.float32, copy=True)
    if head:
        out[:head] *= np.linspace(0, 1, head, dtype=np.float32)
    if tail:
        out[-tail:] *= np.linspace(1, 0, tail, dtype=np.float32)
    return out


class CueLibrary:
    def __init__(
        self,
        root: Path,
        generators: GeneratorFactory,
        sounds: SoundLibrary | None = None,
        targets: Mapping[str, float] | None = None,
    ) -> None:
        self.root = root
        self.sounds = sounds
        self.targets = dict(DEFAULT_TARGETS if targets is None else targets)
        self._factory = generators
        self._built: dict[str, CueGenerator] = {}

    def path(self, key: str) -> Path:
        return self.root / f"{key}.wav"

    def _generator(self, kind: str) -> CueGenerator:
        if kind not in self._built:
            self._built[kind] = self._factory(kind)
        return self._built[kind]

    def matches(self, kind: str, desc: str) -> list[Match]:
        """Every recording that could voice `(kind, desc)`, best first (a swap picks from these)."""
        if self.sounds is None or kind not in ("SFX", "BED"):
            return []
        return self.sounds.matches(kind, desc, cue_key(kind, desc))

    def resolve(self, kind: str, desc: str, sound: str | None = None, *, generated: bool = False) -> tuple[str, Match | None, list[Match]]:
        """`(key, the recording it is built from or None, every candidate)` for a cue, without making it.

        `sound` picks a recording (a swap); `generated` asks for the generator's asset even when a recording matches
        (what an older mix document that placed a generated cue still names).
        """
        found = self.matches(kind, desc)
        if generated:
            return cue_key(kind, desc), None, found
        if sound is not None:
            chosen = next((m for m in found if m.sound.id == sound), None)
            if chosen is None:
                picked = self.sounds.get(sound) if self.sounds is not None else None
                if picked is None or kind not in picked.kinds:
                    raise CueUnavailable(f"no {kind} recording {sound!r} in the sound library")
                chosen = Match(picked, 0, (), ())
            return cue_key(kind, desc, chosen.sound.id), chosen, found
        if found:
            return cue_key(kind, desc, found[0].sound.id), found[0], found
        return cue_key(kind, desc), None, found

    def ensure(self, kind: str, desc: str, sound: str | None = None, *, generated: bool = False) -> CueAsset:
        """The asset for `(kind, desc)`: read when it exists, made and written once when it does not.

        Made from the best-matching recording when the sound library has one (or
        from `sound`, a swap), else (or with `generated`) by the kind's generator.
        """
        key, match, found = self.resolve(kind, desc, sound, generated=generated)
        final = self.path(key)
        if final.is_file():
            sidecar = self.sidecar(key)
            provenance = sidecar.get("sound")
            return CueAsset(
                key=key,
                kind=kind,
                desc=str(sidecar.get("desc", desc)),
                path=final,
                seconds=float(sidecar.get("seconds", 0.0)),
                generated=False,
                generator=str(sidecar.get("generator", "unknown")),
                loop=_loop(sidecar),
                sound=str(provenance.get("id")) if isinstance(provenance, Mapping) else None,
            )
        extra: dict[str, object] = {}
        seed: int | None = None
        if match is not None:
            audio, extra = self._from_sound(kind, match, found, chosen=sound is not None)
            generator_id = SOUND_GENERATOR
        else:
            generator = self._generator(kind)
            generator_id = generator.id
            seed = cue_seed(key)
            audio = np.asarray(generator.generate(kind, desc, seed), dtype=np.float32).reshape(-1)
        if audio.size == 0:
            raise CueUnavailable(f"the {generator_id} generator returned no audio for {kind}: {desc}")
        seconds = round(len(audio) / CUE_RATE, 3)
        self.root.mkdir(parents=True, exist_ok=True)
        ignore = self.root / ".gitignore"
        if not ignore.exists():
            ignore.write_text("# generated cue audio stays on disk, untracked; the .json sidecars say how each was made\n*.wav\n", encoding="utf-8")
        meta: dict[str, object] = {
            "key": key,
            "cue_version": CUE_VERSION,
            "kind": kind,
            "desc": desc,
            "generator": generator_id,
            **({"seed": seed} if seed is not None else {}),
            **extra,
            "seconds": seconds,
            "sample_rate": CUE_RATE,
            "loudness": self._measure(audio),
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
        return CueAsset(
            key=key,
            kind=kind,
            desc=desc,
            path=final,
            seconds=seconds,
            generated=created,
            generator=generator_id,
            loop=_loop(meta),
            sound=match.sound.id if match is not None else None,
        )

    def _from_sound(self, kind: str, match: Match, found: list[Match], *, chosen: bool) -> tuple[np.ndarray, dict[str, object]]:
        """A recording made into a cue: mono at `CUE_RATE`; a rhythmic bed regularised into its loop, anything else excerpted."""
        sound = match.sound
        raw, rate = read_audio(sound.path)
        audio = resample(raw, rate, CUE_RATE)
        extra: dict[str, object] = {
            "sound": sound.provenance(),
            "match": {**match.as_body(), "chosen": chosen, "alternatives": [m.sound.id for m in found if m.sound.id != sound.id]},
        }
        if kind == "BED" and sound.rhythmic:
            looped = rhythm_loop(audio, CUE_RATE)
            if looped is not None:
                regular, loop = looped
                extra["loop"] = loop.as_body()
                return regular, extra
            extra["loop"] = None
            extra["rhythm"] = "no steady tick found: mixed as an ordinary bed"
        if sound.excerpt is not None:
            lo, hi = int(sound.excerpt[0] * CUE_RATE), min(len(audio), int(sound.excerpt[1] * CUE_RATE))
        else:
            lo = _first_sound(audio, CUE_RATE) if kind == "SFX" else 0
            longest = int((SFX_MAX_SECONDS if kind == "SFX" else BED_MAX_SECONDS) * CUE_RATE)
            hi = len(audio)
            if hi - lo > longest:
                end = lo + longest
                hi = _quietest(audio, lo + longest // 2, end, int(0.05 * CUE_RATE)) if kind == "SFX" else end
        cut = audio[lo:hi]
        extra["excerpt"] = [round(lo / CUE_RATE, 3), round(hi / CUE_RATE, 3)]
        tail = int((SFX_TAIL_FADE if hi < len(audio) else EDGE_FADE) * CUE_RATE)
        return _fade(cut, int(EDGE_FADE * CUE_RATE), min(tail, len(cut) // 4)), extra

    @staticmethod
    def _measure(audio: np.ndarray) -> dict[str, float]:
        lufs = integrated_lufs(audio, CUE_RATE)
        return {"lufs": round(lufs, 3) if np.isfinite(lufs) else -99.0, "peak": round(float(np.abs(audio).max()) if len(audio) else 0.0, 6)}

    def sidecar(self, key: str) -> dict[str, Any]:
        """The asset's `.json` (empty when there is none or it is unreadable)."""
        path = self.root / f"{key}.json"
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return raw if isinstance(raw, dict) else {}

    def _loudness(self, key: str, sidecar: Mapping[str, Any], audio: np.ndarray) -> Mapping[str, Any]:
        """The asset's measured loudness: from its sidecar, else measured now and cached there (the WAV is never touched)."""
        cached = sidecar.get("loudness")
        if isinstance(cached, Mapping) and isinstance(cached.get("lufs"), (int, float)) and isinstance(cached.get("peak"), (int, float)):
            return cached
        measured = self._measure(audio)
        if sidecar:
            stage = self.root / f"{STAGING_PREFIX}{key[:16]}-{uuid.uuid4().hex[:8]}.json"
            try:
                stage.write_text(json.dumps({**sidecar, "loudness": measured}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
                os.replace(stage, self.root / f"{key}.json")
            except OSError:
                stage.unlink(missing_ok=True)
        return measured

    def load_key(self, key: str) -> np.ndarray | None:
        """The asset's samples, mono float32 at `CUE_RATE`, brought to its kind's loudness target; None when it is not here.

        An asset with no sidecar (or no kind in it) cannot be placed against a target and plays as written.
        """
        path = self.path(key)
        if not path.is_file():
            return None
        audio, rate = read_audio(path)
        audio = resample(audio, rate, CUE_RATE)
        sidecar = self.sidecar(key)
        target = self.targets.get(str(sidecar.get("kind", "")))
        if target is None:
            return audio
        measured = self._loudness(key, sidecar, audio)
        kind = str(sidecar.get("kind", ""))
        gain = normalisation(float(measured["lufs"]), float(measured["peak"]), target, PEAK_CEILINGS.get(kind, PEAK_CEILING))
        return (audio * np.float32(10 ** (gain.gain_db / 20))).astype(np.float32)

    def load(self, asset: CueAsset) -> np.ndarray:
        """The asset's samples, mono float32 at `CUE_RATE`, at its kind's loudness target."""
        audio = self.load_key(asset.key)
        if audio is None:
            raise CueUnavailable(f"cue {asset.key[:12]}... is missing from {self.root}")
        return audio


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
            self._pipe = StableAudioPipeline.from_pretrained(SAO_MODEL, revision=SAO_REVISION, torch_dtype=torch.float32).to(device)
        except OSError as missing:
            raise CueUnavailable(f"Stable Audio Open weights ({SAO_MODEL}@{SAO_REVISION[:12]}) could not be loaded: {missing}") from missing
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
