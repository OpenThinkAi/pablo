"""Stale takes (AGT-2305): the performed lines whose stored take no longer matches how the line is spoken now.

A take's key holds the params that decide what the engine reads (`engines.spoken_params`: the matching lexicon
entries, the `spoken` number forms, the `acronyms` mode). `perform` reuses a stored take whenever its key matches, and
a performed unit is never performed again, so after a `pronounce.md` edit or a change to the spoken-form rules the
unit still holds takes made from the old text. `stale_lines` finds them by recomputing those params from the take's own
lines and comparing them with the ones stored; `fix --stale` re-records exactly those lines, and `status` and
`pronounce` count them. A flag's retake params (temperature, pace) are not compared, so a line that was re-taken is
not stale for that. Pure Python, reads takes, writes nothing.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from pathlib import Path

from pablo_casting.engines import ACRONYMS_PARAM, LEXICON_PARAM, SPOKEN_PARAM, spoken_params
from pablo_casting.lexicon import Entry, acronym_mode, load
from pablo_casting.takes import KEY_RE, read_take

STALE_REASON = "pronunciation changed"
SPOKEN_PARAMS = (LEXICON_PARAM, SPOKEN_PARAM, ACRONYMS_PARAM)


def stale_lines(work: Path, lines: Sequence[Mapping[str, object]], entries: Sequence[Entry] | None = None, acronyms: bool | None = None) -> list[int]:
    """The `i` of every manifest line whose take was made from a different spoken form than the current lexicon and
    rules give. A line whose take cannot be read is left out: nothing says it changed."""
    entries = load(work) if entries is None else entries
    acronyms = acronym_mode(work) if acronyms is None else acronyms
    stale: list[int] = []
    for line in lines:
        key, i = line.get("take"), line.get("i")
        if not isinstance(key, str) or not KEY_RE.match(key) or not isinstance(i, int) or isinstance(i, bool):
            continue
        take = read_take(work, key)
        inputs = take.record.get("inputs") if take is not None else None
        if not isinstance(inputs, dict):
            continue
        rows = [(str(row.get("speaker")), str(row.get("text"))) for row in inputs.get("lines") or [] if isinstance(row, dict)]
        params = inputs.get("params")
        if not rows or not isinstance(params, dict):
            continue
        wanted = spoken_params(rows, entries, acronyms)
        if any(params.get(name) != wanted.get(name) for name in SPOKEN_PARAMS):
            stale.append(i)
    return sorted(stale)


__all__ = ["STALE_REASON", "stale_lines"]
