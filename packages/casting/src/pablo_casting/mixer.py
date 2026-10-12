"""The mixer's host side (AGT-1766, pm project `pablo-mixer`): what `pablo mixer`'s window asks of the disk.

`python -m pablo_casting mixer <op> --work W --episode N ...` answers the four reads and writes the mixer
view makes; the view itself never reads a file (`packages/cli/src/mixer-host.ts` carries these to it).

- `mixer load [--version M]`  the mix document (the newest `mix.v<m>.json` unless `--version`), the mix versions
  (who wrote each, when, with what summary), the manifest it was made against (its lines and cues, with the
  cue keys) and the track/lane layout.
- `mixer peaks --source take:KEY|cue:KEY [--stretch S]`  the waveform peaks of one clip source (a take is
  peaked paced, the audio the timeline plays), computed once and cached by content key under
  `<work>/.pablo/casting/peaks/`; a second ask reads the cache and decodes nothing.
- `mixer audio --source take:KEY|cue:KEY [--stretch S]`  that source's audio as a base64 16-bit WAV at the
  mix rate: a take **paced** by its stretch (pacing happens before the timeline, so the preview never
  time-stretches live), a cue as the library holds it.
- `mixer save --base M --from FILE`  the next mix version, `by: "human"`, with a summary of what changed from
  the base. Refused (exit 2, nothing written) when `M` is not the newest version, when the document does not
  validate or fit its manifest, or when nothing changed: `write_mix` opens each version exclusively, so a save
  never replaces a version and two racing saves cannot both land.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import uuid
from collections.abc import Mapping
from pathlib import Path

import numpy as np
import soundfile as sf

from pablo_casting.cues import CueLibrary, CueUnavailable, cue_key
from pablo_casting.manifest import read_version, versions
from pablo_casting.mix import SR, Seams, Sources
from pablo_casting.mixdoc import CUE_TRACK, TRACKS, MixDocError, check_against, clips, mix_versions, read_mix, validate, write_mix
from pablo_casting.takes import KEY_RE, read_take

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_REFUSED = 2

Body = dict[str, object]
Result = tuple[Body, int]

PEAKS_PER_SECOND = 100
PEAKS_VERSION = 1
KINDS = ("take", "cue")


def _refused(message: str, **extra: object) -> Result:
    return {"ok": False, "code": EXIT_REFUSED, "message": message, **extra}, EXIT_REFUSED


def _error(message: str) -> Result:
    return {"ok": False, "code": EXIT_ERROR, "message": message}, EXIT_ERROR


# --- loading ----------------------------------------------------------------------------------------------


def _version_row(doc: Mapping[str, object]) -> dict[str, object]:
    return {name: doc.get(name) for name in ("version", "by", "created", "parent", "manifest_version", "summary")}


def _manifest_view(manifest: Mapping[str, object]) -> dict[str, object]:
    lines = [
        {name: line.get(name) for name in ("i", "speaker", "text", "take", "stretch", "start", "end")}
        for line in manifest.get("lines", [])  # type: ignore[union-attr]
        if isinstance(line, Mapping)
    ]
    cues: list[dict[str, object]] = []
    raw = manifest.get("cues")
    for k, cue in enumerate(raw if isinstance(raw, list) else []):
        if not isinstance(cue, Mapping):
            continue
        kind, desc = cue.get("kind"), cue.get("desc")
        key = cue.get("key")
        if key is None and kind in CUE_TRACK and isinstance(desc, str):
            key = cue_key(str(kind), desc)
        cues.append({"index": k, "kind": kind, "desc": desc, "key": key, "after": cue.get("after"), "line": cue.get("line"), "start": cue.get("start"), "end": cue.get("end")})
    return {"version": manifest.get("version"), "duration": manifest.get("duration"), "lines": lines, "cues": cues}


def _layout(doc: Mapping[str, object]) -> list[dict[str, object]]:
    tracks = doc["tracks"]
    assert isinstance(tracks, Mapping)
    out: list[dict[str, object]] = []
    for name in TRACKS:
        track = tracks[name]
        lanes = [{"name": lane, "clips": len(body["clips"])} for lane, body in track["lanes"].items()]
        out.append({"track": name, "lanes": lanes, "volume": track.get("volume", 0.0), "mute": bool(track.get("mute", False)), "solo": bool(track.get("solo", False)), "automation": len(track.get("automation", []))})
    return out


def cmd_load(work: Path, episode: int, version: int | None) -> Result:
    found = mix_versions(work, episode)
    if not found:
        return _refused(f"episode {episode} has no mix document yet (run pablo mix)", missing=[f"mix.v1.json (episode {episode})"])
    chosen = found[-1] if version is None else version
    if chosen not in found:
        return _refused(f"episode {episode} has no mix v{chosen} (it has {', '.join(f'v{v}' for v in found)})")
    try:
        doc = read_mix(work, episode, chosen)
        rows = [_version_row(read_mix(work, episode, v)) for v in found]
    except (OSError, json.JSONDecodeError) as unreadable:
        return _error(f"a mix document could not be read: {unreadable}")
    problems = validate(doc)
    if problems:
        invalid = MixDocError(problems, where=f"mix.v{chosen}.json")
        return _refused(str(invalid), **invalid.extra)
    manifests = versions(work, episode)
    wanted = doc.get("manifest_version")
    if not isinstance(wanted, int) or wanted not in manifests:
        return _refused(f"mix v{chosen} was made against manifest v{wanted}, which episode {episode} does not have")
    manifest = read_version(work, episode, wanted)
    return {
        "ok": True,
        "episode": episode,
        "version": chosen,
        "newest": found[-1],
        "versions": rows,
        "document": doc,
        "manifest": _manifest_view(manifest),
        "latest_manifest": manifests[-1],
        "layout": _layout(doc),
    }, EXIT_OK


# --- sources: peaks and audio -------------------------------------------------------------------------------


def parse_source(raw: str | None, stretch: float | None) -> tuple[str, str, float] | Result:
    """`(kind, key, stretch)` from `take:KEY` / `cue:KEY`, or the refusal."""
    if not raw or ":" not in raw:
        return _refused("a source is take:<key> or cue:<key>", missing=["--source"])
    kind, _, key = raw.partition(":")
    if kind not in KINDS:
        return _refused(f"source kind must be take or cue, got {kind!r}")
    if not KEY_RE.match(key):
        return _refused(f"source key must be 64 hex characters, got {key!r}")
    if kind == "cue" and stretch not in (None, 1.0):
        return _refused("only a take is paced: a cue takes no stretch")
    pace = 1.0 if stretch is None else float(stretch)
    if not np.isfinite(pace) or pace <= 0:
        return _refused(f"stretch must be a positive number, got {stretch!r}")
    return kind, key, pace


class _NoGeneration:
    """The mixer never makes a cue: a cue not in the library is a refusal, not a model run."""

    id = "mixer/none"

    def generate(self, kind: str, desc: str, seed: int) -> np.ndarray:
        raise CueUnavailable("the mixer does not generate cues")


def _source_audio(work: Path, cues_dir: Path, seams: Seams, kind: str, key: str, stretch: float) -> np.ndarray | Result:
    sources = Sources(work, CueLibrary(cues_dir, lambda _kind: _NoGeneration(), seams.sounds, seams.loudness), seams.pacer, seams.log)
    if kind == "take":
        if read_take(work, key) is None:
            return _refused(f"no take {key[:12]}... in the store", missing=[key])
        paced = sources.paced(key, stretch)
        if paced is None:
            return _refused(f"take {key[:12]}... has no audio in the store", missing=[key])
        return paced.audio
    audio = sources.cue(key, None)
    if audio is None:
        return _refused(f"cue {key[:12]}... is not in the cue library ({cues_dir})", missing=[key])
    return audio


def peaks_path(work: Path, kind: str, key: str, stretch: float) -> Path:
    """The cache file for one source's peaks: named by a hash of everything the peaks depend on."""
    ident = f"{PEAKS_VERSION}:{PEAKS_PER_SECOND}:{SR}:{kind}:{key}:{stretch:.6f}"
    return work / ".pablo" / "casting" / "peaks" / f"{hashlib.sha256(ident.encode()).hexdigest()}.json"


def compute_peaks(audio: np.ndarray) -> list[float]:
    """The largest absolute sample in each 1/`PEAKS_PER_SECOND` s window, 4 decimals."""
    step = SR // PEAKS_PER_SECOND
    count = -(-len(audio) // step)
    padded = np.zeros(count * step, dtype=np.float32)
    padded[: len(audio)] = np.abs(audio)
    return [round(float(v), 4) for v in padded.reshape(count, step).max(axis=1)] if count else []


def cmd_peaks(work: Path, source: str | None, stretch: float | None, cues_dir: Path, seams: Seams) -> Result:
    parsed = parse_source(source, stretch)
    if isinstance(parsed[0], dict):
        return parsed  # type: ignore[return-value]
    kind, key, pace = parsed  # type: ignore[misc]
    cache = peaks_path(work, kind, key, pace)
    try:
        cached = json.loads(cache.read_text(encoding="utf-8"))
        if isinstance(cached, dict) and isinstance(cached.get("peaks"), list):
            return {"ok": True, **cached, "cached": True}, EXIT_OK
    except (OSError, json.JSONDecodeError):
        pass  # no usable cache: compute, and write it afresh
    audio = _source_audio(work, cues_dir, seams, kind, key, pace)
    if isinstance(audio, tuple):
        return audio
    body: Body = {
        "source": {"kind": kind, "key": key, **({"stretch": pace} if kind == "take" else {})},
        "seconds": round(len(audio) / SR, 4),
        "per_second": PEAKS_PER_SECOND,
        "peaks": compute_peaks(audio),
    }
    cache.parent.mkdir(parents=True, exist_ok=True)
    stage = cache.with_name(f".staging-{uuid.uuid4().hex[:8]}.json")
    stage.write_text(json.dumps(body), encoding="utf-8")
    os.replace(stage, cache)
    return {"ok": True, **body, "cached": False}, EXIT_OK


def cmd_audio(work: Path, source: str | None, stretch: float | None, cues_dir: Path, seams: Seams) -> Result:
    parsed = parse_source(source, stretch)
    if isinstance(parsed[0], dict):
        return parsed  # type: ignore[return-value]
    kind, key, pace = parsed  # type: ignore[misc]
    audio = _source_audio(work, cues_dir, seams, kind, key, pace)
    if isinstance(audio, tuple):
        return audio
    buffer = io.BytesIO()
    sf.write(buffer, np.clip(audio, -1.0, 1.0), SR, format="WAV", subtype="PCM_16")
    return {
        "ok": True,
        "source": {"kind": kind, "key": key, **({"stretch": pace} if kind == "take" else {})},
        "mime": "audio/wav",
        "sample_rate": SR,
        "seconds": round(len(audio) / SR, 4),
        "b64": base64.b64encode(buffer.getvalue()).decode("ascii"),
    }, EXIT_OK


# --- saving -------------------------------------------------------------------------------------------------


def _clip_index(doc: Mapping[str, object]) -> dict[str, tuple[str, str, Mapping[str, object]]]:
    return {str(clip["id"]): (track, lane, clip) for track, lane, _, clip in clips(doc)}


def diff_summary(base: Mapping[str, object], new: Mapping[str, object]) -> dict[str, object]:
    """What changed from `base` to `new`: clips added, removed and changed (by id), track settings and the master."""
    before, after = _clip_index(base), _clip_index(new)
    added = sorted(set(after) - set(before))
    removed = sorted(set(before) - set(after))
    changed = sorted(i for i in set(before) & set(after) if before[i] != after[i])
    tracks: list[str] = []
    base_tracks, new_tracks = base["tracks"], new["tracks"]
    assert isinstance(base_tracks, Mapping) and isinstance(new_tracks, Mapping)
    for name in TRACKS:
        a, b = base_tracks[name], new_tracks[name]
        if any(a.get(field, default) != b.get(field, default) for field, default in (("volume", 0.0), ("mute", False), ("solo", False), ("automation", []))):
            tracks.append(name)
    master = base.get("master") != new.get("master")
    parts = [f"{len(added)} clip(s) added" if added else "", f"{len(removed)} removed" if removed else "", f"{len(changed)} changed" if changed else "", f"track settings: {', '.join(tracks)}" if tracks else "", "master changed" if master else ""]
    text = "; ".join(p for p in parts if p)
    return {"added": added, "removed": removed, "changed": changed, "tracks": tracks, "master": master, "text": text}


def cmd_save(work: Path, episode: int, base: int | None, source: str | None) -> Result:
    if base is None or source is None:
        return _refused("mixer save needs --base <the mix version being edited> and --from <the document>", missing=[n for n, v in (("--base", base), ("--from", source)) if v is None])
    found = mix_versions(work, episode)
    if not found:
        return _refused(f"episode {episode} has no mix document yet (run pablo mix)")
    newest = found[-1]
    if base != newest:
        return _refused(
            f"mix v{base} is not the newest (v{newest}); reload v{newest} and apply your edits to it. Nothing was written",
            stale=True,
            base=base,
            newest=newest,
        )
    try:
        proposal = json.loads(Path(source).read_text(encoding="utf-8"))
    except OSError as unreadable:
        return _error(f"--from {source}: {unreadable}")
    except json.JSONDecodeError as broken:
        return _refused(f"--from {source} is not JSON: {broken}", field="(document)")
    if not isinstance(proposal, dict):
        return _refused("the document must be a JSON object", field="(document)")
    proposed: dict[str, object] = {name: proposal[name] for name in ("manifest_version", "tracks", "master") if name in proposal}
    problems = validate({"schema": 1, "by": "human", **proposed})
    if problems:
        invalid = MixDocError(problems)
        return _refused(str(invalid), **invalid.extra)
    wanted = proposed.get("manifest_version")
    if not isinstance(wanted, int) or wanted not in versions(work, episode):
        return _refused(f"manifest_version {wanted!r} is not a manifest version of episode {episode}", field="manifest_version")
    fits = check_against(proposed, read_version(work, episode, wanted))
    if fits:
        invalid = MixDocError(fits)
        return _refused(str(invalid), **invalid.extra)
    try:
        previous = read_mix(work, episode, newest)
    except (OSError, json.JSONDecodeError) as unreadable:
        return _error(f"mix v{newest} could not be read: {unreadable}")
    summary = diff_summary(previous, proposed)
    if not summary["text"]:
        return _refused(f"nothing changed from mix v{newest}; nothing was written", unchanged=True, newest=newest)
    try:
        written = write_mix(work, episode, {**proposed, "summary": summary["text"]}, by="human")
    except MixDocError as invalid:
        return _refused(str(invalid), **invalid.extra)
    except FileExistsError:  # a save raced this one to the same version
        return _refused(f"mix v{newest + 1} was written meanwhile; reload and apply your edits to it. Nothing was written", stale=True, base=base, newest=newest + 1)
    return {
        "ok": True,
        "episode": episode,
        "version": written.document["version"],
        "parent": newest,
        "by": "human",
        "path": str(written.path),
        "summary": summary,
        "document": written.document,
        "versions": [_version_row(read_mix(work, episode, v)) for v in mix_versions(work, episode)],
    }, EXIT_OK


def cmd_mixer(
    op: str | None,
    work: Path,
    episode: str | None,
    version: int | None,
    source: str | None,
    stretch: float | None,
    base: int | None,
    document: str | None,
    cues_dir: Path,
    seams: Seams,
) -> Result:
    if op not in ("load", "peaks", "audio", "save"):
        return _error(f'unknown mixer subcommand "{op}": one of load, peaks, audio, save')
    if op in ("peaks", "audio"):
        # a source is content-addressed: it needs no episode
        return (cmd_peaks if op == "peaks" else cmd_audio)(work, source, stretch, cues_dir, seams)
    if episode is None:
        return _refused(f"mixer {op} needs --episode N", missing=["--episode"])
    try:
        number = int(episode)
    except ValueError:
        return _error(f"--episode must be an integer, got {episode!r}")
    if number < 1:
        return _error(f"--episode must be a positive integer, got {number}")
    if op == "load":
        return cmd_load(work, number, version)
    return cmd_save(work, number, base, document)


__all__ = ["cmd_mixer", "compute_peaks", "diff_summary", "peaks_path"]
