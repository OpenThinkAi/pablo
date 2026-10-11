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


def snapshot_dir(model_id: str, env: Mapping[str, str]) -> Path | None:
    """The newest cached snapshot of `model_id`, or `None` when it is not in the cache."""
    snapshots = hub_cache(env) / ("models--" + model_id.replace("/", "--")) / "snapshots"
    if not snapshots.is_dir():
        return None
    candidates = [entry for entry in snapshots.iterdir() if entry.is_dir()]
    if not candidates:
        return None
    return max(candidates, key=lambda entry: entry.stat().st_mtime)


WEIGHT_SUFFIXES = (".safetensors", ".bin", ".npz", ".gguf")


def weights_sha256(model_id: str, env: Mapping[str, str]) -> str | None:
    """One sha256 over a cached snapshot's weight files: each file's relative path and
    content hash, in path order. `None` when the model is not cached. This is what a
    card's `designed.weights_sha256` records, so a re-uploaded checkpoint under the
    same id shows up as different weights."""
    import hashlib

    root = snapshot_dir(model_id, env)
    if root is None:
        return None
    digest = hashlib.sha256()
    files = sorted(p for p in root.rglob("*") if p.is_file() and p.suffix in WEIGHT_SUFFIXES)
    if not files:
        return None
    for path in files:
        content = hashlib.sha256()
        with path.open("rb") as handle:  # follows the hub's blob symlinks
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                content.update(chunk)
        digest.update(f"{path.relative_to(root).as_posix()}\0{content.hexdigest()}\n".encode())
    return digest.hexdigest()
