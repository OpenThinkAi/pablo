"""Receipts: one JSON line per model call, in `<work>/.pablo/casting/receipts.jsonl`.

The work directory is always the one pablo passed (`--work`), never a path a
model supplied. A command run without a work leaves no receipt. A receipt
written on another output than radio carries `output` (AGT-2158).
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from pablo_casting import outputs


def receipts_path(work: Path) -> Path:
    return work / ".pablo" / "casting" / "receipts.jsonl"


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def append_receipt(work: Path, receipt: dict[str, object]) -> Path:
    path = receipts_path(work)
    path.parent.mkdir(parents=True, exist_ok=True)
    # A receipt for another output than radio says which (AGT-2158): narrated unit 1 is not radio episode 1.
    tagged = receipt if outputs.current() == outputs.RADIO or "output" in receipt else {**receipt, "output": outputs.current()}
    line = json.dumps({"at": now(), **tagged}, sort_keys=False)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")
    return path
