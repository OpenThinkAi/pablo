"""Regenerate a cue from the mixer (AGT-2156, D-19): swap one cue clip's source for another cue asset.

- `mixer cue-options --episode N --clip ID [--describe TEXT]`  what a cue clip could become: the clip's kind and
  current description, and every asset that could voice `(kind, description)`: each matching CC0 recording, best
  first, then the generator's own. `--describe` asks about an edited description; without it the clip's current one.
- `mixer cue --episode N --base M --clip ID [--describe TEXT] [--sound ID | --generated]`  makes that asset (the
  library generates on a miss and only reads on a hit) and writes the next mix version, `by: "human"`, whose clip
  differs in nothing but its `source.key`: its anchor, gain and fades stay. An asset shorter than the clip's
  `out` pulls `in`/`out` back to fit (the render refuses an `out` past the end of its source), and fades shrink
  only if the shortened clip could not hold them. Refused (exit 2, nothing written) when `M` is not the newest
  mix version, the clip is not a cue clip, the generator is unavailable, or the asset is the one already in
  the clip (a cue is content-addressed: the same description is the same asset; edit it, or pick a variation).

The cue library is content-addressed and never overwrites an asset, so nothing but the mix document changes, and
a new mix version is the undo.
"""

from __future__ import annotations

import copy
import json
import math
from collections.abc import Mapping
from pathlib import Path

from pablo_casting.cues import CueLibrary, CueUnavailable
from pablo_casting.manifest import read_version, versions
from pablo_casting.mix import SR, Seams
from pablo_casting.mixdoc import CUE_TRACK, MixDocError, check_against, clips, mix_versions, read_mix, validate, write_mix
from pablo_casting.mixer import EXIT_OK, Result, _error, _refused, _version_row, diff_summary

KIND_OF_TRACK = {track: kind for kind, track in CUE_TRACK.items()}


def _find(doc: Mapping[str, object], clip_id: str | None) -> tuple[str, str, int, Mapping[str, object]] | Result:
    if not clip_id:
        return _refused("a cue needs --clip <the clip's id>", missing=["--clip"])
    for track, lane, k, clip in clips(doc):
        if str(clip.get("id")) == clip_id:
            if clip["source"]["kind"] != "cue" or track not in KIND_OF_TRACK:  # type: ignore[index]
                return _refused(f"clip {clip_id} is not a cue clip (only a cue can be regenerated; a line is re-taken with pablo fix)")
            return track, lane, k, clip
    return _refused(f"the mix has no clip {clip_id}")


def _current_desc(library: CueLibrary, work: Path, doc: Mapping[str, object], clip: Mapping[str, object]) -> str | None:
    """What the clip's cue says now: its asset's sidecar, else the manifest cue it places."""
    sidecar = library.sidecar(str(clip["source"]["key"]))  # type: ignore[index]
    if isinstance(sidecar.get("desc"), str):
        return str(sidecar["desc"])
    try:
        cues = read_version(work, int(doc["episode"]), int(doc["manifest_version"])).get("cues")  # type: ignore[call-overload]
    except (OSError, json.JSONDecodeError, KeyError):
        return None
    index = clip.get("cue")
    if isinstance(cues, list) and isinstance(index, int) and 0 <= index < len(cues) and isinstance(cues[index], Mapping):
        desc = cues[index].get("desc")
        return str(desc) if isinstance(desc, str) else None
    return None


def _open(work: Path, episode: int, clip_id: str | None, describe: str | None, cues_dir: Path, seams: Seams, base: int | None = None, check_base: bool = False) -> tuple[Mapping[str, object], tuple[str, str, int, Mapping[str, object]], str, str, CueLibrary] | Result:
    found = mix_versions(work, episode)
    if not found:
        return _refused(f"episode {episode} has no mix document yet (run pablo mix)")
    newest = found[-1]
    if check_base:
        if base is None:
            return _refused("mixer cue needs --base <the mix version being edited>", missing=["--base"])
        if base != newest:
            return _refused(f"mix v{base} is not the newest (v{newest}); reload v{newest} and apply your edits to it. Nothing was written", stale=True, base=base, newest=newest)
    try:
        doc = read_mix(work, episode, newest)
    except (OSError, json.JSONDecodeError) as unreadable:
        return _error(f"mix v{newest} could not be read: {unreadable}")
    placed = _find(doc, clip_id)
    if isinstance(placed[0], dict):
        return placed  # type: ignore[return-value]
    track, lane, k, clip = placed  # type: ignore[misc]
    library = seams.cue_library(cues_dir)
    desc = describe.strip() if describe is not None and describe.strip() else _current_desc(library, work, doc, clip)
    if not desc:
        return _refused("this cue's description could not be found; pass --describe", missing=["--describe"])
    return doc, (track, lane, k, clip), KIND_OF_TRACK[track], desc, library


def cmd_cue_options(work: Path, episode: int, clip_id: str | None, describe: str | None, cues_dir: Path, seams: Seams) -> Result:
    opened = _open(work, episode, clip_id, describe, cues_dir, seams)
    if isinstance(opened[0], dict) and "ok" in opened[0]:
        return opened  # type: ignore[return-value]
    doc, (_, _, _, clip), kind, desc, library = opened  # type: ignore[misc]
    current = str(clip["source"]["key"])  # type: ignore[index]
    options: list[dict[str, object]] = []
    for match in library.matches(kind, desc):
        key, _, _ = library.resolve(kind, desc, match.sound.id)
        options.append({"id": match.sound.id, "label": match.sound.title or match.sound.id, "generated": False, "score": match.score, "words": [*match.subjects, *match.tags], "key": key, "made": library.path(key).is_file(), "current": key == current})
    key, _, _ = library.resolve(kind, desc, generated=True)
    options.append({"id": None, "label": "generated", "generated": True, "score": None, "words": [], "key": key, "made": library.path(key).is_file(), "current": key == current})
    return {"ok": True, "episode": episode, "version": doc["version"], "clip": clip["id"], "kind": kind, "desc": desc, "key": current, "options": options}, EXIT_OK


def _fit(clip: dict[str, object], seconds: float) -> bool:
    """Pulls `in`/`out` back inside a source of `seconds`, keeping the clip's length when it can; fades shrink only to fit. True when anything moved."""
    lo, hi = float(clip["in"]), float(clip["out"])  # type: ignore[arg-type]
    end = math.floor(seconds * 1000) / 1000
    if hi <= end + 1e-9:
        return False
    length = hi - lo
    clip["out"] = round(end, 4)
    clip["in"] = round(max(0.0, end - length), 4)
    fit = float(clip["out"]) - float(clip["in"])  # type: ignore[arg-type]
    fades = [name for name in ("fade_in", "fade_out") if isinstance(clip.get(name), dict)]
    total = sum(float(clip[name]["len"]) for name in fades)  # type: ignore[index]
    if fades and total > fit:
        for name in fades:
            clip[name] = {**clip[name], "len": round(float(clip[name]["len"]) * fit / total, 4)}  # type: ignore[dict-item,index]
    return True


def cmd_cue(work: Path, episode: int, base: int | None, clip_id: str | None, describe: str | None, sound: str | None, generated: bool, cues_dir: Path, seams: Seams) -> Result:
    if sound is not None and generated:
        return _refused("pick one: --sound <recording> or --generated, not both")
    opened = _open(work, episode, clip_id, describe, cues_dir, seams, base, check_base=True)
    if isinstance(opened[0], dict) and "ok" in opened[0]:
        return opened  # type: ignore[return-value]
    doc, (track, lane, k, clip), kind, desc, library = opened  # type: ignore[misc]
    try:
        asset = library.ensure(kind, desc, sound, generated=generated)
    except CueUnavailable as unavailable:
        return _refused(str(unavailable))
    old = str(clip["source"]["key"])  # type: ignore[index]
    if asset.key == old:
        return _refused(f"clip {clip['id']} already plays that cue ({kind}: {desc}); edit the description or pick a variation", unchanged=True)
    proposal = copy.deepcopy(dict(doc))
    target = proposal["tracks"][track]["lanes"][lane]["clips"][k]  # type: ignore[index]
    target["source"] = {"kind": "cue", "key": asset.key}
    trimmed = _fit(target, asset.seconds)
    manifest_version = int(proposal["manifest_version"])  # type: ignore[call-overload]
    if manifest_version not in versions(work, episode):
        return _refused(f"manifest v{manifest_version} is not a manifest version of episode {episode}")
    body = {name: proposal[name] for name in ("manifest_version", "tracks", "master")}
    problems = validate({"schema": 1, "by": "human", **body}) or check_against(body, read_version(work, episode, manifest_version))
    if problems:
        invalid = MixDocError(problems)
        return _refused(str(invalid), **invalid.extra)
    summary = diff_summary(doc, body)
    text = f"cue {clip['id']} regenerated ({kind}: {desc})"
    try:
        written = write_mix(work, episode, {**body, "summary": text}, by="human")
    except MixDocError as invalid:
        return _refused(str(invalid), **invalid.extra)
    except FileExistsError:
        return _refused(f"mix v{int(doc['version']) + 1} was written meanwhile; reload and try again. Nothing was written", stale=True)  # type: ignore[call-overload]
    return {
        "ok": True,
        "episode": episode,
        "version": written.document["version"],
        "parent": doc["version"],
        "by": "human",
        "clip": clip["id"],
        "kind": kind,
        "desc": desc,
        "key": asset.key,
        "was": old,
        "made": asset.generated,
        "sound": asset.sound,
        "trimmed": trimmed,
        "path": str(written.path),
        "summary": {**summary, "text": text},
        "document": written.document,
        "versions": [_version_row(read_mix(work, episode, v)) for v in mix_versions(work, episode)],
        "message": f"{text}: {'made' if asset.generated else 'reused'} {asset.key[:12]} ({asset.seconds:.2f} s){'; the clip was pulled back to fit' if trimmed else ''}",
    }, EXIT_OK


__all__ = ["cmd_cue", "cmd_cue_options"]
