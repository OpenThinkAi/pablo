"""The take store: content-addressed, immutable takes (AGT-1681, design "Takes and manifests").

A take is one engine pass for one line group, written once:

    <work>/outputs/radio/casting/takes/<key>/take.wav    engine output finished by ending.py, never paced
    <work>/outputs/radio/casting/takes/<key>/take.json   inputs, seed, attempt, scores,
                                                         timings, status, receipt id

`key` is the sha256 of the canonical JSON of everything that changes the audio:
`{take_version, engine: {id, weights_sha256, mlx_audio, mlx}, voice: card_hash,
lines: [{speaker, text}], direction: {emotion, intensity, pace}, params, seed}`.
Change any of it and the key changes; keep all of it and writing again is a
no-op that never even runs the engine.

Nothing here modifies or deletes a take. A take's files are written into a
staging directory, made read-only, and renamed into place in one step; an
existing key is left exactly as it is. The one way a take leaves `takes/` is
`archive_takes` (`pablo takes gc`), which *moves* takes no manifest version
references into `archive/takes/<stamp>/`, after the author has seen the list
and said yes. The only deletion in this module is `_discard_staging`, which
removes a staging directory that lost a race to an identical take.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import time
import uuid
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from pablo_casting import __version__
from pablo_casting.receipts import append_receipt, now
from pablo_casting.wav import Audio

# Bump when the meaning of a take changes (trimming, the key's own shape):
# every key changes with it, so old takes are never mistaken for new ones.
TAKE_VERSION = 2  # 2: takes finished by ending.py (AGT-1789)

KEY_RE = re.compile(r"^[0-9a-f]{64}$")
KEY_PREFIX_RE = re.compile(r"^[0-9a-f]{4,64}$")
STAGING_PREFIX = ".staging-"
READ_ONLY = 0o444

JSONScalar = str | int | float | bool | None


def casting_dir(work: Path) -> Path:
    """The radio output's casting state inside a work."""
    return work / "outputs" / "radio" / "casting"


def takes_dir(work: Path) -> Path:
    return casting_dir(work) / "takes"


def canonical_json(body: object) -> str:
    """One spelling per value: sorted keys, no whitespace, UTF-8, no NaN."""
    return json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


class TakeInputError(ValueError):
    """The inputs cannot make a key (a missing or malformed field)."""


@dataclass(frozen=True)
class EngineId:
    id: str
    weights_sha256: str
    mlx_audio: str
    mlx: str

    def body(self) -> dict[str, str]:
        return {"id": self.id, "weights_sha256": self.weights_sha256, "mlx_audio": self.mlx_audio, "mlx": self.mlx}


@dataclass(frozen=True)
class Line:
    speaker: str
    text: str


@dataclass(frozen=True)
class Direction:
    emotion: str | None = None
    intensity: int | None = None
    pace: str | None = None

    def body(self) -> dict[str, JSONScalar]:
        return {"emotion": self.emotion, "intensity": self.intensity, "pace": self.pace}


@dataclass(frozen=True)
class TakeInputs:
    """Everything that changes a take's audio; exactly the key's fields."""

    engine: EngineId
    voice: str  # the cast card's hash
    lines: tuple[Line, ...]
    seed: int
    direction: Direction = field(default_factory=Direction)
    params: Mapping[str, JSONScalar] = field(default_factory=dict)
    take_version: int = TAKE_VERSION

    def key_body(self, *, with_seed: bool = True) -> dict[str, object]:
        if not self.lines:
            raise TakeInputError("a take needs at least one line")
        for name, value in (("engine.id", self.engine.id), ("engine.weights_sha256", self.engine.weights_sha256), ("voice", self.voice)):
            if not isinstance(value, str) or not value:
                raise TakeInputError(f"`{name}` must be a non-empty string")
        for name, value in (("engine.mlx_audio", self.engine.mlx_audio), ("engine.mlx", self.engine.mlx)):
            if not isinstance(value, str):
                raise TakeInputError(f"`{name}` must be a string")
        for line in self.lines:
            if not line.speaker or not isinstance(line.text, str) or not line.text.strip():
                raise TakeInputError("every line needs a speaker and some text")
        if isinstance(self.seed, bool) or not isinstance(self.seed, int):
            raise TakeInputError("`seed` must be an integer")
        for key, value in self.params.items():
            if not isinstance(key, str) or not isinstance(value, (str, int, float, bool, type(None))):
                raise TakeInputError(f"param `{key}` must be a JSON scalar")
        body: dict[str, object] = {
            "take_version": self.take_version,
            "engine": self.engine.body(),
            "voice": self.voice,
            "lines": [{"speaker": line.speaker, "text": line.text} for line in self.lines],
            "direction": self.direction.body(),
            "params": dict(self.params),
        }
        if with_seed:
            body["seed"] = self.seed
        return body

    @classmethod
    def from_body(cls, body: Mapping[str, object]) -> TakeInputs:
        """The inverse of `key_body`; refuses fields the key does not know."""
        known = {"take_version", "engine", "voice", "lines", "direction", "params", "seed"}
        unknown = sorted(set(body) - known)
        if unknown:
            raise TakeInputError(f"unknown take input field(s): {', '.join(unknown)}")
        engine = body.get("engine")
        lines = body.get("lines")
        direction = body.get("direction") or {}
        params = body.get("params") or {}
        take_version = body.get("take_version", TAKE_VERSION)
        seed = body.get("seed")
        if not isinstance(engine, Mapping) or not isinstance(lines, Sequence) or isinstance(lines, str):
            raise TakeInputError("malformed take inputs: `engine` must be an object and `lines` a list")
        if not isinstance(direction, Mapping) or not isinstance(params, Mapping):
            raise TakeInputError("malformed take inputs: `direction` and `params` must be objects")
        if isinstance(take_version, bool) or not isinstance(take_version, int):
            raise TakeInputError("malformed take inputs: `take_version` must be an integer")
        if isinstance(seed, bool) or not isinstance(seed, int):
            raise TakeInputError("malformed take inputs: `seed` must be an integer")
        try:
            return cls(
                engine=EngineId(
                    id=str(engine["id"]),
                    weights_sha256=str(engine["weights_sha256"]),
                    mlx_audio=str(engine.get("mlx_audio", "")),
                    mlx=str(engine.get("mlx", "")),
                ),
                voice=str(body["voice"]),
                lines=tuple(Line(speaker=str(line["speaker"]), text=str(line["text"])) for line in lines),  # type: ignore[index]
                seed=seed,
                direction=Direction(
                    emotion=direction.get("emotion"),  # type: ignore[arg-type]
                    intensity=direction.get("intensity"),  # type: ignore[arg-type]
                    pace=direction.get("pace"),  # type: ignore[arg-type]
                ),
                params=dict(params),  # type: ignore[arg-type]
                take_version=take_version,
            )
        except (KeyError, TypeError) as failure:
            raise TakeInputError(f"malformed take inputs: {failure!r}") from failure


def take_key(inputs: TakeInputs) -> str:
    return hashlib.sha256(canonical_json(inputs.key_body()).encode("utf-8")).hexdigest()


def derive_seed(inputs: TakeInputs, attempt: int) -> int:
    """The retake loop's seed for `attempt`: `sha1(key_without_seed + attempt)`, as a 32-bit int."""
    digest = hashlib.sha1((canonical_json(inputs.key_body(with_seed=False)) + str(attempt)).encode("utf-8")).hexdigest()
    return int(digest[:8], 16)


@dataclass(frozen=True)
class WordTiming:
    word: str
    start: float
    end: float


@dataclass(frozen=True)
class Synthesis:
    """What an engine hands back for one pass."""

    audio: Audio
    words: tuple[WordTiming, ...] = ()
    # What the engine pass cost, when the engine measures it (AGT-1683 receipts).
    peak_memory_gb: float | None = None
    ttfa: float | None = None


class Engine(Protocol):
    """The seam C11's real adapters fill; `FakeEngine` stands in until then."""

    @property
    def identity(self) -> EngineId: ...

    def synthesize(self, inputs: TakeInputs) -> Synthesis: ...


@dataclass(frozen=True)
class Take:
    key: str
    path: Path
    record: dict[str, object]


def take_path(work: Path, key: str) -> Path:
    if not KEY_RE.match(key):
        raise TakeInputError(f"not a take key: {key!r}")
    return takes_dir(work) / key


def read_take(work: Path, key: str) -> Take | None:
    path = take_path(work, key)
    record_path = path / "take.json"
    if not record_path.is_file():
        return None
    return Take(key=key, path=path, record=json.loads(record_path.read_text(encoding="utf-8")))


def list_take_keys(work: Path) -> list[str]:
    root = takes_dir(work)
    if not root.is_dir():
        return []
    return sorted(entry.name for entry in root.iterdir() if entry.is_dir() and KEY_RE.match(entry.name))


class AmbiguousKey(LookupError):
    def __init__(self, prefix: str, matches: list[str]) -> None:
        super().__init__(f"{prefix} matches {len(matches)} takes")
        self.matches = matches


def resolve_key(work: Path, prefix: str) -> str | None:
    """A full key from a unique prefix (at least 4 hex characters)."""
    if not KEY_PREFIX_RE.match(prefix):
        raise TakeInputError(f"not a take key or key prefix (4-64 lowercase hex): {prefix!r}")
    matches = [key for key in list_take_keys(work) if key.startswith(prefix)]
    if len(matches) > 1:
        raise AmbiguousKey(prefix, matches)
    return matches[0] if matches else None


GITIGNORE_LINES = (
    "# pablo casting (AGT-1681): takes and audio stay on disk, untracked;",
    "# manifests (renders/epNN/v<k>.json), cast.json and flags.json are tracked.",
    "takes/",
    "archive/",
    "renders/**/*.m4a",
    "renders/**/*.wav",
)


def ensure_gitignore(work: Path) -> Path:
    """Writes (or appends the missing rules to) `<casting>/.gitignore`; never removes a line."""
    path = casting_dir(work) / ".gitignore"
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    missing = [line for line in GITIGNORE_LINES if line not in existing]
    if missing:
        prefix = "" if not existing or existing[-1] == "" else "\n"
        with path.open("a", encoding="utf-8") as handle:
            handle.write(prefix + "\n".join(missing) + "\n")
    return path


def _discard_staging(staging: Path) -> None:
    """The one deletion in this module: a staging directory that never became a take."""
    if not staging.name.startswith(STAGING_PREFIX) or staging.parent.name != "takes":
        raise RuntimeError(f"refusing to discard {staging}: not a take staging directory")
    for child in staging.iterdir():
        child.chmod(0o644)
    shutil.rmtree(staging)


def write_take(
    work: Path,
    inputs: TakeInputs,
    synthesis: Synthesis,
    *,
    attempt: int,
    scores: Mapping[str, object],
    status: str,
    receipt: str,
    timings: Mapping[str, object] | None = None,
) -> tuple[Take, bool]:
    """Writes a take once. Returns `(take, created)`; an existing key is returned untouched."""
    key = take_key(inputs)
    existing = read_take(work, key)
    if existing is not None:
        return existing, False

    root = takes_dir(work)
    root.mkdir(parents=True, exist_ok=True)
    ensure_gitignore(work)
    wav = synthesis.audio.to_wav()
    record: dict[str, object] = {
        "key": key,
        "take_version": inputs.take_version,
        "inputs": inputs.key_body(),
        "seed": inputs.seed,
        "attempt": attempt,
        "status": status,
        "scores": dict(scores),
        "timings": {
            "words": [{"word": w.word, "start": w.start, "end": w.end} for w in synthesis.words],
            **(dict(timings) if timings else {}),
        },
        "audio": {
            "file": "take.wav",
            "sample_rate": synthesis.audio.sample_rate,
            "channels": synthesis.audio.channels,
            "frames": synthesis.audio.frame_count,
            "duration": round(synthesis.audio.duration, 6),
            "sha256": hashlib.sha256(wav).hexdigest(),
        },
        "receipt": receipt,
        "created": now(),
        "by": f"casting {__version__}",
    }

    staging = root / f"{STAGING_PREFIX}{key[:16]}-{uuid.uuid4().hex[:8]}"
    staging.mkdir()
    (staging / "take.wav").write_bytes(wav)
    (staging / "take.json").write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for child in staging.iterdir():
        child.chmod(READ_ONLY)
    final = root / key
    try:
        os.rename(staging, final)  # atomic; fails (never replaces) when `final` already holds a take
    except OSError:
        _discard_staging(staging)
        won = read_take(work, key)
        if won is None:
            raise
        return won, False
    return Take(key=key, path=final, record=record), True


def record_take(
    work: Path,
    engine: Engine,
    inputs: TakeInputs,
    *,
    attempt: int = 0,
    scores: Mapping[str, object] | None = None,
    status: str = "pass",
) -> tuple[Take, bool]:
    """One engine pass into the store, with a receipt. An existing key never reaches the engine."""
    if inputs.engine != engine.identity:
        raise TakeInputError(f"inputs name engine {inputs.engine.id!r}, but {engine.identity.id!r} is performing")
    key = take_key(inputs)
    existing = read_take(work, key)
    if existing is not None:
        return existing, False

    started = time.monotonic()
    synthesis = engine.synthesize(inputs)
    wall = round(time.monotonic() - started, 6)
    seconds = synthesis.audio.duration
    receipt = f"r-{uuid.uuid4().hex}"
    append_receipt(
        work,
        {
            "id": receipt,
            "intent": "take",
            "engine": inputs.engine.id,
            "weights_sha256": inputs.engine.weights_sha256,
            "inputs": key,
            "seed": inputs.seed,
            "wall": wall,
            "audio_seconds": round(seconds, 6),
            "rtf": round(wall / seconds, 6) if seconds else None,
        },
    )
    timings = {"wall": wall, "audio_seconds": round(seconds, 6), "rtf": round(wall / seconds, 6) if seconds else None}
    return write_take(work, inputs, synthesis, attempt=attempt, scores=scores or {}, status=status, receipt=receipt, timings=timings)


def archive_takes(work: Path, keys: Iterable[str], stamp: str) -> list[dict[str, str]]:
    """Moves takes (whole directories, unchanged) to `archive/takes/<stamp>/<key>`. Never deletes."""
    destination = casting_dir(work) / "archive" / "takes" / stamp
    moved: list[dict[str, str]] = []
    for key in keys:
        source = take_path(work, key)
        if not source.is_dir():
            continue
        destination.mkdir(parents=True, exist_ok=True)
        target = destination / key
        os.rename(source, target)
        moved.append({"key": key, "to": str(target)})
    return moved


def take_bytes(path: Path) -> int:
    return sum(child.stat().st_size for child in path.iterdir() if child.is_file())


__all__ = [
    "AmbiguousKey",
    "Direction",
    "Engine",
    "EngineId",
    "KEY_RE",
    "Line",
    "Synthesis",
    "Take",
    "TakeInputError",
    "TakeInputs",
    "TAKE_VERSION",
    "WordTiming",
    "archive_takes",
    "canonical_json",
    "casting_dir",
    "derive_seed",
    "ensure_gitignore",
    "list_take_keys",
    "read_take",
    "record_take",
    "resolve_key",
    "take_key",
    "take_path",
    "takes_dir",
    "write_take",
]
