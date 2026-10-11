"""The casting config: `$XDG_CONFIG_HOME/pablo/casting.json`.

It names the engines, the model weights to pull, the voice library's path,
the pace defaults and the auto-casting thresholds (`matching`, AGT-1698: any
of `bind`, `review`, `distinct` and `weights`, each defaulting to the design's
starting value; `matching.py` validates them). No weights are configured by default, so a fresh machine
downloads nothing until the author (or a later ticket) names some.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path


class ConfigRefusal(Exception):
    """The config exists but cannot be used; a refusal (exit 2), naming the file."""


@dataclass(frozen=True)
class CastingConfig:
    path: Path
    exists: bool
    engines: dict[str, dict[str, object]] = field(default_factory=dict)
    weights: list[str] = field(default_factory=list)
    library: str | None = None
    pace: dict[str, float] = field(default_factory=lambda: {"default": 1.0})
    matching: dict[str, object] = field(default_factory=dict)

    def as_body(self) -> dict[str, object]:
        return {
            "path": str(self.path),
            "exists": self.exists,
            "engines": self.engines,
            "weights": self.weights,
            "library": self.library,
            "pace": self.pace,
            "matching": self.matching,
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
    weights = raw.get("weights", [])
    if not isinstance(weights, list) or not all(isinstance(w, str) and w for w in weights):
        raise ConfigRefusal(f"{path}: `weights` must be a list of Hugging Face model ids")
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

    return CastingConfig(
        path=path,
        exists=True,
        engines=engines,
        weights=list(weights),
        library=library,
        pace={k: float(v) for k, v in pace.items()},
        matching=dict(matching),
    )
