"""Where the Hugging Face cache is, and whether a model is in it, without importing
`huggingface_hub` or touching the network (`doctor` must never download)."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path


def hub_cache(env: Mapping[str, str]) -> Path:
    if env.get("HF_HUB_CACHE"):
        return Path(env["HF_HUB_CACHE"])
    if env.get("HF_HOME"):
        return Path(env["HF_HOME"]) / "hub"
    base = env.get("XDG_CACHE_HOME")
    root = Path(base) if base else Path(env.get("HOME", str(Path.home()))) / ".cache"
    return root / "huggingface" / "hub"


def is_cached(model_id: str, env: Mapping[str, str]) -> bool:
    """True when a snapshot of `model_id` is in the cache (the hub's `models--org--name/snapshots/<rev>` layout)."""
    snapshots = hub_cache(env) / ("models--" + model_id.replace("/", "--")) / "snapshots"
    return snapshots.is_dir() and any(snapshots.iterdir())
