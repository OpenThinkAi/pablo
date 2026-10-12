"""Performance engines: the decided engine's adapter, the Dia baseline, and pass grouping (AGT-1683).

The engine decision (bake-off AGT-1677, `pm project show pablo-casting --doc
bake-off`, section 6) is **Chatterbox-Turbo**, `mlx-community/chatterbox-turbo-fp16`
at revision `b2d0a13aa7cf`, MIT/MIT, one line per take, no batching:

- `temperature` 0.8 on every take;
- **no emotion or intensity mapping**: Turbo takes text only, so a direction
  shapes this engine through its pace (a stretch after the take, below), never
  through a parameter;
- non-verbals become Turbo's tags: `(laughs)` -> `[laugh]`, `(coughs)` ->
  `[cough]`, `(chuckles)` -> `[chuckle]`; the other non-verbals the script
  grammar allows (`(sighs)`, `(gasps)`, ...) are left out of the engine input,
  because Turbo would read them aloud as words (the script keeps them);
- the reference must be longer than 5 s (Turbo asserts it): a shorter one is
  zero-padded to 5.2 s and the pad is a recorded param (the 20-30 s cast cards
  never need it);
- pace is not an engine control: the take is rendered at the voice's own pace
  and the needed stretch is measured and applied after (`perform.py`).

**Dramatic scenes** (AGT-1888): the lines inside a script's `[DRAMA]` ...
`[DRAMA: off]` scene render through the original Chatterbox
(`mlx-community/Chatterbox-TTS-fp16`), `DRAMA_ENGINE`, which Turbo lacks an
emotion control for. Matt A/B'd an accident scene by ear (2026-10-12) and
picked it at exaggeration 0.5, cfg_weight 0.5, temperature 0.8, fixed for every
dramatic line (no direction mapping, like Turbo). It takes the same reference
handling as Turbo (resampled to the model's rate, padded to 5.2 s when short)
and the same treatment of non-verbals: the ones in `CHATTERBOX_TAGS` become its
tags, the rest are left out of the engine input (today that is all of them, so
"(gasps)" is never read aloud; the script keeps them). Unlike Turbo it copies the
loudness of the reference it clones, so a hot cast reference (peak 1.00, RMS 0.23)
came out clipped inside the model (AGT-1900): its reference is levelled to
`CHATTERBOX_REF_RMS` with its peak capped at `CHATTERBOX_REF_PEAK` before
conditioning (`level_reference`, before the pad), and both are recorded params.
Turbo and Dia references are never levelled. Its own adapter id and params
are in the take key, so a dramatic take never collides with a Turbo one, and
an episode without a scene keeps every key it had. It is not an `--engine`
choice: it voices scenes inside an episode performed by another.

Dia stays selectable (`--engine dia`) with the radio prototype's settings and
its pass grouping (`radio/produce.py`: up to two alternating speakers and about
40 words per pass, a throwaway `Mm.` from the other voice on the end), for A/B
against old renders only.

**ALL-CAPS words** (two or more letters, e.g. a title like `THE VALLEY'S
SHADOW`) reach every engine capitalised (`The Valley's Shadow`). The script
text is never changed; only the engine input is. Evidence (AGT-1677, Matt
2026-10-11): Turbo said "Shadow" right in 4 of 12 takes from caps and 12 of 12
title-cased; ZONOS2 spelled caps letter by letter.

**Numerals and respellings.** Numerals reach every engine spelled out
(`numerals.py`, AGT-1789): years as said ("1917" -> "nineteen seventeen"),
other numbers as words; the script keeps its digits. AGT-1798 adds the work's
pronunciation lexicon (`outputs/radio/pronounce.md`, `lexicon.py`), which
respells words in the engine input only; the entries a pass uses are its
`lexicon` param, so they are in the take key and an unused entry changes no
key. Turbo needs no length cap of its own: mlx-audio already splits its input
at sentence boundaries into chunks of at most 800 speech tokens (about 32 s),
far beyond any script line.

An adapter turns a pass's script lines (and their directions) into the params
that change the audio, which go into the take key, and the text the engine
reads, which is derived from the key's own lines, so the key always says
everything the audio depends on. `ADAPTER_VERSION` is part of the params:
changing what an adapter sends an engine changes every key with it.

Nothing here imports a model stack at module load. The real engines import
`mlx`, `mlx_audio` and `huggingface_hub` when they load, from the `scorers`
extra the perform verb provisions; the default tests use `RecordingEngine`.
"""

from __future__ import annotations

import re
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from importlib.metadata import PackageNotFoundError, version as dist_version
from pathlib import Path
from typing import Protocol

import numpy as np

from pablo_casting.directions import NONVERBALS
from pablo_casting.lexicon import PARAM as LEXICON_PARAM, Entry, apply as apply_lexicon, params_for as lexicon_params
from pablo_casting.numerals import spell_numbers
from pablo_casting.takes import EngineId, Synthesis, TakeInputs
from pablo_casting.wav import Audio

ADAPTER_VERSION = 2  # 2: numerals spelled out for the engine (AGT-1789)

# --- text: caps and non-verbals -------------------------------------------------

_CAPS_WORD = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)*")


def normalise_caps(text: str) -> str:
    """ALL-CAPS words of two or more letters -> capitalised (`THE VALLEY'S` -> `The Valley's`).

    A word is a run of letters, with inner apostrophes. Single letters (`I`, `A`)
    and mixed-case words (`McDonald`) are left alone.
    """

    def fix(match: re.Match[str]) -> str:
        word = match.group(0)
        letters = [c for c in word if c.isalpha()]
        if len(letters) < 2 or not all(c.isupper() for c in letters):
            return word
        return word[0] + word[1:].lower()

    return _CAPS_WORD.sub(fix, text)


_PAREN = re.compile(r"\(([^)]*)\)")
_SPACE = re.compile(r"\s+")

TURBO_TAGS: dict[str, str] = {"laughs": "[laugh]", "coughs": "[cough]", "chuckles": "[chuckle]", "chuckle": "[chuckle]"}
# The original Chatterbox documents no tags. Its tokenizer lists some (`[sigh]`, `[gasp]`,
# `[laughter]`), but a probe (AGT-1888, cora card, two seeds each) heard them as a stray word
# ("Shull", "She") in 2 of 6 takes, so every non-verbal is left out of its input.
CHATTERBOX_TAGS: dict[str, str] = {}


def read_text(text: str, speaker: str = "", lexicon: object = None) -> str:
    """Numerals spoken, caps normalised, then the work's respellings (after caps, so `zin-fan-DELL` keeps its capitals)."""
    return apply_lexicon(lexicon, speaker, normalise_caps(spell_numbers(text)))


def tagged_text(text: str, tags: Mapping[str, str], speaker: str = "", lexicon: object = None) -> str:
    """A script line as a tag-reading engine takes it: numerals spoken, caps normalised, respelt, the non-verbals in `tags` as tags, the others left out."""

    def tag(match: re.Match[str]) -> str:
        inner = _SPACE.sub(" ", match.group(1).strip().lower())
        if inner in tags:
            return tags[inner]
        return "" if inner in NONVERBALS else match.group(0)

    return _SPACE.sub(" ", _PAREN.sub(tag, read_text(text, speaker, lexicon))).strip()


def turbo_text(text: str, speaker: str = "", lexicon: object = None) -> str:
    """What Turbo reads for a script line: numerals spoken, caps normalised, respelt, its three tags, other non-verbals left out."""
    return tagged_text(text, TURBO_TAGS, speaker, lexicon)


def chatterbox_text(text: str, speaker: str = "", lexicon: object = None) -> str:
    """What the original Chatterbox reads for a script line: as Turbo, with `CHATTERBOX_TAGS`."""
    return tagged_text(text, CHATTERBOX_TAGS, speaker, lexicon)


def dia_text(turns: Sequence[tuple[str, str]], tags: Mapping[str, str], lexicon: object = None) -> str:
    """Dia's pass text: `[S1] words [S2] words [other] Mm.` (the prototype's throwaway word, trimmed after)."""
    last = turns[-1][0]
    other = "[S2]" if tags[last] == "[S1]" else "[S1]"
    body = " ".join(f"{tags[speaker]} {read_text(words, speaker, lexicon)}" for speaker, words in turns)
    return f"{body} {other} Mm."


# --- passes -------------------------------------------------------------------------


@dataclass(frozen=True)
class PassLine:
    """One script line inside a pass: its index among the episode's spoken lines, speaker, text, and whether it is in a `[DRAMA]` scene."""

    i: int
    speaker: str
    text: str
    drama: bool = False


@dataclass(frozen=True)
class Pass:
    """One engine pass: the lines it voices. A real cloner voices one line per pass."""

    lines: tuple[PassLine, ...]

    @property
    def speakers(self) -> list[str]:
        return list(dict.fromkeys(line.speaker for line in self.lines))

    def turns(self) -> list[tuple[str, str]]:
        """Consecutive lines by one speaker joined into one turn."""
        out: list[tuple[str, str]] = []
        for line in self.lines:
            if out and out[-1][0] == line.speaker:
                out[-1] = (line.speaker, f"{out[-1][1]} {line.text}")
            else:
                out.append((line.speaker, line.text))
        return out


DIA_PASS_WORDS = 40  # the prototype: Dia sounds best on 5-20 seconds per pass


def _words(text: str) -> int:
    return len(text.split())


def group_lines(runs: Sequence[Sequence[PassLine]]) -> list[Pass]:
    """One pass per line: the grouping every real cloner uses (flags map one-to-one)."""
    return [Pass((line,)) for run in runs for line in run]


def group_dia(runs: Sequence[Sequence[PassLine]], limit: int = DIA_PASS_WORDS) -> list[Pass]:
    """The prototype's Dia grouping (`produce.py` `render`/`flush`), within each run of lines between cues.

    Consecutive lines by one speaker merge into one turn while it stays within
    `limit` words; a pass holds at most two turns by two different speakers,
    within `limit` words in all.
    """
    passes: list[Pass] = []
    for run in runs:
        turns: list[list[PassLine]] = []
        for line in run:
            if turns and turns[-1][0].speaker == line.speaker and sum(_words(x.text) for x in turns[-1]) + _words(line.text) <= limit:
                turns[-1].append(line)
            else:
                turns.append([line])
        group: list[list[PassLine]] = []
        for turn in turns:
            words = sum(_words(x.text) for t in group for x in t)
            fits = len(group) < 2 and words + sum(_words(x.text) for x in turn) <= limit and (not group or group[-1][0].speaker != turn[0].speaker)
            if group and not fits:
                passes.append(Pass(tuple(x for t in group for x in t)))
                group = []
            group.append(turn)
        if group:
            passes.append(Pass(tuple(x for t in group for x in t)))
    return passes


# --- the voices an engine clones ----------------------------------------------------


@dataclass(frozen=True)
class VoiceRef:
    """A cast card's frozen identity, as an engine needs it."""

    card_hash: str
    slug: str
    reference: Path
    transcript: str
    seconds: float


# --- engine specs and adapters ------------------------------------------------------


@dataclass(frozen=True)
class EngineSpec:
    name: str
    repo: str
    revision: str
    license: str
    grouping: str  # "line" | "dia"
    pace: str  # "stretch": the engine has no native pace control
    notes: str = ""

    def as_body(self) -> dict[str, object]:
        return {
            "name": self.name,
            "repo": self.repo,
            "revision": self.revision,
            "license": self.license,
            "grouping": self.grouping,
            "pace": self.pace,
            "adapter": f"{self.name}/{ADAPTER_VERSION}",
        }


TURBO = EngineSpec(
    name="chatterbox-turbo",
    repo="mlx-community/chatterbox-turbo-fp16",
    revision="b2d0a13aa7cfff0a06d9acb247ae91c8f19a6d75",
    license="MIT / MIT",
    grouping="line",
    pace="stretch",
    notes="the decided engine (bake-off AGT-1677)",
)
DIA = EngineSpec(
    name="dia",
    repo="mlx-community/Dia-1.6B",
    revision="de4fa8c178ca5cc4e9d884b55b03fcfaa0995162",
    license="Apache-2.0 / Apache-2.0",
    grouping="dia",
    pace="stretch",
    notes="the radio prototype's engine, for A/B against old renders only",
)
CHATTERBOX = EngineSpec(
    name="chatterbox",
    repo="mlx-community/Chatterbox-TTS-fp16",
    revision="77c7c8f9307beb5dc6c03cebc7942c4de9d617c9",
    license="MIT / MIT",
    grouping="line",
    pace="stretch",
    notes="dramatic scenes, [DRAMA] markers (AGT-1888)",
)
ENGINE_SPECS: dict[str, EngineSpec] = {TURBO.name: TURBO, DIA.name: DIA}
DEFAULT_ENGINE = TURBO.name
DRAMA_ENGINE = CHATTERBOX

TURBO_TEMPERATURE = 0.8
TURBO_MIN_REF_S = 5.2
DIA_TEMPERATURE, DIA_TOP_P, DIA_SR, DIA_REF_PAD_S = 1.1, 0.9, 44_100, 0.25
CHATTERBOX_EXAGGERATION, CHATTERBOX_CFG_WEIGHT, CHATTERBOX_TEMPERATURE = 0.5, 0.5, 0.8
# The level the original Chatterbox's reference is scaled to (AGT-1900): RMS 0.05 gave clean takes
# from a reference that clipped at 0.23; the peak cap keeps a spiky reference below full scale.
CHATTERBOX_REF_RMS, CHATTERBOX_REF_PEAK = 0.05, 0.9

# Direction -> engine parameters, per engine (design: "Per-line direction in the
# script"). Turbo maps none (text only, the bake-off's decision); neither does Dia,
# and Chatterbox holds its exaggeration fixed for every dramatic line (Matt's A/B).
# All three are paced by a stretch after the take.
DIRECTION_PARAMS: dict[str, Callable[[str | None, int | None], dict[str, object]]] = {
    TURBO.name: lambda emotion, intensity: {},
    DIA.name: lambda emotion, intensity: {},
    CHATTERBOX.name: lambda emotion, intensity: {},
}


# What a flag's reason does to a retake (`pablo fix`, AGT-1685). No engine maps a
# direction to a control, so the only levers are the sampling temperature and the
# line's pace (a stretch, applied by the mix); Chatterbox, sampling at Turbo's 0.8,
# takes Turbo's bumps:
#
# - `wrong voice`: the clone drifted from the card, so sample colder (more faithful).
# - `flat`: the read had no life, so sample hotter (more varied).
# - `rushed`: the line's pace goes one step slower (quick -> normal -> slow).
# - `clipped`, `other`, and an automatic flag's free-text reason: no bump; the retake is
#   fresh attempts (new numbers, so new derived seeds) at the same settings.
#
# When `wrong voice` and `flat` are both raised for one line, the voice wins. A bump is
# part of the take key (`temperature`, plus a `retake` param naming the reasons), so a
# retake is a new take, never the old one.
RETAKE_REASONS = ("clipped", "wrong voice", "flat", "rushed", "other")
RETAKE_TEMPERATURE: dict[str, dict[str, float]] = {
    TURBO.name: {"wrong voice": 0.65, "flat": 0.95},
    DIA.name: {"wrong voice": 0.95, "flat": 1.25},
    CHATTERBOX.name: {"wrong voice": 0.65, "flat": 0.95},
}
SLOWER = {None: "slow", "quick": None, "slow": "slow"}


def normalise_reasons(reasons: Sequence[object]) -> tuple[str, ...]:
    """The reasons that are in the player's vocabulary, lower-cased, de-duplicated, sorted."""
    found = {" ".join(str(reason).lower().split()) for reason in reasons if isinstance(reason, str)}
    return tuple(sorted(found & set(RETAKE_REASONS)))


def retake_pace(pace: str | None, reasons: Sequence[str]) -> str | None:
    """The pace a retake asks for: one step slower for `rushed`, else unchanged."""
    return SLOWER[pace] if "rushed" in reasons else pace


def adapt(
    spec: EngineSpec,
    take_pass: Pass,
    voices: Mapping[str, VoiceRef],
    emotion: str | None,
    intensity: int | None,
    reasons: Sequence[str] = (),
    lexicon: Sequence[Entry] = (),
) -> dict[str, object]:
    """The params that change a pass's audio (the take key's `params`).

    `lexicon` is the work's pronunciation entries: those matching the pass go in as `lexicon`.

    `reasons` are a flag's normalised reasons (`normalise_reasons`); with none the
    params are exactly what `perform` has always sent, so existing takes keep their keys.
    """
    params: dict[str, object] = {"adapter": f"{spec.name}/{ADAPTER_VERSION}"}
    if spec.name == TURBO.name:
        params["temperature"] = TURBO_TEMPERATURE
        voice = voices[take_pass.lines[0].speaker]
        if voice.seconds < TURBO_MIN_REF_S:
            params["ref_pad_to_s"] = TURBO_MIN_REF_S
    elif spec.name == DIA.name:
        params.update({"temperature": DIA_TEMPERATURE, "top_p": DIA_TOP_P, "ref_pad_s": DIA_REF_PAD_S, "throwaway": "Mm."})
    elif spec.name == CHATTERBOX.name:
        params.update({"temperature": CHATTERBOX_TEMPERATURE, "exaggeration": CHATTERBOX_EXAGGERATION, "cfg_weight": CHATTERBOX_CFG_WEIGHT, "ref_rms": CHATTERBOX_REF_RMS, "ref_peak_cap": CHATTERBOX_REF_PEAK})
        voice = voices[take_pass.lines[0].speaker]
        if voice.seconds < TURBO_MIN_REF_S:
            params["ref_pad_to_s"] = TURBO_MIN_REF_S
    else:
        raise KeyError(spec.name)
    params.update(DIRECTION_PARAMS[spec.name](emotion, intensity))
    for reason in ("wrong voice", "flat"):  # the voice wins when both are raised
        if reason in reasons:
            params["temperature"] = RETAKE_TEMPERATURE[spec.name][reason]
            break
    if reasons:
        params["retake"] = "+".join(reasons)
    params.update(lexicon_params(lexicon, [(line.speaker, line.text) for line in take_pass.lines]))
    return params


def engine_text(spec: EngineSpec, inputs: TakeInputs) -> str:
    """The text the engine reads, derived from the take key's own lines."""
    if spec.name == TURBO.name:
        return " ".join(turbo_text(line.text, line.speaker, inputs.params.get(LEXICON_PARAM)) for line in inputs.lines)
    if spec.name == CHATTERBOX.name:
        return " ".join(chatterbox_text(line.text, line.speaker, inputs.params.get(LEXICON_PARAM)) for line in inputs.lines)
    if spec.name == DIA.name:
        turns = Pass(tuple(PassLine(k, line.speaker, line.text) for k, line in enumerate(inputs.lines))).turns()
        speakers = list(dict.fromkeys(speaker for speaker, _ in turns))
        return dia_text(turns, dict(zip(speakers, ("[S1]", "[S2]"))), inputs.params.get(LEXICON_PARAM))
    raise KeyError(spec.name)


def level_reference(ref: np.ndarray, rms: float, peak_cap: float) -> np.ndarray:
    """Scale a reference to `rms`, scaled back if that would put its peak over `peak_cap`; silence is left alone."""
    ref = np.asarray(ref, dtype=np.float32)
    level = float(np.sqrt(np.mean(np.square(ref, dtype=np.float64)))) if ref.size else 0.0
    peak = float(np.max(np.abs(ref))) if ref.size else 0.0
    if level <= 0.0 or peak <= 0.0:
        return ref
    return (ref * np.float32(min(rms / level, peak_cap / peak))).astype(np.float32)


def to_audio(samples: np.ndarray, rate: int) -> Audio:
    """Float mono samples -> 16-bit PCM, the take store's format."""
    data = np.clip(np.asarray(samples, dtype=np.float32).reshape(-1), -1.0, 1.0)
    return Audio(frames=(data * 32767.0).astype("<i2").tobytes(), sample_rate=int(rate))


def from_audio(audio: Audio) -> np.ndarray:
    """16-bit PCM -> float mono samples."""
    data = np.frombuffer(audio.frames, dtype="<i2").astype(np.float32) / 32767.0
    if audio.channels > 1:
        data = data.reshape(-1, audio.channels).mean(axis=1)
    return data


# --- the engine seam ------------------------------------------------------------------


class EngineUnavailable(Exception):
    """The engine's stack or weights are not here; a refusal (exit 2) naming what is missing."""


@dataclass
class RecordingEngine:
    """A model-free engine that records exactly what reached it (the AC2 witness).

    It renders silence as long as the line would take to say at `wps` words per
    second (one value per call, cycling, so a test can make an attempt too fast
    or too slow) and reports a fixed peak memory. `calls` holds each pass's
    take inputs and the text the adapter derived for the engine.
    """

    spec: EngineSpec = TURBO
    voices: Mapping[str, VoiceRef] = field(default_factory=dict)
    wps: Sequence[float] = (2.8,)
    sample_rate: int = 24_000
    fail_on_call: int | None = None
    calls: list[dict[str, object]] = field(default_factory=list)
    identity: EngineId = field(default_factory=lambda: EngineId(id="fake/recording", weights_sha256="0" * 64, mlx_audio="none", mlx="none"))
    loads: int = 0

    def load(self) -> dict[str, object]:
        self.loads += 1
        return {"load_s": 0.0, "peak_memory_gb": 0.0}

    def synthesize(self, inputs: TakeInputs) -> Synthesis:
        n = len(self.calls)
        if self.fail_on_call is not None and n == self.fail_on_call:
            raise RuntimeError(f"recording engine: told to fail on call {n}")
        text = engine_text(self.spec, inputs)
        self.calls.append({"inputs": inputs, "text": text, "voices": [self.voices[line.speaker].card_hash for line in inputs.lines]})
        words = sum(len(re.sub(r"\([^)]*\)", " ", line.text).split()) for line in inputs.lines)
        seconds = words / float(self.wps[n % len(self.wps)]) + 0.18
        frames = int(round(seconds * self.sample_rate))
        return Synthesis(audio=Audio(frames=b"\x00\x00" * frames, sample_rate=self.sample_rate), peak_memory_gb=1.5, ttfa=0.01)


def _version(package: str) -> str:
    try:
        return dist_version(package)
    except PackageNotFoundError:
        return "missing"


class MlxEngine:
    """A real mlx-audio engine at its pinned revision. `load()` before the first `synthesize`."""

    def __init__(self, spec: EngineSpec, voices: Mapping[str, VoiceRef], env: Mapping[str, str]) -> None:
        self.spec = spec
        self.voices = voices
        self._env = env
        self._model: object | None = None
        self._identity: EngineId | None = None
        self._refs: dict[tuple[str, int], np.ndarray] = {}

    @property
    def identity(self) -> EngineId:
        if self._identity is None:
            raise RuntimeError("engine identity is known only after load()")
        return self._identity

    def _snapshot(self) -> Path:
        try:
            from huggingface_hub import snapshot_download
        except ImportError as missing:
            raise EngineUnavailable(f"loading {self.spec.repo} needs huggingface_hub: {missing}") from missing
        try:
            return Path(snapshot_download(self.spec.repo, revision=self.spec.revision, local_files_only=True))
        except Exception:
            pass
        import sys

        print(f"pablo casting: pulling {self.spec.repo}@{self.spec.revision[:12]} into the Hugging Face cache", file=sys.stderr, flush=True)
        try:
            return Path(snapshot_download(self.spec.repo, revision=self.spec.revision))
        except Exception as failure:
            raise EngineUnavailable(f"{self.spec.repo}@{self.spec.revision[:12]} is not in the Hugging Face cache and could not be downloaded: {failure}") from failure

    def load(self) -> dict[str, object]:
        try:
            import mlx.core as mx
            from mlx_audio.tts.utils import load_model
        except ImportError as missing:
            raise EngineUnavailable(f"the {self.spec.name} engine needs mlx and mlx-audio (the `scorers` extra): {missing}") from missing
        from pablo_casting.hfcache import weights_sha256_at

        snapshot = self._snapshot()
        self._identity = EngineId(
            id=self.spec.repo,
            weights_sha256=weights_sha256_at(snapshot) or "unknown",
            mlx_audio=_version("mlx-audio"),
            mlx=_version("mlx"),
        )
        mx.reset_peak_memory()
        started = time.perf_counter()
        self._model = load_model(str(snapshot))
        return {"load_s": round(time.perf_counter() - started, 3), "peak_memory_gb": round(mx.get_peak_memory() / 1e9, 3), "snapshot": str(snapshot)}

    def _reference(self, voice: VoiceRef, rate: int) -> np.ndarray:
        cached = self._refs.get((voice.card_hash, rate))
        if cached is None:
            from pablo_casting.audio import read_audio, resample

            samples, sr = read_audio(voice.reference)
            cached = resample(samples, sr, rate)
            self._refs[(voice.card_hash, rate)] = cached
        return cached

    def synthesize(self, inputs: TakeInputs) -> Synthesis:
        import mlx.core as mx

        if self._model is None:
            raise RuntimeError("engine not loaded")
        model = self._model
        seed = inputs.seed
        mx.random.seed(seed)
        np.random.seed(seed % (2**32))
        text = engine_text(self.spec, inputs)
        params = dict(inputs.params)
        mx.reset_peak_memory()
        started = time.perf_counter()
        if self.spec.name in (TURBO.name, CHATTERBOX.name):
            rate = int(model.sample_rate)  # type: ignore[attr-defined]
            ref = self._reference(self.voices[inputs.lines[0].speaker], rate)
            if self.spec.name == CHATTERBOX.name:  # it copies the reference's loudness: level it, before any pad
                ref = level_reference(ref, float(params["ref_rms"]), float(params["ref_peak_cap"]))  # type: ignore[arg-type]
            pad_to = params.get("ref_pad_to_s")
            if isinstance(pad_to, (int, float)) and ref.size < int(pad_to * rate):
                ref = np.concatenate([ref, np.zeros(int(pad_to * rate) - ref.size, np.float32)])
            if self.spec.name == TURBO.name:
                controls: dict[str, object] = {"sample_rate": rate}
            else:
                # The original takes its reference at the model's rate and recomputes its conditionals per take.
                controls = {"exaggeration": float(params["exaggeration"]), "cfg_weight": float(params["cfg_weight"]), "verbose": False}  # type: ignore[arg-type]
            chunks, ttfa = [], None
            for result in model.generate(text=text, temperature=float(params["temperature"]), ref_audio=mx.array(ref), **controls):  # type: ignore[attr-defined]
                if ttfa is None:
                    ttfa = time.perf_counter() - started
                chunks.append(np.asarray(result.audio, dtype=np.float32).reshape(-1))
                rate = int(getattr(result, "sample_rate", rate) or rate)
            samples = np.concatenate(chunks) if chunks else np.zeros(0, np.float32)
        elif self.spec.name == DIA.name:
            rate = DIA_SR
            speakers = list(dict.fromkeys(line.speaker for line in inputs.lines))
            tags = dict(zip(speakers, ("[S1]", "[S2]")))
            pad = np.zeros(int(DIA_SR * float(params["ref_pad_s"])), np.float32)  # type: ignore[arg-type]
            ref = np.concatenate([part for s in speakers for part in (self._reference(self.voices[s], DIA_SR), pad)])
            ref_text = " ".join(f"{tags[s]} {self.voices[s].transcript}" for s in speakers)
            # As the prototype: `_generate` directly, because `generate()` drops the temperature.
            audio, _ = model._generate(  # type: ignore[attr-defined]
                text, temperature=float(params["temperature"]), top_p=float(params["top_p"]), ref_audio=mx.array(ref), ref_text=ref_text
            )
            ttfa = time.perf_counter() - started
            samples = np.asarray(audio, dtype=np.float32).reshape(-1) if audio is not None else np.zeros(0, np.float32)
        else:
            raise KeyError(self.spec.name)
        return Synthesis(audio=to_audio(samples, rate), peak_memory_gb=round(mx.get_peak_memory() / 1e9, 3), ttfa=round(ttfa or 0.0, 3))


class PerformEngine(Protocol):
    """`takes.Engine` plus a load step: what `perform` drives."""

    spec: EngineSpec

    @property
    def identity(self) -> EngineId: ...

    def load(self) -> dict[str, object]: ...

    def synthesize(self, inputs: TakeInputs) -> Synthesis: ...


EngineFactory = Callable[[EngineSpec, Mapping[str, VoiceRef], Mapping[str, str]], PerformEngine]


def real_engine(spec: EngineSpec, voices: Mapping[str, VoiceRef], env: Mapping[str, str]) -> MlxEngine:
    return MlxEngine(spec, voices, env)
