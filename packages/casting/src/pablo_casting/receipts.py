"""Receipts: one JSON line per model call, in `<work>/.pablo/casting/receipts.jsonl`.

The work directory is always the one pablo passed (`--work`), never a path a
model supplied. A command run without a work leaves no receipt.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path


def receipts_path(work: Path) -> Path:
    return work / ".pablo" / "casting" / "receipts.jsonl"


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def append_receipt(work: Path, receipt: dict[str, object]) -> Path:
    path = receipts_path(work)
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps({"at": now(), **receipt}, sort_keys=False)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")
    return path
