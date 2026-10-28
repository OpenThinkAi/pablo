"""The casting config: `$XDG_CONFIG_HOME/pablo/casting.json`.

It names the engines, the model weights to pull, the voice library's path,
the pace defaults and the auto-casting thresholds (`matching`, AGT-1698: any
of `bind`, `review`, `distinct` and `weights`, each defaulting to the design's
starting value; `matching.py` validates them), how a take ends (`ending`,
AGT-1789: `{"air": 0.18}`, seconds kept after the voice, 0.05-0.6), the CC0
sound library's directory (`sounds`) and per-kind cue loudness targets
(`loudness`, AGT-1799). No weights are configured by default, so a fresh machine
downloads nothing until the author (or a later ticket) names some.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from pablo_casting.ending import AIR_RANGE, DEFAULT_AIR


class ConfigRefusal(Exception):
    """The config exists but cannot be used; a refusal (exit 2), naming the file."""


@dataclass(frozen=True)
class WeightSpec:
    """One `weights` entry: a Hub model id and the commit it is pulled at (AGT-2274).

    casting.json takes either `"org/name"` or `{"id": "org/name", "revision": "<commit sha>"}`;
    without a revision `pull` fetches the Hub's current one and warns.
    """

    id: str
    revision: str | None = None

    def as_body(self) -> dict[str, object]:
        return {"id": self.id, "revision": self.revision}


@dataclass(frozen=True)
class CastingConfig:
    path: Path
    exists: bool
    engines: dict[str, dict[str, object]] = field(default_factory=dict)
    weights: list[WeightSpec] = field(default_factory=list)
    library: str | None = None
    pace: dict[str, float] = field(default_factory=lambda: {"default": 1.0})
    matching: dict[str, object] = field(default_factory=dict)
    air: float = DEFAULT_AIR
    """`ending.air`: seconds a take keeps after its voice ends (AGT-1789)."""
    sounds: str | None = None
    """The CC0 sound library's directory (AGT-1799); default `$XDG_DATA_HOME/pablo/sounds`."""
    loudness: dict[str, float] = field(default_factory=dict)
    """Per-kind cue loudness targets in LUFS (`SFX`, `BED`, `MUSIC`) over `loudness.DEFAULT_TARGETS`."""

    def as_body(self) -> dict[str, object]:
        return {
            "path": str(self.path),
            "exists": self.exists,
            "engines": self.engines,
            "weights": [w.as_body() for w in self.weights],
            "library": self.library,
            "pace": self.pace,
            "matching": self.matching,
            "ending": {"air": self.air},
            "sounds": self.sounds,
            "loudness": self.loudness,
        }


def config_path(env: Mapping[str, str]) -> Path:
    base = env.get("XDG_CONFIG_HOME")
    root = Path(base) if base else Path(env.get("HOME", str(Path.home()))) / ".config"
    return root / "pablo" / "casting.json"


def load_config(env: Mapping[str, str] | None = None) -> CastingConfig:
    env = os.environ if env is None else env
    path = config_path(env)
    if not path.exists():
        return CastingConfig(path=path, exists=False)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ConfigRefusal(f"{path} is not valid JSON: {error}") from error
    if not isinstance(raw, dict):
        raise ConfigRefusal(f"{path} must hold a JSON object")

    engines = raw.get("engines", {})
    if not isinstance(engines, dict) or not all(isinstance(v, dict) for v in engines.values()):
        raise ConfigRefusal(f"{path}: `engines` must be an object of objects")
    weights = _read_weights(raw.get("weights", []), path)
    library = raw.get("library")
    if library is not None and not isinstance(library, str):
        raise ConfigRefusal(f"{path}: `library` must be a path string")
    pace = raw.get("pace", {"default": 1.0})
    if not isinstance(pace, dict) or not all(
        isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 for v in pace.values()
    ):
        raise ConfigRefusal(f"{path}: `pace` must map names to positive numbers")
    matching = raw.get("matching", {})
    if not isinstance(matching, dict):
        raise ConfigRefusal(f"{path}: `matching` must be an object (bind, review, distinct, weights)")
    ending = raw.get("ending", {})
    air = ending.get("air", DEFAULT_AIR) if isinstance(ending, dict) else None
    if (
        not isinstance(ending, dict)
        or set(ending) - {"air"}
        or not isinstance(air, (int, float))
        or isinstance(air, bool)
        or not AIR_RANGE[0] <= air <= AIR_RANGE[1]
    ):
        raise ConfigRefusal(f"{path}: `ending` must be {{\"air\": seconds}} with air between {AIR_RANGE[0]} and {AIR_RANGE[1]}")

    sounds = raw.get("sounds")
    if sounds is not None and not isinstance(sounds, str):
        raise ConfigRefusal(f"{path}: `sounds` must be a path string")
    loudness = raw.get("loudness", {})
    if not isinstance(loudness, dict) or not all(
        k in ("SFX", "BED", "MUSIC") and isinstance(v, (int, float)) and not isinstance(v, bool) and -70 < v < 0 for k, v in loudness.items()
    ):
        raise ConfigRefusal(f"{path}: `loudness` must map SFX, BED or MUSIC to a LUFS target between -70 and 0")

    return CastingConfig(
        path=path,
        exists=True,
        engines=engines,
        weights=weights,
        library=library,
        pace={k: float(v) for k, v in pace.items()},
        matching=dict(matching),
        air=float(air),
        sounds=sounds,
        loudness={k: float(v) for k, v in loudness.items()},
    )


def _is_revision(value: object) -> bool:
    """A Hub revision name: non-empty, and never something that could leave the cache's snapshots directory."""
    return isinstance(value, str) and bool(value) and "/" not in value and "\\" not in value and value not in (".", "..")


def _read_weights(raw: object, path: Path) -> list[WeightSpec]:
    shape = f'{path}: `weights` must be a list of Hugging Face model ids, each "org/name" or {{"id": "org/name", "revision": "<commit sha>"}}'
    if not isinstance(raw, list):
        raise ConfigRefusal(shape)
    out: list[WeightSpec] = []
    for entry in raw:
        if isinstance(entry, str) and entry:
            out.append(WeightSpec(entry))
        elif (
            isinstance(entry, dict)
            and not set(entry) - {"id", "revision"}
            and isinstance(entry.get("id"), str)
            and entry["id"]
            and (entry.get("revision") is None or _is_revision(entry["revision"]))
        ):
            out.append(WeightSpec(entry["id"], entry.get("revision")))
        else:
            raise ConfigRefusal(shape)
    return out
