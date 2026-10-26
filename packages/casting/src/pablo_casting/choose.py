"""`takes line` and `takes choose` (AGT-2155): compare a line's takes and choose one.

Every take a line has had stays in the take store (takes are immutable and
content-addressed; `takes gc` only archives what no manifest references), and
every manifest version names the take it used for each line. So a line's takes
are read straight off its manifest versions:

- `takes line --work W --episode N --line I`  every distinct take line `I` has
  had, in the order it first appeared, with the versions that used it, its
  status, attempt, gates, length and pace, the `fix` that made it (reasons,
  temperature) and whether the newest version uses it (`current`).
- `takes choose <key> --work W --episode N --line I`  puts an earlier take of
  that line back: the next manifest version is the newest one with line `I`'s
  entry taken from the version that used `<key>` (marked `chosen`), written
  through `manifest.write_version`'s "only flagged lines change" invariant. The
  choice is a flag of its own (`by: "human"`, reason `chosen take`): written to
  `flags.json`, applied, and moved to `flags-done.json` with the version it
  landed in, as `fix` moves its flags; a failed write takes it back out. Then
  the version is remixed like a fix, so a mix saved in the mixer is rebased
  onto it (`mix.rebase`): the chosen take drops into the line's clip slot with
  its fades and gain.

Refusals (exit 2, nothing written): no manifest, a line the newest version does
not have, a key the line never had, or the take the newest version already uses.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Mapping
from pathlib import Path

from pablo_casting.fix import _read_flags, _write_atomic, move_flags_done
from pablo_casting.manifest import ManifestError, flags_path, read_version, versions, write_version
from pablo_casting.takes import read_take

Body = dict[str, object]
Result = tuple[Body, int]
Mixer = Callable[[int], Result]

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_REFUSED = 2

CHOSEN_REASON = "chosen take"
# What a manifest carries over from the version it follows when a take is chosen.
CARRIED = ("script_sha256", "cast_hash", "engine", "pace_policy", "cues")


def _refused(message: str, **extra: object) -> Result:
    return {"ok": False, "code": EXIT_REFUSED, "message": message, **extra}, EXIT_REFUSED


def _error(message: str) -> Result:
    return {"ok": False, "code": EXIT_ERROR, "message": message}, EXIT_ERROR


def _line_of(manifest: Mapping[str, object], line: int) -> Mapping[str, object] | None:
    lines = manifest.get("lines")
    if not isinstance(lines, list):
        return None
    return next((entry for entry in lines if isinstance(entry, Mapping) and entry.get("i") == line), None)


def _history(work: Path, episode: int, line: int) -> tuple[list[tuple[int, Mapping[str, object]]], int]:
    """Line `line`'s entry in every manifest version that has it, oldest first, and the newest version."""
    found = versions(work, episode)
    rows: list[tuple[int, Mapping[str, object]]] = []
    for version in found:
        entry = _line_of(read_version(work, episode, version), line)
        if entry is not None:
            rows.append((version, entry))
    return rows, found[-1] if found else 0


def line_takes(work: Path, episode: int, line: int) -> Result:
    """Every distinct take line `line` of `episode` has had, oldest first."""
    rows, newest = _history(work, episode, line)
    if newest == 0:
        return _refused(f"episode {episode} has no manifest: run `pablo perform --episode {episode}` first", episode=episode)
    current_entry = _line_of(read_version(work, episode, newest), line)
    if current_entry is None:
        return _refused(f"episode {episode} v{newest} has no line {line}", episode=episode, line=line)
    takes: list[Body] = []
    by_key: dict[str, Body] = {}
    for version, entry in rows:
        key = str(entry.get("take"))
        seen = by_key.get(key)
        if seen is not None:
            seen["versions"].append(version)  # type: ignore[union-attr]
            continue
        record = read_take(work, key)
        fixed = entry.get("fix")
        row: Body = {
            "key": key,
            "versions": [version],
            "status": entry.get("status"),
            "attempt": entry.get("attempt"),
            "seconds": entry.get("seconds"),
            "stretch": entry.get("stretch"),
            "gates": entry.get("gates") if isinstance(entry.get("gates"), dict) else {},
            "failing": entry.get("failing") if isinstance(entry.get("failing"), list) else [],
            "reasons": list(fixed.get("reasons", [])) if isinstance(fixed, dict) else [],
            "temperature": fixed.get("temperature") if isinstance(fixed, dict) else None,
            "chosen": isinstance(entry.get("chosen"), dict),
            "stored": record is not None,
            "created": record.record.get("created") if record is not None else None,
            "current": False,
        }
        by_key[key] = row
        takes.append(row)
    current = str(current_entry.get("take"))
    for row in takes:
        row["current"] = row["key"] == current
    return {
        "ok": True,
        "episode": episode,
        "line": line,
        "speaker": current_entry.get("speaker"),
        "text": current_entry.get("text"),
        "version": newest,
        "current": current,
        "takes": takes,
    }, EXIT_OK


def choose_take(work: Path, episode: int, line: int, key: str, mixer: Mixer | None) -> Result:
    """Writes the next manifest version with line `line` back on take `key` (one it has had), then remixes it."""
    rows, newest = _history(work, episode, line)
    if newest == 0:
        return _refused(f"episode {episode} has no manifest: run `pablo perform --episode {episode}` first", episode=episode)
    parent = read_version(work, episode, newest)
    current = _line_of(parent, line)
    if current is None:
        return _refused(f"episode {episode} v{newest} has no line {line}", episode=episode, line=line)
    matches = [(version, entry) for version, entry in rows if entry.get("take") == key or (len(key) >= 4 and str(entry.get("take")).startswith(key))]
    keys = {str(entry.get("take")) for _, entry in matches}
    if not matches:
        return _refused(f"line {line} of episode {episode} never had take {key}; `pablo takes line` lists the ones it had", episode=episode, line=line, key=key)
    if len(keys) > 1:
        return _refused(f"take key prefix {key} matches {len(keys)} of line {line}'s takes; give more of it", matches=sorted(keys))
    full = keys.pop()
    if full == current.get("take"):
        return _refused(f"episode {episode} v{newest} already uses take {full[:12]} for line {line}; nothing to choose", episode=episode, line=line, version=newest)
    if read_take(work, full) is None:
        return _refused(f"take {full[:12]} is no longer in the take store (archived by takes gc?); nothing was written", missing=[full])
    source_version, source = matches[-1]

    entry: dict[str, object] = {name: value for name, value in source.items() if name not in ("start", "end", "chosen")}
    entry["chosen"] = {"from_version": source_version, "replaced_take": current.get("take"), "in_version": newest}
    lines = [entry if isinstance(row, Mapping) and row.get("i") == line else row for row in parent.get("lines", [])]  # type: ignore[union-attr]
    delivered, seen = 0.0, set()
    for row in lines:
        if not isinstance(row, Mapping) or row.get("take") in seen:
            continue
        seen.add(row.get("take"))
        try:
            delivered += float(row["seconds"]) / float(row["stretch"])  # type: ignore[arg-type]
        except (KeyError, TypeError, ValueError, ZeroDivisionError):
            pass

    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    flag: Body = {"id": f"f-{stamp}-ep{episode:02d}-{line}-chosen", "episode": episode, "line": line, "reason": CHOSEN_REASON, "source": "human", "by": "human", "take": full}
    try:
        raw = _read_flags(flags_path(work))
    except Exception as unreadable:  # noqa: BLE001 -- FlagsRefusal: a broken flags.json is never overwritten
        return _refused(str(unreadable))
    _write_atomic(flags_path(work), {**raw, "flags": [*raw.get("flags", []), flag]})  # type: ignore[misc]

    proposal: dict[str, object] = {name: parent[name] for name in CARRIED if name in parent}
    proposal.update(
        {
            "duration": round(delivered, 3),
            "rtf_total": None,
            "render": {"choose": True, "from_version": newest, "lines": [line], "take": full, "take_from_version": source_version},
            "lines": lines,
        }
    )
    applied = [{"id": flag["id"], "line": line, "reason": CHOSEN_REASON, "by": "human"}]
    try:
        written = write_version(work, episode, proposal, flags_applied=applied)
    except ManifestError as failure:
        _take_back(work, str(flag["id"]))
        return _error(f"writing episode {episode}'s manifest with the chosen take failed: {failure}")
    version = int(written.manifest["version"])  # type: ignore[call-overload]
    try:
        move_flags_done(work, episode, [flag], version)
    except (OSError, ValueError, json.JSONDecodeError) as failure:
        return _error(f"episode {episode} v{version} was written but moving its choice flag failed: {failure}")

    message = f"episode {episode} v{version}: line {line} is back on take {full[:12]} (from v{source_version})"
    body: Body = {
        "ok": True,
        "episode": episode,
        "line": line,
        "take": full,
        "replacedTake": current.get("take"),
        "fromVersion": newest,
        "takeFromVersion": source_version,
        "version": version,
        "manifest": str(written.path),
        "changedLines": written.manifest["changed_lines"],
        "mixed": False,
        "audio": None,
    }
    if mixer is None:
        return {**body, "message": message}, EXIT_OK
    mixed, code = mixer(version)
    if code != EXIT_OK or not mixed.get("ok"):
        return {
            **body,
            "ok": False,
            "code": EXIT_ERROR,
            "message": f"{message}; the remix failed, so v{version} has no audio yet: {mixed.get('message')} -- finish with `pablo mix --episode {episode}`",
        }, EXIT_ERROR
    return {**body, "mixed": True, "audio": mixed.get("audio"), "message": f"{message}; remixed -> {Path(str(mixed.get('audio'))).name}"}, EXIT_OK


def _take_back(work: Path, flag_id: str) -> None:
    """Drops the choice flag again after a write that did not land: the flags are as they were."""
    try:
        raw = _read_flags(flags_path(work))
    except Exception:  # noqa: BLE001
        return
    _write_atomic(flags_path(work), {**raw, "flags": [f for f in raw.get("flags", []) if not (isinstance(f, dict) and f.get("id") == flag_id)]})  # type: ignore[union-attr]


def _numbers(episode: str | None, line: str | None, verb: str) -> tuple[int, int] | Result:
    if episode is None or line is None:
        return _refused(f"takes {verb} needs --episode N and --line I", missing=[name for name, value in (("--episode", episode), ("--line", line)) if value is None])
    try:
        number, index = int(episode), int(line)
    except ValueError:
        return _error(f"--episode and --line must be whole numbers, got {episode!r} and {line!r}")
    if number < 1 or index < 0:
        return _error("--episode must be 1 or more and --line 0 or more")
    return number, index


def cmd_takes_line(work: Path, episode: str | None, line: str | None) -> Result:
    parsed = _numbers(episode, line, "line")
    if isinstance(parsed[0], dict):
        return parsed  # type: ignore[return-value]
    number, index = parsed
    return line_takes(work, int(number), int(index))


def cmd_takes_choose(work: Path, key: str | None, episode: str | None, line: str | None, mixer: Mixer | None) -> Result:
    if not key:
        return _error("usage: takes choose <key> --episode N --line I --work DIR")
    parsed = _numbers(episode, line, "choose")
    if isinstance(parsed[0], dict):
        return parsed  # type: ignore[return-value]
    number, index = parsed
    return choose_take(work, int(number), int(index), key, mixer)


__all__ = ["CHOSEN_REASON", "choose_take", "cmd_takes_choose", "cmd_takes_line", "line_takes"]
