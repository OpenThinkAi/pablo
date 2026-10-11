"""The mix document: `renders/epNN/mix.v<m>.json` (AGT-1764, pm project `pablo-mixer`).

An episode's mix is data, not code: four fixed tracks of non-destructive clips
anchored to the script's lines, each with gain and fades, plus per-track volume,
mute, solo and a volume automation lane, and a master. `mix.py` renders a
document; `pablo mix` with no document writes `mix.v1` with `by: "auto"` that
expresses the automatic rules as clips (the mixer will write `by: "human"`
versions). Versioned like manifests and never rewritten: `write_mix` opens each
version exclusively.

    {
      "schema": 1, "episode": 1, "version": 1, "manifest_version": 1,
      "parent": null, "by": "auto" | "human", "created": "...",
      "tracks": {
        "dialogue": {"lanes": {"CORA": {"clips": [clip, ...]}, ...},
                     "volume": 0.0, "mute": false, "solo": false, "automation": [point, ...]},
        "sfx": {...}, "beds": {...}, "music": {...}
      },
      "master": {"gain": 0.0, "peak_db": -1.0, "target_lufs": null}
    }

    clip  = {"id": "line-3",
             "source": {"kind": "take", "key": <take key>, "stretch": 1.0}   # dialogue only
                     | {"kind": "cue", "key": <cue key>},                     # sfx, beds, music
             "lines": [3],          # take clips: the line ids this clip voices
             "cue": 2,              # cue clips (optional): the manifest cue it places
             "in": 0.0, "out": 2.4, # seconds into the (paced) source that play
             "anchor": {"line": 2, "edge": "start" | "end", "offset": 0.35} | {"at": 0.0},
             "gain": 0.0,           # dB
             "fade_in":  {"len": 0.0, "curve": "linear" | "scurve" | "log" | "exp"},
             "fade_out": {"len": 0.0, "curve": ...}}
    point = {"anchor": <as a clip's>, "db": -6.0, "curve": "linear"}

- **Anchors.** A line's `start`/`end` edge is the earliest start / latest end of
  the take clips that list it; a clip's start is its anchor's edge plus
  `offset`, or `at` seconds. A take is paced by `source.stretch` before it
  reaches the timeline, so `in`/`out` are seconds of the paced take.
- **Overlap** on separate lanes is allowed; two overlapping clips on the same
  lane crossfade (equal power) over the overlap.
- **Tracks** are exactly `dialogue`, `sfx`, `beds`, `music`; each lane name is
  free (dialogue's are roles; the auto mix uses `main` for the others).
- **Master.** `gain` dB, then the sum is scaled so its peak is `peak_db` dBFS
  (`null`: no peak normalising). Loudness (`target_lufs`) is out of scope for
  v1 and must be `null`.

`validate` checks the shape alone and returns every problem, each naming its
field (`tracks.dialogue.lanes.CORA.clips[2].fade_in.curve`); `check_against`
checks the references against the manifest the document is rendered with.
Either one failing is a refusal (exit 2) and nothing is written.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from pablo_casting.manifest import episode_dir
from pablo_casting.mixmath import CURVES
from pablo_casting.receipts import now
from pablo_casting.takes import KEY_RE

SCHEMA = 1
TRACKS = ("dialogue", "sfx", "beds", "music")
CUE_TRACK = {"SFX": "sfx", "BED": "beds", "MUSIC": "music"}
EDGES = ("start", "end")
BY = ("auto", "human")
MIX_RE = re.compile(r"^mix\.v(\d+)\.json$")
# Fields a caller proposes; `write_mix` sets schema, episode, version, parent, by and created itself.
PROPOSED = ("manifest_version", "tracks", "master", "summary")


@dataclass(frozen=True)
class Problem:
    field: str
    problem: str

    def __str__(self) -> str:
        return f"{self.field}: {self.problem}"


class MixDocError(Exception):
    """The document is not a mix document (exit 2); `problems` names each field."""

    def __init__(self, problems: Sequence[Problem], *, where: str = "mix document") -> None:
        self.problems = list(problems)
        first = self.problems[0] if self.problems else Problem("", "invalid")
        more = f" (and {len(self.problems) - 1} more)" if len(self.problems) > 1 else ""
        super().__init__(f"{where}: {first}{more}")

    @property
    def extra(self) -> dict[str, object]:
        return {"field": self.problems[0].field if self.problems else None, "problems": [{"field": p.field, "problem": p.problem} for p in self.problems]}


# --- the shape ------------------------------------------------------------------------------


def _number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


class _Checker:
    def __init__(self) -> None:
        self.problems: list[Problem] = []

    def add(self, field: str, problem: str) -> None:
        self.problems.append(Problem(field, problem))

    def number(self, obj: Mapping[str, object], name: str, at: str, *, required: bool = False, minimum: float | None = None) -> None:
        if name not in obj:
            if required:
                self.add(f"{at}.{name}", "is required")
            return
        value = obj[name]
        if not _number(value):
            self.add(f"{at}.{name}", f"must be a finite number, got {value!r}")
        elif minimum is not None and float(value) < minimum:  # type: ignore[arg-type]
            self.add(f"{at}.{name}", f"must be >= {minimum:g}, got {value!r}")

    def boolean(self, obj: Mapping[str, object], name: str, at: str) -> None:
        if name in obj and not isinstance(obj[name], bool):
            self.add(f"{at}.{name}", f"must be true or false, got {obj[name]!r}")

    def anchor(self, value: object, at: str) -> None:
        if not isinstance(value, Mapping):
            self.add(at, "must be {line, edge, offset} or {at}")
            return
        if "at" in value:
            extra = sorted(set(value) - {"at"})
            if extra:
                self.add(at, f"an {{at}} anchor takes no other fields, got {', '.join(extra)}")
            self.number(value, "at", at, minimum=0.0)
            return
        if "line" not in value:
            self.add(at, "must be {line, edge, offset} or {at}")
            return
        if not _int(value["line"]) or int(value["line"]) < 0:  # type: ignore[call-overload]
            self.add(f"{at}.line", f"must be a line id (a non-negative integer), got {value['line']!r}")
        if value.get("edge") not in EDGES:
            self.add(f"{at}.edge", f"must be one of {', '.join(EDGES)}, got {value.get('edge')!r}")
        self.number(value, "offset", at)

    def fade(self, value: object, at: str) -> float:
        if not isinstance(value, Mapping):
            self.add(at, "must be {len, curve}")
            return 0.0
        self.number(value, "len", at, required=True, minimum=0.0)
        if value.get("curve", "linear") not in CURVES:
            self.add(f"{at}.curve", f"must be one of {', '.join(CURVES)}, got {value.get('curve')!r}")
        length = value.get("len")
        return float(length) if _number(length) else 0.0  # type: ignore[arg-type]

    def clip(self, clip: object, at: str, track: str, ids: dict[str, str]) -> None:
        if not isinstance(clip, Mapping):
            self.add(at, "must be an object")
            return
        clip_id = clip.get("id")
        if not isinstance(clip_id, str) or not clip_id:
            self.add(f"{at}.id", "must be a non-empty string")
        elif clip_id in ids:
            self.add(f"{at}.id", f"{clip_id!r} is already used by {ids[clip_id]}")
        else:
            ids[clip_id] = at
        source = clip.get("source")
        want = "take" if track == "dialogue" else "cue"
        if not isinstance(source, Mapping):
            self.add(f"{at}.source", "is required: {kind, key}")
        else:
            kind = source.get("kind")
            if kind not in ("take", "cue"):
                self.add(f"{at}.source.kind", f"must be take or cue, got {kind!r}")
            elif kind != want:
                self.add(f"{at}.source.kind", f"the {track} track holds {want} clips, not {kind}")
            key = source.get("key")
            if not isinstance(key, str) or not KEY_RE.match(key):
                self.add(f"{at}.source.key", f"must be a {kind if kind in ('take', 'cue') else 'source'} key (64 hex characters), got {key!r}")
            if kind == "take":
                self.number(source, "stretch", f"{at}.source", minimum=1e-6)
            elif "stretch" in source:
                self.add(f"{at}.source.stretch", "only a take is paced")
        if track == "dialogue":
            lines = clip.get("lines")
            if not isinstance(lines, list) or not lines or not all(_int(i) and int(i) >= 0 for i in lines):  # type: ignore[call-overload]
                self.add(f"{at}.lines", "must be a non-empty list of the line ids this clip voices")
        elif "lines" in clip:
            self.add(f"{at}.lines", "only a dialogue clip voices lines")
        if "cue" in clip and (not _int(clip["cue"]) or int(clip["cue"]) < 0):  # type: ignore[call-overload]
            self.add(f"{at}.cue", f"must be a cue index (a non-negative integer), got {clip['cue']!r}")
        self.number(clip, "in", at, required=True, minimum=0.0)
        self.number(clip, "out", at, required=True)
        start, end = clip.get("in"), clip.get("out")
        if _number(start) and _number(end) and float(end) <= float(start):  # type: ignore[arg-type]
            self.add(f"{at}.out", f"must be after in ({start!r}), got {end!r}")
        if "anchor" not in clip:
            self.add(f"{at}.anchor", "is required: {line, edge, offset} or {at}")
        else:
            self.anchor(clip["anchor"], f"{at}.anchor")
        self.number(clip, "gain", at)
        fades = 0.0
        for name in ("fade_in", "fade_out"):
            if name in clip:
                fades += self.fade(clip[name], f"{at}.{name}")
        if _number(start) and _number(end) and fades > float(end) - float(start) + 1e-9:  # type: ignore[arg-type]
            self.add(f"{at}.fade_out", f"fade_in.len + fade_out.len ({fades:g} s) is longer than the clip ({float(end) - float(start):g} s)")  # type: ignore[arg-type]

    def track(self, track: object, name: str, ids: dict[str, str]) -> None:
        at = f"tracks.{name}"
        if not isinstance(track, Mapping):
            self.add(at, "must be an object with lanes")
            return
        unknown = sorted(set(track) - {"lanes", "volume", "mute", "solo", "automation"})
        for field in unknown:
            self.add(f"{at}.{field}", "is not a track field (lanes, volume, mute, solo, automation)")
        lanes = track.get("lanes")
        if not isinstance(lanes, Mapping):
            self.add(f"{at}.lanes", "must be an object of lanes, each {clips: [...]}")
        else:
            for lane, body in lanes.items():
                where = f"{at}.lanes.{lane}"
                if not isinstance(lane, str) or not lane:
                    self.add(where, "a lane needs a name")
                if not isinstance(body, Mapping) or not isinstance(body.get("clips"), list):
                    self.add(f"{where}.clips", "must be a list of clips")
                    continue
                for k, clip in enumerate(body["clips"]):  # type: ignore[arg-type]
                    self.clip(clip, f"{where}.clips[{k}]", name, ids)
        self.number(track, "volume", at)
        self.boolean(track, "mute", at)
        self.boolean(track, "solo", at)
        automation = track.get("automation", [])
        if not isinstance(automation, list):
            self.add(f"{at}.automation", "must be a list of breakpoints")
            return
        for k, point in enumerate(automation):
            where = f"{at}.automation[{k}]"
            if not isinstance(point, Mapping):
                self.add(where, "must be {anchor, db, curve}")
                continue
            if "anchor" not in point:
                self.add(f"{where}.anchor", "is required")
            else:
                self.anchor(point["anchor"], f"{where}.anchor")
            self.number(point, "db", where, required=True)
            if point.get("curve", "linear") not in CURVES:
                self.add(f"{where}.curve", f"must be one of {', '.join(CURVES)}, got {point.get('curve')!r}")


def validate(doc: object) -> list[Problem]:
    """Every shape problem in `doc`, each naming its field; `[]` when it is a mix document."""
    check = _Checker()
    if not isinstance(doc, Mapping):
        return [Problem("(document)", "must be a JSON object")]
    if doc.get("schema", SCHEMA) != SCHEMA:
        check.add("schema", f"must be {SCHEMA}, got {doc.get('schema')!r}")
    if "by" in doc and doc["by"] not in BY:
        check.add("by", f"must be one of {', '.join(BY)}, got {doc['by']!r}")
    if "manifest_version" in doc and (not _int(doc["manifest_version"]) or int(doc["manifest_version"]) < 1):  # type: ignore[call-overload]
        check.add("manifest_version", f"must be a positive integer, got {doc['manifest_version']!r}")
    tracks = doc.get("tracks")
    ids: dict[str, str] = {}
    if not isinstance(tracks, Mapping):
        check.add("tracks", f"is required: an object with {', '.join(TRACKS)}")
    else:
        for name in tracks:
            if name not in TRACKS:
                check.add(f"tracks.{name}", f"is not a track (the tracks are {', '.join(TRACKS)})")
        for name in TRACKS:
            if name not in tracks:
                check.add(f"tracks.{name}", "is required")
            else:
                check.track(tracks[name], name, ids)
    master = doc.get("master")
    if not isinstance(master, Mapping):
        check.add("master", "is required: {gain, peak_db, target_lufs}")
    else:
        check.number(master, "gain", "master")
        if master.get("peak_db") is not None:
            check.number(master, "peak_db", "master")
            if _number(master["peak_db"]) and float(master["peak_db"]) > 0:  # type: ignore[arg-type]
                check.add("master.peak_db", f"must be <= 0 dBFS, got {master['peak_db']!r}")
        if master.get("target_lufs") is not None:
            check.add("master.target_lufs", "loudness normalising is not built yet (v1): use null and peak_db")
    return check.problems


def clips(doc: Mapping[str, object]) -> Iterator[tuple[str, str, int, Mapping[str, object]]]:
    """`(track, lane, index, clip)` for every clip of a validated document."""
    tracks = doc["tracks"]
    assert isinstance(tracks, Mapping)
    for name in TRACKS:
        lanes = tracks[name]["lanes"]
        for lane, body in lanes.items():
            for k, clip in enumerate(body["clips"]):
                yield name, lane, k, clip


def clip_field(track: str, lane: str, k: int) -> str:
    return f"tracks.{track}.lanes.{lane}.clips[{k}]"


def voiced_takes(doc: Mapping[str, object]) -> dict[int, str]:
    """Line id -> the take key of the clip(s) voicing it."""
    out: dict[int, str] = {}
    for track, _, _, clip in clips(doc):
        if track == "dialogue":
            for i in clip["lines"]:  # type: ignore[union-attr]
                out[int(i)] = str(clip["source"]["key"])  # type: ignore[index]
    return out


def check_against(doc: Mapping[str, object], manifest: Mapping[str, object]) -> list[Problem]:
    """References in a validated `doc` that the manifest it is rendered with cannot satisfy."""
    raw = manifest.get("lines")
    lines = {int(l["i"]): l for l in raw if isinstance(l, Mapping)} if isinstance(raw, list) else {}  # type: ignore[call-overload]
    raw_cues = manifest.get("cues")
    cue_count = len(raw_cues) if isinstance(raw_cues, list) else 0
    problems: list[Problem] = []
    voiced: set[int] = set()

    def anchor(value: Mapping[str, object], at: str) -> None:
        if "line" in value and int(value["line"]) not in lines:  # type: ignore[call-overload]
            problems.append(Problem(f"{at}.line", f"line {value['line']} is not in manifest v{manifest.get('version')}"))

    for track, lane, k, clip in clips(doc):
        at = clip_field(track, lane, k)
        anchor(clip["anchor"], f"{at}.anchor")  # type: ignore[arg-type]
        if track == "dialogue":
            for i in clip["lines"]:  # type: ignore[union-attr]
                if int(i) not in lines:
                    problems.append(Problem(f"{at}.lines", f"line {i} is not in manifest v{manifest.get('version')}"))
                voiced.add(int(i))
        if "cue" in clip and int(clip["cue"]) >= cue_count:  # type: ignore[call-overload]
            problems.append(Problem(f"{at}.cue", f"manifest v{manifest.get('version')} has {cue_count} cue(s), there is no cue {clip['cue']}"))
    tracks = doc["tracks"]
    assert isinstance(tracks, Mapping)
    for name in TRACKS:
        for k, point in enumerate(tracks[name].get("automation", [])):
            anchor(point["anchor"], f"tracks.{name}.automation[{k}].anchor")
    for i in sorted(set(lines) - voiced):
        problems.append(Problem("tracks.dialogue", f"line {i} has no dialogue clip (every line needs one: its timings are written into the manifest)"))
    return problems


def compatible(doc: Mapping[str, object], manifest: Mapping[str, object]) -> bool:
    """Whether `doc` voices exactly the manifest's lines with the manifest's takes (a remix keeps it; a re-take does not)."""
    raw = manifest.get("lines")
    takes = {int(l["i"]): str(l["take"]) for l in raw if isinstance(l, Mapping)} if isinstance(raw, list) else {}  # type: ignore[call-overload]
    if validate(doc):
        return False
    return voiced_takes(doc) == takes and not check_against(doc, manifest)


# --- versions -------------------------------------------------------------------------------


def mix_path(work: Path, episode: int, version: int) -> Path:
    return episode_dir(work, episode) / f"mix.v{version}.json"


def mix_versions(work: Path, episode: int) -> list[int]:
    root = episode_dir(work, episode)
    if not root.is_dir():
        return []
    found = (MIX_RE.match(entry.name) for entry in root.iterdir())
    return sorted(int(match.group(1)) for match in found if match)


def read_mix(work: Path, episode: int, version: int) -> dict[str, object]:
    return json.loads(mix_path(work, episode, version).read_text(encoding="utf-8"))


@dataclass(frozen=True)
class WrittenMix:
    path: Path
    document: dict[str, object]


def write_mix(work: Path, episode: int, proposal: Mapping[str, object], *, by: str) -> WrittenMix:
    """Writes `mix.v<m+1>.json` (never over an existing version), or raises `MixDocError` having written nothing."""
    if by not in BY:
        raise ValueError(f"by must be one of {', '.join(BY)}")
    found = mix_versions(work, episode)
    parent = found[-1] if found else None
    version = (parent or 0) + 1
    doc: dict[str, object] = {
        "schema": SCHEMA,
        "episode": episode,
        "version": version,
        "manifest_version": proposal.get("manifest_version"),
        "parent": parent,
        "by": by,
        "created": now(),
        **({"summary": proposal["summary"]} if "summary" in proposal else {}),
        "tracks": proposal.get("tracks"),
        "master": proposal.get("master"),
    }
    problems = validate(doc)
    if problems:
        raise MixDocError(problems)
    path = mix_path(work, episode, version)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as out:  # never rewrites a version
        out.write(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    return WrittenMix(path=path, document=doc)


__all__ = [
    "CUE_TRACK",
    "MixDocError",
    "Problem",
    "TRACKS",
    "check_against",
    "clip_field",
    "clips",
    "compatible",
    "mix_path",
    "mix_versions",
    "read_mix",
    "validate",
    "voiced_takes",
    "write_mix",
]
