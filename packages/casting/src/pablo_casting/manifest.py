"""Manifest versions and the "only flagged lines change" invariant (AGT-1681).

A manifest is one version of one episode, `renders/epNN/v<k>.json`, tracked
in git and never rewritten. Each version names its `parent`, the lines whose
take differs from the parent's (`changed_lines`) and the flags it applied.
`write_version` is the only writer, and it refuses (exit 1, nothing written)
any version whose changed lines are not a subset of the lines the applied
flags point at: guarantee 2 of the design, enforced by construction rather
than by trusting a seed to re-create a take.

A pace- or mix-only change is a new version with `changed_lines: []` and the
same take ids. Version 1 has no parent; every line in it is new, so its
`changed_lines` lists them all.

Audio is per version (`epNN.v<k>.m4a`, untracked), with `epNN.m4a` a symlink
to the newest version's file. Nothing is overwritten.

Open flags live in `<casting>/flags.json` (the player writes them, C14):
`{"flags": [{"id": "f-…", "episode": 1, "line": 31, "reason": "clipped", …}]}`.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from pablo_casting import __version__
from pablo_casting.receipts import now
from pablo_casting.takes import KEY_RE, casting_dir, ensure_gitignore, read_take

VERSION_RE = re.compile(r"^v(\d+)\.json$")

# Fields a caller proposes; the writer computes episode, version, parent,
# changed_lines, flags_applied, audio, created and by itself.
PROPOSED_FIELDS = ("script_sha256", "cast_hash", "engine", "pace_policy", "cues", "duration", "rtf_total", "render", "mix")


class ManifestError(Exception):
    """The version cannot be written (exit 1). Nothing was written."""

    def __init__(self, message: str, **extra: object) -> None:
        super().__init__(message)
        self.extra = extra


def episode_dir(work: Path, episode: int) -> Path:
    return casting_dir(work) / "renders" / f"ep{episode:02d}"


def flags_path(work: Path) -> Path:
    return casting_dir(work) / "flags.json"


def versions(work: Path, episode: int) -> list[int]:
    root = episode_dir(work, episode)
    if not root.is_dir():
        return []
    found = (VERSION_RE.match(entry.name) for entry in root.iterdir())
    return sorted(int(match.group(1)) for match in found if match)


def read_version(work: Path, episode: int, version: int) -> dict[str, object]:
    return json.loads((episode_dir(work, episode) / f"v{version}.json").read_text(encoding="utf-8"))


def latest(work: Path, episode: int) -> dict[str, object] | None:
    found = versions(work, episode)
    return read_version(work, episode, found[-1]) if found else None


def all_manifests(work: Path) -> Iterable[tuple[Path, dict[str, object]]]:
    """Every manifest version of every episode. A file that does not parse raises."""
    renders = casting_dir(work) / "renders"
    if not renders.is_dir():
        return
    for episode in sorted(renders.iterdir()):
        if not episode.is_dir():
            continue
        for entry in sorted(episode.iterdir()):
            if VERSION_RE.match(entry.name):
                yield entry, json.loads(entry.read_text(encoding="utf-8"))


def referenced_takes(work: Path) -> set[str]:
    """Every take key any manifest version references."""
    keys: set[str] = set()
    for _, manifest in all_manifests(work):
        for line in _lines(manifest):
            take = line.get("take")
            if isinstance(take, str):
                keys.add(take)
    return keys


def _lines(manifest: Mapping[str, object]) -> list[Mapping[str, object]]:
    lines = manifest.get("lines", [])
    return [line for line in lines if isinstance(line, Mapping)] if isinstance(lines, list) else []


def takes_by_line(lines: Sequence[Mapping[str, object]]) -> dict[int, str]:
    return {int(line["i"]): str(line["take"]) for line in lines}  # type: ignore[call-overload]


def changed_lines(parent: Mapping[int, str], child: Mapping[int, str]) -> list[int]:
    """Line ids whose take differs, including lines only one side has."""
    return sorted(i for i in set(parent) | set(child) if parent.get(i) != child.get(i))


def resolve_flags(work: Path, episode: int, flag_ids: Sequence[str]) -> set[int]:
    """The line ids the named flags point at; an unknown flag or another episode's is an error."""
    if not flag_ids:
        return set()
    path = flags_path(work)
    try:
        raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"flags": []}
    except json.JSONDecodeError as failure:
        raise ManifestError(f"{path} is not valid JSON: {failure}") from failure
    flags = raw.get("flags", []) if isinstance(raw, dict) else []
    by_id = {flag.get("id"): flag for flag in flags if isinstance(flag, dict)}
    lines: set[int] = set()
    unknown: list[str] = []
    for flag_id in flag_ids:
        flag = by_id.get(flag_id)
        if flag is None or flag.get("episode") != episode or not isinstance(flag.get("line"), int):
            unknown.append(flag_id)
            continue
        lines.add(flag["line"])
    if unknown:
        raise ManifestError(f"no flag for episode {episode} in {path}: {', '.join(unknown)}", unknown_flags=unknown)
    return lines


def _validate_lines(work: Path, lines: object) -> list[Mapping[str, object]]:
    if not isinstance(lines, list) or not lines:
        raise ManifestError("a manifest needs a non-empty `lines` list")
    seen: set[int] = set()
    missing: list[str] = []
    for line in lines:
        if not isinstance(line, Mapping):
            raise ManifestError("every line must be an object")
        i, take = line.get("i"), line.get("take")
        if not isinstance(i, int) or isinstance(i, bool) or i < 0:
            raise ManifestError(f"line id must be a non-negative integer, got {i!r}")
        if i in seen:
            raise ManifestError(f"line {i} appears twice")
        seen.add(i)
        if not isinstance(take, str) or not KEY_RE.match(take):
            raise ManifestError(f"line {i}: `take` must be a take key")
        if read_take(work, take) is None:
            missing.append(take)
    if missing:
        raise ManifestError(f"line(s) reference takes not in the store: {', '.join(sorted(set(missing)))}", missing_takes=sorted(set(missing)))
    return list(lines)


@dataclass(frozen=True)
class Written:
    path: Path
    manifest: dict[str, object]
    audio: Path | None
    link: Path | None


def write_version(
    work: Path,
    episode: int,
    proposal: Mapping[str, object],
    *,
    flags_applied: Sequence[str] = (),
    audio: Path | None = None,
) -> Written:
    """Writes `v<k+1>` of `episode`, or raises `ManifestError` having written nothing."""
    if isinstance(episode, bool) or not isinstance(episode, int) or episode < 1:
        raise ManifestError(f"episode must be a positive integer, got {episode!r}")
    if audio is not None and not audio.is_file():
        raise ManifestError(f"audio {audio} is not a file")

    lines = _validate_lines(work, proposal.get("lines"))
    found = versions(work, episode)
    parent_version = found[-1] if found else None
    child = takes_by_line(lines)

    if parent_version is None:
        changed = sorted(child)
    else:
        parent = takes_by_line(_lines(read_version(work, episode, parent_version)))
        changed = changed_lines(parent, child)
        flagged = resolve_flags(work, episode, flags_applied)
        offending = [i for i in changed if i not in flagged]
        if offending:
            raise ManifestError(
                f"episode {episode} v{parent_version + 1} would change line(s) {', '.join(map(str, offending))} "
                "that no applied flag names; only flagged lines may change. Nothing was written.",
                offending=offending,
                changed=changed,
                flagged=sorted(flagged),
            )

    version = (parent_version or 0) + 1
    root = episode_dir(work, episode)
    manifest_path = root / f"v{version}.json"
    suffix = audio.suffix if audio is not None and audio.suffix else ".m4a"
    audio_name = f"ep{episode:02d}.v{version}{suffix}"
    manifest: dict[str, object] = {
        "episode": episode,
        "version": version,
        "parent": parent_version,
        **{name: proposal[name] for name in PROPOSED_FIELDS if name in proposal},
        "changed_lines": changed,
        "flags_applied": list(flags_applied),
        "lines": lines,  # validated by `_validate_lines` above
        "audio": audio_name if audio is not None else None,
        "created": now(),
        "by": f"casting {__version__}",
    }

    root.mkdir(parents=True, exist_ok=True)
    ensure_gitignore(work)
    audio_path: Path | None = None
    link: Path | None = None
    if audio is not None:
        audio_path = root / audio_name
        with audio_path.open("xb") as out:  # never overwrites a version's audio
            out.write(audio.read_bytes())
    with manifest_path.open("x", encoding="utf-8") as out:  # never overwrites a version
        out.write(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    if audio_path is not None:
        link = move_link(root, episode, audio_name)
    return Written(path=manifest_path, manifest=manifest, audio=audio_path, link=link)


def move_link(root: Path, episode: int, audio_name: str) -> Path:
    """Points `epNN.<ext>` at `audio_name` (atomically); every version's audio stays where it is."""
    link = root / f"ep{episode:02d}{Path(audio_name).suffix}"
    temporary = root / f".{link.name}.{uuid.uuid4().hex[:8]}"
    os.symlink(audio_name, temporary)
    os.replace(temporary, link)
    return link


def audio_versions(work: Path, episode: int) -> list[int]:
    """The versions that have mixed audio, ascending."""
    return [v for v in versions(work, episode) if read_version(work, episode, v).get("audio")]


def attach_mix(
    work: Path,
    episode: int,
    version: int,
    completed: Mapping[str, object],
    audio: Path,
    *,
    link: bool,
) -> Written:
    """Completes the unmixed `v<version>` in place with what the mix measured (AGT-1684).

    `perform` writes `v<k>.json` with `audio: null` and no line timings; this is
    the one write back into a manifest, and it only fills those gaps: the audio
    name, each line's `start`/`end`, the cues' assets and positions, the final
    `duration` and the `mix` block. A version that already has audio is refused
    (a remix is a new version, `write_version`), and every other field, above
    all each line's `take`, is carried over unchanged and checked.
    """
    manifest = read_version(work, episode, version)
    if manifest.get("audio"):
        raise ManifestError(f"episode {episode} v{version} already has audio ({manifest['audio']}); a remix is a new version")
    if not audio.is_file():
        raise ManifestError(f"audio {audio} is not a file")
    timed = takes_by_line(_lines(completed))
    old = takes_by_line(_lines(manifest))
    if timed != old:
        raise ManifestError(f"the mix would change v{version}'s takes (lines {changed_lines(old, timed)}); a mix only adds timings")
    by_line = {int(line["i"]): line for line in _lines(completed)}  # type: ignore[call-overload]
    merged: list[dict[str, object]] = [
        {**line, "start": by_line[int(line["i"])]["start"], "end": by_line[int(line["i"])]["end"]}  # type: ignore[call-overload]
        for line in _lines(manifest)
    ]
    suffix = audio.suffix or ".m4a"
    audio_name = f"ep{episode:02d}.v{version}{suffix}"
    root = episode_dir(work, episode)
    audio_path = root / audio_name
    if audio_path.exists():
        # Audio a crashed earlier attempt left for a manifest that never learned of it: set aside, never deleted.
        audio_path.rename(root / f"{audio_path.stem}.superseded-{uuid.uuid4().hex[:8]}{suffix}")
    ensure_gitignore(work)
    with audio_path.open("xb") as out:
        out.write(audio.read_bytes())
    updated: dict[str, object] = {
        **manifest,
        "lines": merged,
        "audio": audio_name,
        **{name: completed[name] for name in ("cues", "duration", "mix") if name in completed},
    }
    manifest_path = root / f"v{version}.json"
    temporary = root / f".v{version}.json.{uuid.uuid4().hex[:8]}"
    temporary.write_text(json.dumps(updated, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, manifest_path)
    return Written(path=manifest_path, manifest=updated, audio=audio_path, link=move_link(root, episode, audio_name) if link else None)
