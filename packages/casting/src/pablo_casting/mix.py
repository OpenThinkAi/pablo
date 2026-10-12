"""`mix --work W --episode N [--version k] [--from DOC]`: the episode file (AGT-1684, AGT-1764).

Renders an episode from a **mix document** (`mixdoc.py`, `renders/epNN/mix.v<m>.json`:
tracks of clips anchored to lines, with gain, fades, crossfades, automation and
a master), encodes `renders/epNN/epNN.v<k>.m4a`, moves the `epNN.m4a` link and
writes each line's `start`/`end` back into the manifest. Which document:

- `--from DOC`: a hand-made document, validated, checked against the manifest
  and written as the next mix version with `by: "human"`;
- else the newest mix version, when it voices exactly the manifest's lines with
  the manifest's takes (a remix keeps it, hand edits to it included);
- else the auto mix (`auto_document`), written as the next mix version with
  `by: "auto"` (`mix.v1` on a first mix). After `fix` re-takes a line the
  newest document no longer fits; a human one is then named in
  `supersededMix` (carrying its edits over is AGT-1772's rebase, M8).

The auto mix is a `Timeline` (AGT-1697's progressive render builds the same
one line by line and streams its settled samples): its clips are the document
it writes, and its mixdown and a document's render are one function
(`_mix_range`, then `master`). Its rules are the prototype's (`radio/produce.py:463-573` in the
Valley's Shadow sandbox), expressed as clips:

- the voice track is the takes in line order, each paced by its manifest
  `stretch` (a sox WSOLA `tempo -s`; takes themselves are never paced on disk),
  with 0.35 s of air after each take;
- a cue sits where the manifest says (`after`: the spoken line it follows, -1 =
  before the first). An SFX starts 0.4 s early, over the air before it, at
  0.75 gain; MUSIC starts at once at 0.9 gain; both hold the voice track for
  their whole length plus 0.2 s;
- a BED runs from its cue to the next BED cue (or the end of the speech) at 0.16
  gain with 1.5 s fades (a quarter of its span at most); `[BED: off]` ends it with
  nothing in its place. It is not a loop: it is segments of its asset at varied
  offsets, each crossfading into the next (`BedPlan`, seeded by the cue key), so
  nothing in a 20 s clip comes back on a fixed period (AGT-1767) - except a
  rhythmic bed (a clock), whose asset carries a loop of whole tick cycles and is
  that loop back to back (`LoopPlan`, AGT-1799), so it ticks on its period;
- every cue is at its kind's loudness target before these gains (`cues.py`,
  `loudness.py`), and SFX and BED cues are real CC0 recordings when the sound
  library has a match (`sounds.py`); `--auto` writes a fresh auto mix even when
  the newest document still fits (after the library changed);
- a MUSIC cue sounding over an open bed ducks the beds track (volume automation:
  out over 0.5 s before the cue, -96 dB through it, back over 0.5 s after, or by
  the time a new bed starts); the last MUSIC cue, when it follows a spoken line
  and no bed is cued after it, is the closing theme: it ends every bed, and a bed
  cued at or after it never starts;
- the sum is scaled under 0.95 peak, then to -1 dBFS (the prototype's sox
  `gain -n -1`), and encoded to AAC at 160 kb/s.

**Timings.** A line's `start` and `end` are where its first and last words are
in the final file: the take's own word timings (the aligner's, in
`take.json`), scaled by the pace the take was actually given, plus where the
mix put the take. That is the time the player highlights and the one
`check_timings` re-measures with the aligner on the final file.

**Versions.** A manifest is completed in place only while it has no audio
(`manifest.attach_mix`: the audio name, line timings, cue assets, duration and
a `mix` block; no take changes). Mixing a version that already has audio is a
mix change: a new version with identical takes (`changed_lines: []`, through
`write_version`), its own audio file, the link moved to it. Earlier versions'
audio and manifests are never touched. `--version k` mixes an older version
only while it is unmixed; the link then moves only if no newer version has audio.

Refusals (exit 2, nothing written): no manifest for the episode, an unknown
version, a take missing from the store, an older version that already has
audio, a missing generator (`mix` extra, sox) or encoder (afconvert, ffmpeg),
a mix document that is not one or does not fit the manifest (the body's
`field` and `problems` name each field).

The gain, fade, crossfade and automation formulas are `mixmath.py`'s
(AGT-1765's shared spec, which the mixer's preview follows too).
"""

from __future__ import annotations

import hashlib
import json
import random
import shutil
import subprocess
import tempfile
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import soundfile as sf

from pablo_casting.audio import read_audio, resample
from pablo_casting.cues import CUE_RATE, CueAsset, CueLibrary, CueUnavailable, GeneratorFactory, cue_key, is_stop
from pablo_casting.manifest import ManifestError, attach_mix, audio_versions, episode_dir, read_version, versions, write_version
from pablo_casting.mixdoc import (
    CUE_TRACK,
    TRACKS,
    MixDocError,
    Problem,
    check_against,
    clip_field,
    compatible,
    clips,
    mix_versions,
    read_mix,
    validate,
    write_mix,
)
from pablo_casting.mixmath import apply_fade, automation_gain_at, db_to_gain, equal_power_crossfade, gain_to_db
from pablo_casting.library import LibraryRefusal, resolve_root
from pablo_casting.organ import SoxUnavailable, require_sox
from pablo_casting.receipts import append_receipt
from pablo_casting.sounds import SoundLibrary
from pablo_casting.takes import casting_dir, read_take
from pablo_casting.words import script_word_count

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_REFUSED = 2

SR = CUE_RATE
GAP_SECONDS = 0.35
SFX_OVERLAP_SECONDS = 0.4
CUE_TAIL_SECONDS = 0.2
END_PAD_SECONDS = 1.0
CUE_GAIN = {"SFX": 0.75, "MUSIC": 0.9}
BED_GAIN = 0.16
BED_FADE_SECONDS = 1.5
BED_XFADE_SECONDS = 1.5
"""The most two segments of one bed overlap (equal-power). It is no more than `BED_FADE_SECONDS` so the streamed frontier, which holds that far behind an open bed, covers a segment dropped or cut where the bed closes."""
BED_DUCK_SECONDS = 0.5
BED_DUCK_DB = -96.0
"""A bed is ducked to -96 dB (below 16-bit resolution at its 0.16 gain) for a MUSIC cue's whole span, over `BED_DUCK_SECONDS` each way."""
PEAK = 0.95
FINAL_PEAK_DB = -1.0
AAC_BITRATE = 160_000

Body = dict[str, object]
Result = tuple[Body, int]
Pacer = Callable[[np.ndarray, int, float], np.ndarray]
"""`(audio, sample_rate, stretch) -> audio` at `stretch` times the speed."""
Encoder = Callable[[Path, Path], None]
"""`(wav, destination)`: encodes the mixed WAV into the episode file."""


class MixRefusal(Exception):
    """The mix cannot run (exit 2); nothing was written."""

    def __init__(self, message: str, **extra: object) -> None:
        super().__init__(message)
        self.extra = extra


# --- the real pacer and encoder -----------------------------------------------------------


def sox_pacer(audio: np.ndarray, rate: int, stretch: float) -> np.ndarray:
    """Speeds `audio` by `stretch` with sox's WSOLA `tempo -s` (speech setting)."""
    if abs(stretch - 1.0) < 1e-6:
        return audio
    sox = require_sox()
    with tempfile.TemporaryDirectory(prefix="pablo-pace-") as scratch:
        source, paced = Path(scratch) / "in.wav", Path(scratch) / "out.wav"
        sf.write(str(source), audio, rate, subtype="FLOAT")
        subprocess.run([sox, str(source), str(paced), "tempo", "-s", f"{stretch:.6f}"], check=True, stderr=subprocess.DEVNULL)
        out, out_rate = sf.read(str(paced), dtype="float32", always_2d=True)
    assert out_rate == rate
    return np.ascontiguousarray(out.mean(axis=1), dtype=np.float32)


def aac_encoder(wav: Path, destination: Path) -> None:
    """AAC in an m4a at 160 kb/s: afconvert (macOS), else ffmpeg."""
    afconvert = shutil.which("afconvert")
    if afconvert is not None:
        subprocess.run([afconvert, "-f", "m4af", "-d", "aac", "-b", str(AAC_BITRATE), str(wav), str(destination)], check=True)
        return
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise MixRefusal("no AAC encoder: install ffmpeg (brew install ffmpeg) or run on macOS (afconvert)")
    subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-i", str(wav), "-c:a", "aac", "-b:a", str(AAC_BITRATE), str(destination)], check=True)


# --- the timeline ---------------------------------------------------------------------------


@dataclass
class Rendered:
    audio: np.ndarray
    lines: list[dict[str, object]]
    cues: list[dict[str, object]]
    cues_generated: int
    cues_reused: int
    peak_before: float


@dataclass
class _Take:
    audio: np.ndarray  # raw, at its own rate
    rate: int
    words: list[Mapping[str, object]]


def _words(record: Mapping[str, object]) -> list[Mapping[str, object]]:
    timings = record.get("timings")
    words = timings.get("words") if isinstance(timings, Mapping) else None
    return [w for w in words if isinstance(w, Mapping)] if isinstance(words, list) else []


def _group_lines(lines: Sequence[Mapping[str, object]]) -> list[list[Mapping[str, object]]]:
    """Consecutive lines that share one take (a Dia pass voices several) form one group."""
    groups: list[list[Mapping[str, object]]] = []
    for line in lines:
        if groups and groups[-1][-1]["take"] == line["take"] and int(groups[-1][-1]["i"]) + 1 == int(line["i"]):  # type: ignore[call-overload]
            groups[-1].append(line)
        else:
            groups.append([line])
    return groups


def _split_words(words: Sequence[Mapping[str, object]], group: Sequence[Mapping[str, object]], span: tuple[float, float]) -> list[tuple[float, float]]:
    """Each line of a group's (first start, last end) in seconds of the raw take."""
    if len(group) == 1:
        if words:
            return [(float(words[0]["start"]), float(words[-1]["end"]))]  # type: ignore[arg-type]
        return [span]
    counts = [max(1, script_word_count(str(line.get("text", "")))) for line in group]
    if words and sum(counts) <= len(words):
        out: list[tuple[float, float]] = []
        at = 0
        for count in counts:
            chunk = words[at : at + count]
            out.append((float(chunk[0]["start"]), float(chunk[-1]["end"])))  # type: ignore[arg-type]
            at += count
        return out
    # No usable word timings: split the group's span by each line's share of the words.
    first, last = (float(words[0]["start"]), float(words[-1]["end"])) if words else span  # type: ignore[arg-type]
    total = sum(counts)
    out = []
    at_words = 0
    for count in counts:
        out.append((first + (last - first) * at_words / total, first + (last - first) * (at_words + count) / total))
        at_words += count
    return out


def warp_times(raw: np.ndarray, paced: np.ndarray, rate: int, times: Sequence[float]) -> list[float]:
    """Where moments of the raw take (seconds) are in the paced take.

    WSOLA does not stretch time uniformly (it keeps speech frames and lengthens
    or drops the quieter stretches between them), so a single length ratio puts
    word ends a few hundred ms off on a heavily paced take. The speech's own
    energy is what pacing preserves: a moment at fraction F of the take's
    cumulative energy is at fraction F of the paced take's.
    """
    if len(raw) == len(paced) or len(raw) == 0 or len(paced) == 0:
        return [float(t) for t in times]
    scale = len(paced) / len(raw)

    def active(x: np.ndarray) -> tuple[int, int] | None:
        loud = np.flatnonzero(np.abs(x) > 0.02 * float(np.abs(x).max()))
        return (int(loud[0]), int(loud[-1]) + 1) if len(loud) else None

    span_raw, span_paced = active(raw), active(paced)
    if span_raw is None or span_paced is None:
        return [float(t) * scale for t in times]
    # Between the first and last audible sample the energy decides; outside them (the leading and
    # trailing air, where cumulative energy is flat and says nothing) the ends are anchored to it.
    inner_raw, inner_paced = raw[span_raw[0] : span_raw[1]].astype(np.float64), paced[span_paced[0] : span_paced[1]].astype(np.float64)
    e_raw, e_paced = np.cumsum(inner_raw**2), np.cumsum(inner_paced**2)
    out: list[float] = []
    for t in times:
        n = float(t) * rate
        if n <= span_raw[0]:
            m = span_paced[0] - (span_raw[0] - n)
        elif n >= span_raw[1]:
            m = span_paced[1] + (n - span_raw[1])
        else:
            fraction = float(np.interp(n - span_raw[0], np.arange(len(inner_raw)), e_raw / e_raw[-1]))
            m = span_paced[0] + float(np.interp(fraction, e_paced / e_paced[-1], np.arange(len(inner_paced))))
        out.append(max(0.0, m) / rate)
    return out


@dataclass
class _Paced:
    take: _Take
    paced: np.ndarray  # at the take's own rate
    audio: np.ndarray  # at SR: what the timeline plays


class Sources:
    """Every clip source of one mix run, loaded once: paced takes and cue assets, both at `SR`."""

    def __init__(self, work: Path, library: CueLibrary, pacer: Pacer, log: Callable[[str], None] = lambda message: None) -> None:
        self.work, self.library, self.pacer, self.log = work, library, pacer, log
        self._takes: dict[str, _Take | None] = {}
        self._paced: dict[tuple[str, float], _Paced] = {}
        self._cues: dict[str, np.ndarray] = {}
        self.generated = 0
        self.reused = 0

    def take(self, key: str) -> _Take | None:
        if key not in self._takes:
            stored = read_take(self.work, key)
            if stored is None or not (stored.path / "take.wav").is_file():
                self._takes[key] = None
            else:
                audio, rate = read_audio(stored.path / "take.wav")
                self._takes[key] = _Take(audio=audio, rate=rate, words=_words(stored.record))
        return self._takes[key]

    def paced(self, key: str, stretch: float) -> _Paced | None:
        """The take paced by `stretch` (pacing happens before the timeline), or None when the store lacks it."""
        if (key, stretch) not in self._paced:
            take = self.take(key)
            if take is None:
                return None
            paced = self.pacer(take.audio, take.rate, stretch)
            self._paced[(key, stretch)] = _Paced(take=take, paced=paced, audio=resample(paced, take.rate, SR))
        return self._paced[(key, stretch)]

    def ensure(self, kind: str, desc: str, *, sound: str | None = None, generated: bool = False) -> tuple[CueAsset, np.ndarray]:
        """A cue by description, made once into the library (from a recording when one matches) and counted per ask (the auto mix's path)."""
        asset = self.library.ensure(kind, desc, sound=sound, generated=generated)
        if asset.generated:
            self.generated += 1
        else:
            self.reused += 1
        self.log(f"cue {asset.kind} {'generated' if asset.generated else 'reused'}: {asset.desc}")
        if asset.key not in self._cues:
            self._cues[asset.key] = self.library.load(asset)
        return asset, self._cues[asset.key]

    def cue(self, key: str, hint: tuple[str, str] | None) -> np.ndarray | None:
        """A cue by key, at its kind's loudness target. A missing asset is made only from `hint` (the manifest cue the clip places) when the key is one of its own: generated, or built from one of its candidate recordings."""
        if key in self._cues:
            return self._cues[key]
        audio = self.library.load_key(key)
        if audio is not None:
            self._cues[key] = audio
            self.reused += 1
            return audio
        if hint is not None and hint[0] in CUE_TRACK:
            if cue_key(*hint) == key:
                return self.ensure(*hint, generated=True)[1]
            for match in self.library.matches(*hint):
                if cue_key(*hint, match.sound.id) == key:
                    return self.ensure(*hint, sound=match.sound.id)[1]
        return None


def _lines(manifest: Mapping[str, object]) -> list[Mapping[str, object]]:
    raw = manifest.get("lines")
    return sorted((l for l in raw if isinstance(l, Mapping)), key=lambda l: int(l["i"])) if isinstance(raw, list) else []  # type: ignore[call-overload]


def _cues(manifest: Mapping[str, object]) -> list[Mapping[str, object]]:
    raw = manifest.get("cues")
    return [c for c in raw if isinstance(c, Mapping)] if isinstance(raw, list) else []


def _samples(seconds: object) -> int:
    return int(round(float(seconds) * SR))  # type: ignore[arg-type]


# --- clips on the timeline ------------------------------------------------------------------------


def _clip(
    clip_id: str,
    source: dict[str, object],
    length: int,
    anchor: dict[str, object],
    gain: float,
    *,
    fade_in: int = 0,
    fade_out: int = 0,
    offset: int = 0,
    **extra: object,
) -> dict[str, object]:
    return {
        "id": clip_id,
        "source": source,
        **extra,
        "in": offset / SR,
        "out": (offset + length) / SR,
        "anchor": anchor,
        "gain": round(gain_to_db(gain), 6),
        "fade_in": {"len": fade_in / SR, "curve": "linear"},
        "fade_out": {"len": fade_out / SR, "curve": "linear"},
    }


@dataclass
class _Placed:
    track: str
    lane: str
    field: str
    clip: Mapping[str, object]
    audio: np.ndarray  # the slice of the source that plays, before gain and fades
    start: int = -1  # samples on the timeline, once resolved

    @property
    def end(self) -> int:
        return self.start + len(self.audio)


def _shape(p: _Placed) -> np.ndarray:
    """The clip's audio with its gain and fades."""
    clip = p.clip
    audio = p.audio.astype(np.float32) * np.float32(db_to_gain(float(clip.get("gain", 0.0))))  # type: ignore[arg-type]
    for name, direction in (("fade_in", "in"), ("fade_out", "out")):
        fade = clip.get(name)
        if isinstance(fade, Mapping) and float(fade["len"]) > 0:  # type: ignore[arg-type]
            audio = apply_fade(audio, str(fade.get("curve", "linear")), _samples(fade["len"]), direction)
    return np.asarray(audio, dtype=np.float32)


def _crossfade_gains(n: int) -> np.ndarray:
    """`(n, 2)`: the outgoing and incoming equal-power gains over an `n`-sample overlap."""
    return np.array([equal_power_crossfade(j / n) for j in range(n)], dtype=np.float32).reshape(n, 2)


def _clip_audio(members: Sequence[_Placed], k: int) -> np.ndarray:
    """Clip `k` of a lane (sorted by start) as it sounds: gain, fades, and an equal-power crossfade over any overlap with its neighbours."""
    p = members[k]
    audio = _shape(p)
    if k > 0:
        a = members[k - 1]
        n = min(a.end, p.end) - p.start
        if n > 0:
            audio[:n] *= _crossfade_gains(n)[:, 1]
    if k + 1 < len(members):
        b = members[k + 1]
        n = min(p.end, b.end) - b.start
        if n > 0:
            offset = b.start - p.start
            audio[offset : offset + n] *= _crossfade_gains(n)[:, 0]
    return audio


AUTOMATION_STEP = 64
"""Automation is evaluated on a grid of 64 samples (1.45 ms at 44.1 kHz) and interpolated linearly between: per sample is too slow for an episode."""


def _mix_range(
    placed: Sequence[_Placed],
    tracks: Mapping[str, Mapping[str, object]],
    when: Callable[[Mapping[str, object]], int | None],
    start: int,
    end: int,
) -> np.ndarray:
    """The summed tracks over `[start, end)`, before the master: the one mixdown both a document's render and the streamed `Timeline` use."""
    out = np.zeros(max(0, end - start), np.float32)
    if end <= start:
        return out
    lanes: dict[tuple[str, str], list[_Placed]] = {}
    for p in placed:
        lanes.setdefault((p.track, p.lane), []).append(p)
    soloed = any(bool(tracks.get(name, {}).get("solo")) for name in TRACKS)
    for name in TRACKS:
        track = tracks.get(name, {})
        if track.get("mute") or (soloed and not track.get("solo")):
            continue
        bus = np.zeros(len(out), np.float32)
        for (owner, _), members in lanes.items():
            if owner != name:
                continue
            members.sort(key=lambda p: p.start)
            for k, p in enumerate(members):
                lo, hi = max(start, p.start), min(end, p.end)
                if lo < hi:
                    bus[lo - start : hi - start] += _clip_audio(members, k)[lo - p.start : hi - p.start]
        automation = track.get("automation") or []
        if automation:
            points = [{"t": (when(point["anchor"]) or 0) / SR, "db": float(point["db"]), "curve": point.get("curve", "linear")} for point in automation]  # type: ignore[union-attr,index]
            grid = np.arange(start // AUTOMATION_STEP * AUTOMATION_STEP, end + AUTOMATION_STEP, AUTOMATION_STEP)
            values = np.array([automation_gain_at(points, g / SR) for g in grid], dtype=np.float64)
            bus *= np.interp(np.arange(start, end), grid, values).astype(np.float32)
        out += bus * np.float32(db_to_gain(float(track.get("volume", 0.0))))  # type: ignore[arg-type]
    return out


AUTO_MASTER: dict[str, object] = {"gain": 0.0, "peak_db": FINAL_PEAK_DB, "target_lufs": None}


def master(buffer: np.ndarray, settings: Mapping[str, object] = AUTO_MASTER) -> tuple[np.ndarray, float, float]:
    """The master: its gain, then the one gain that puts the peak at `peak_db` dBFS. Returns `(audio, peak_before, gain)`."""
    peak = float(np.abs(buffer).max()) if len(buffer) else 0.0
    gain = db_to_gain(float(settings.get("gain", 0.0)))  # type: ignore[arg-type]
    peak_db = settings.get("peak_db", FINAL_PEAK_DB)
    if peak_db is not None and peak * gain > 0:
        gain = db_to_gain(float(peak_db)) / peak  # type: ignore[arg-type]
    return (buffer * np.float32(gain)).astype(np.float32), peak, gain


def _line_spans(p: _Placed, by_id: Mapping[int, Mapping[str, object]], sources: Sources) -> list[tuple[int, tuple[float, float, float, float, float]]]:
    """For each line a take clip voices: (line id, (clip start, in, length, first word, last word)), seconds of the paced take."""
    source = p.clip["source"]
    assert isinstance(source, Mapping)
    paced = sources.paced(str(source["key"]), float(source.get("stretch", 1.0)))
    assert paced is not None
    take = paced.take
    group = [by_id[int(i)] for i in sorted(p.clip["lines"])]  # type: ignore[union-attr]
    span = (0.0, len(take.audio) / take.rate)
    # The stored word times come from the aligner on the untrimmed attempt, so the last word can end after
    # the take (trimmed at the last word plus the tail air) does: nothing is audible past the take's end.
    bounds = [(min(begin, span[1]), min(end, span[1])) for begin, end in _split_words(take.words, group, span)]
    warped = warp_times(take.audio, paced.paced, take.rate, [t for pair in bounds for t in pair])
    clip_in = _samples(p.clip["in"]) / SR
    return [(int(line["i"]), (p.start / SR, clip_in, len(p.audio) / SR, warped[2 * k], warped[2 * k + 1])) for k, line in enumerate(group)]  # type: ignore[call-overload]


def _timed(line: Mapping[str, object], options: Sequence[tuple[float, float, float, float, float]]) -> dict[str, object]:
    """The line with `start`/`end`: its first and last word through the clip(s) that hold them."""

    def place(word: float, last: bool) -> float:
        inside = [s for s in options if s[1] <= word <= s[1] + s[2]]
        start, lo, length = (inside[-1] if last else inside[0])[:3] if inside else (options[-1] if last else options[0])[:3]
        return start + min(max(word - lo, 0.0), length)

    return {**line, "start": round(place(options[0][3], False), 3), "end": round(place(options[-1][4], True), 3)}


def _line_timings(lines: Sequence[Mapping[str, object]], placed: Sequence[_Placed], sources: Sources) -> list[dict[str, object]]:
    by_id = {int(line["i"]): line for line in lines}  # type: ignore[call-overload]
    spans: dict[int, list[tuple[float, float, float, float, float]]] = {}
    for p in sorted((p for p in placed if p.track == "dialogue"), key=lambda p: p.start):
        for i, entry in _line_spans(p, by_id, sources):
            spans.setdefault(i, []).append(entry)
    return [_timed(line, spans[int(line["i"])]) for line in lines]  # type: ignore[call-overload]


def _cue_places(cues: Sequence[Mapping[str, object]], placed: Sequence[_Placed]) -> list[dict[str, object]]:
    """Where each cue landed: the span of the clips that place it; a `[BED: off]` sits where the bed it stops ends."""
    out: list[dict[str, object]] = []
    for k, cue in enumerate(cues):
        base: dict[str, object] = {"kind": cue.get("kind"), "desc": cue.get("desc"), "after": cue.get("after"), "line": cue.get("line")}
        mine = [p for p in placed if p.clip.get("cue") == k]
        if mine:
            key = str(mine[0].clip["source"]["key"])  # type: ignore[index]
            start, end = min(p.start for p in mine) / SR, max(p.end for p in mine) / SR
            out.append({**base, "asset": f"cues/{key}.wav", "key": key, "start": round(start, 3), "end": round(end, 3)})
            continue
        stops_at: float | None = None
        if cue.get("kind") == "BED" and is_stop(str(cue.get("desc", ""))):
            for j in range(k - 1, -1, -1):
                bed = [p for p in placed if p.clip.get("cue") == j and p.track == "beds"]
                if bed:
                    stops_at = round(max(p.end for p in bed) / SR, 3)
                    break
        out.append({**base, "asset": None, "start": stops_at, "end": stops_at})
    return out


# --- non-repeating beds -----------------------------------------------------------------------------


class BedPlan:
    """The segments one bed is built from: `(start, in, length)` in samples, start counted from the bed's start.

    A bed asset is a short clip (Stable Audio's 20 s); tiled back to back it
    repeats on its own length, and the ear catches whatever stands out in it (a
    glassware clink) every time. So a bed is a chain of segments of the asset
    at varied offsets, each overlapping the next by `xfade` samples (the lane's
    equal-power crossfade), their lengths drawn between 40% and 80% of the
    asset so no period recurs. The draw is seeded by the cue key: the same bed
    always has the same plan, and a plan's prefix does not depend on how far it
    is asked to run (a still-open bed and its finished form agree).
    """

    def __init__(self, key: str, size: int) -> None:
        self.size = size
        self.xfade = min(int(SR * BED_XFADE_SECONDS), size // 3)
        self.longest = min(size, max(3 * self.xfade, int(0.8 * size)))
        self.shortest = min(self.longest, max(3 * self.xfade, int(0.4 * size)))
        self.rng = random.Random(int.from_bytes(hashlib.sha256(f"bed-segments:{key}".encode()).digest()[:8], "big"))
        self.segments: list[tuple[int, int, int]] = []

    def upto(self, span: int) -> list[tuple[int, int, int]]:
        """Every segment that starts before `span` samples."""
        while self.size and (not self.segments or self.segments[-1][0] + self.segments[-1][2] - self.xfade < span):
            length = self.rng.randint(self.shortest, self.longest)
            room = self.size - length
            previous = self.segments[-1][1] if self.segments else None
            offset = 0
            for _ in range(8):
                offset = self.rng.randint(0, room)
                if previous is None or abs(offset - previous) >= self.size // 4:
                    break
            start = self.segments[-1][0] + self.segments[-1][2] - self.xfade if self.segments else 0
            self.segments.append((start, offset, length))
        return [s for s in self.segments if s[0] < span]


class LoopPlan:
    """A rhythmic bed's segments (AGT-1799): its loop back to back, so it repeats at its natural period.

    A clock chopped into `BedPlan`'s random segments ticks unevenly at every
    join. A rhythmic asset's sidecar holds a loop (`sounds.Loop`: `start`,
    `length` a whole number of tick cycles, `xfade` samples of quiet before
    `start`), and the bed is that loop again and again: segment 0 is
    `(0, start, length)` and segment `k` is `(k*length - xfade, start - xfade,
    length + xfade)`, so its own sample `start` lands exactly at `k*length` and
    the lane's equal-power crossfade runs over the quiet before a tick. Every
    tick is then `length` after the same tick one loop earlier.
    """

    def __init__(self, start: int, length: int, xfade: int) -> None:
        if length <= 0 or xfade < 0 or start < xfade:
            raise ValueError(f"not a loop: start {start}, length {length}, xfade {xfade}")
        self.start, self.length, self.xfade = start, length, min(xfade, int(SR * BED_XFADE_SECONDS))

    def upto(self, span: int) -> list[tuple[int, int, int]]:
        """Every segment that starts before `span` samples."""
        out = [(0, self.start, self.length)]
        k = 1
        while k * self.length - self.xfade < span:
            out.append((k * self.length - self.xfade, self.start - self.xfade, self.length + self.xfade))
            k += 1
        return [s for s in out if s[0] < span]


@dataclass
class _Bed:
    cue: int
    key: str
    start: int
    loop: np.ndarray
    base: tuple[int, int] | None  # the anchor reference when it opened
    plan: BedPlan | LoopPlan


@dataclass
class _Duck:
    """A MUSIC cue sounding while a bed is open: the beds track is out from `down` (a fade) through `end`, the music's last sample."""

    bed: int
    down: int
    start: int
    end: int
    base: tuple[int, int] | None


# --- the auto mix: the Timeline -----------------------------------------------------------------------


class Timeline:
    """The automatic mix, built one line group at a time (AGT-1697), as the mix document it writes (AGT-1764).

    It is the AGT-1684 rules expressed as clips: each take group follows the
    one before it by its length plus 0.35 s of air; an SFX starts 0.4 s early at
    0.75 gain and MUSIC at once at 0.9, both holding the next line for their
    length plus 0.2 s; a BED is a chain of crossfading segments of its asset
    (`BedPlan`) from its cue to the next BED cue (or the end of the speech) at
    0.16 gain with 1.5 s linear fades (a quarter of its span at most); MUSIC over
    a bed ducks it (`_automation`) and the closing theme ends every bed. Each clip is anchored to the end of the line
    group before it (a free `{at}` before the first line), so a re-timed line
    carries what follows it along; a bed's segments all hang off its cue's anchor.
    A cue that would overlap the last clip on its lane goes on the next lane
    (`main`, `2`, ...), so the only crossfades are a bed's own segments: all else sums as it always did.

    `add` places each clip twice over, as document data (`document()`, written
    as `mix.v<m>` with `by: "auto"`) and at its sample position; `mixdown` sums
    them with the same `_mix_range` a document's render uses, so `perform
    --stream`'s segments (`stream.py`), the episode file and a later render of
    the written document are the same samples.

    A sample is final once nothing still to come can write to it
    (`frontier`): a voice take or MUSIC starts at `t`, an SFX up to
    `SFX_OVERLAP_SECONDS` before it, and an open BED's last segment fades out where
    it closes (no earlier than `t`) over at most `BED_FADE_SECONDS`; while a BED
    is shorter than four fades its fade-in is not settled either. An open bed holds
    the frontier 1.5 s behind `t`, which also covers what can still change at a bed's
    end (a last segment cut or dropped: `BED_XFADE_SECONDS` is no more than that), the
    fade out of a MUSIC cue (0.5 s, placed at `t`) and the way back after one.
    """

    def __init__(
        self,
        work: Path,
        cues: Sequence[Mapping[str, object]],
        library: CueLibrary,
        pacer: Pacer,
        *,
        log: Callable[[str], None] = lambda message: None,
        sources: Sources | None = None,
        manifest_version: object = None,
    ) -> None:
        self.sources = sources if sources is not None else Sources(work, library, pacer, log)
        self.cues = [c for c in cues if isinstance(c, Mapping)]
        self.manifest_version = manifest_version
        self.pending = sorted(range(len(self.cues)), key=lambda k: (int(self.cues[k].get("after", -1)), k))  # type: ignore[call-overload]
        self.lanes: dict[str, dict[str, dict[str, list[dict[str, object]]]]] = {name: {} for name in TRACKS}
        self.placed: list[_Placed] = []
        self.lines: list[dict[str, object]] = []
        self.t = 0
        self.total: int | None = None
        self._ref: tuple[int, int] | None = None  # (last line id of the previous group, its clip's end)
        self._line_end: dict[int, int] = {}
        self._bed: _Bed | None = None
        self._ducks: list[_Duck] = []
        self._bed_closed: dict[int, int] = {}
        self._ended = False  # the closing theme has begun: every bed is over
        self.closing = self._closing_theme()

    @property
    def generated(self) -> int:
        return self.sources.generated

    @property
    def reused(self) -> int:
        return self.sources.reused

    def _closing_theme(self) -> int | None:
        """The cue that ends every bed: the last MUSIC cue, when it follows a spoken line and no bed is cued after it."""
        music = [k for k in self.pending if self.cues[k].get("kind") == "MUSIC"]
        if not music:
            return None
        last = int(self.cues[music[-1]].get("after", -1))  # type: ignore[call-overload]
        if last < 0:
            return None
        later = any(
            self.cues[k].get("kind") == "BED" and not is_stop(str(self.cues[k].get("desc", ""))) and int(self.cues[k].get("after", -1)) > last  # type: ignore[call-overload]
            for k in self.pending
        )
        return None if later else music[-1]

    def _anchor(self, at: int, base: tuple[int, int] | None) -> dict[str, object]:
        if base is None:
            return {"at": at / SR}
        return {"line": base[0], "edge": "end", "offset": round((at - base[1]) / SR, 6)}

    def _put(self, track: str, lane: str, clip: dict[str, object], start: int, audio: np.ndarray) -> None:
        clips = self.lanes[track].setdefault(lane, {"clips": []})["clips"]
        clips.append(clip)
        self.placed.append(_Placed(track=track, lane=lane, field=clip_field(track, lane, len(clips) - 1), clip=clip, audio=audio, start=start))

    def _free_lane(self, track: str, start: int) -> str:
        for n in range(1, len(self.lanes[track]) + 2):
            name = "main" if n == 1 else str(n)
            if not any(p.track == track and p.lane == name and p.end > start for p in self.placed):
                return name
        raise AssertionError("unreachable")

    def _tiles(self, at: int, *, closing: bool) -> list[tuple[dict[str, object], int, np.ndarray]]:
        """The open bed's segments up to `at`: cut at `at` with a fade-out when it closes there, else the settled part only.

        A closing bed drops a last segment that would start less than one crossfade before `at` (the one before it
        simply runs to `at`), so a segment that is kept always has its whole crossfade in; that, and `BED_XFADE_SECONDS`
        being no more than the fade the frontier waits for, keeps every sample behind the frontier as it will be.
        """
        assert self._bed is not None
        bed = self._bed
        span = at - bed.start
        if span <= 0 or not len(bed.loop):
            return []
        fade = min(int(SR * BED_FADE_SECONDS), span // 4) if closing else int(SR * BED_FADE_SECONDS)
        segments = bed.plan.upto(span)
        if closing:
            segments = [s for n, s in enumerate(segments) if n == 0 or span - s[0] >= bed.plan.xfade]
        out = []
        for n, (offset, source_in, length) in enumerate(segments):
            if closing:
                length = min(length, span - offset)
            last = n == len(segments) - 1
            clip = _clip(
                f"bed-{bed.cue}-{n}",
                {"kind": "cue", "key": bed.key},
                length,
                self._anchor(bed.start + offset, bed.base),
                BED_GAIN,
                fade_in=min(fade, length) if n == 0 else 0,
                fade_out=min(fade, length) if closing and last else 0,
                offset=source_in,
                cue=bed.cue,
            )
            out.append((clip, bed.start + offset, bed.loop[source_in : source_in + length]))
        return out

    def _close_bed(self, at: int) -> None:
        if self._bed is not None:
            for clip, start, audio in self._tiles(at, closing=True):
                self._put("beds", "main", clip, start, audio)
            self._bed_closed[self._bed.cue] = at
            self._bed = None

    def _automation(self) -> list[dict[str, object]]:
        """The beds track's volume automation: out around each MUSIC cue that sounded over a bed, back in after.

        The way back is `BED_DUCK_SECONDS` long, or shorter when the bed closes sooner (a new bed starting there
        begins at full volume). A cue that follows another within the fades stays down between them.
        """
        points: list[tuple[int, float, tuple[int, int] | None]] = []
        ramp_end = -1
        for duck in self._ducks:
            back = duck.end + int(SR * BED_DUCK_SECONDS)
            closed = self._bed_closed.get(duck.bed)
            if closed is not None:
                back = max(duck.end + 1, min(back, closed))
            if points and duck.down < ramp_end:
                points.pop()  # the previous cue's way back is not taken
            else:
                points.append((duck.down, 0.0, duck.base))
            points += [(duck.start, BED_DUCK_DB, duck.base), (duck.end, BED_DUCK_DB, duck.base), (back, 0.0, duck.base)]
            ramp_end = back
        return [{"anchor": self._anchor(at, base), "db": db, "curve": "linear"} for at, db, base in points]

    def _when(self, anchor: Mapping[str, object]) -> int | None:
        if "at" in anchor:
            return _samples(anchor["at"])
        return self._line_end[int(anchor["line"])] + _samples(anchor.get("offset", 0.0))  # type: ignore[call-overload]

    def _place(self, k: int) -> None:
        cue = self.cues[k]
        kind = str(cue["kind"])
        if kind == "BED":
            self._close_bed(self.t)
            if is_stop(str(cue["desc"])) or self._ended:
                return
            asset, audio = self.sources.ensure(kind, str(cue["desc"]))
            plan = LoopPlan(*asset.loop) if asset.loop is not None and asset.loop[0] + asset.loop[1] <= len(audio) else BedPlan(asset.key, len(audio))
            self._bed = _Bed(k, asset.key, self.t, audio, self._ref, plan)
            return
        if k == self.closing:
            self._close_bed(self.t)
            self._ended = True
        asset, audio = self.sources.ensure(kind, str(cue["desc"]))
        start = max(0, self.t - (int(SR * SFX_OVERLAP_SECONDS) if kind == "SFX" else 0))
        track = CUE_TRACK.get(kind, "sfx")
        clip = _clip(f"cue-{k}", {"kind": "cue", "key": asset.key}, len(audio), self._anchor(start, self._ref), CUE_GAIN.get(kind, 0.75), cue=k)
        self._put(track, self._free_lane(track, start), clip, start, audio)
        if kind == "MUSIC" and self._bed is not None:
            self._ducks.append(_Duck(self._bed.cue, max(0, start - int(SR * BED_DUCK_SECONDS)), start, start + len(audio), self._ref))
        self.t = start + len(audio) + int(SR * CUE_TAIL_SECONDS)

    def add(self, group: Sequence[Mapping[str, object]]) -> None:
        """Places the cues due before `group` (consecutive lines sharing one take, in line order), then its take."""
        if self.total is not None:
            raise ValueError("the timeline is finished")
        first = int(group[0]["i"])  # type: ignore[call-overload]
        while self.pending and int(self.cues[self.pending[0]].get("after", -1)) < first:  # type: ignore[call-overload]
            self._place(self.pending.pop(0))
        key = str(group[0]["take"])
        stretch = float(group[0].get("stretch") or 1.0)  # type: ignore[arg-type]
        paced = self.sources.paced(key, stretch)
        if paced is None:
            raise MixRefusal(f"take(s) not in the store: {key}", missing_takes=[key])
        ids = [int(line["i"]) for line in group]  # type: ignore[call-overload]
        source: dict[str, object] = {"kind": "take", "key": key, "stretch": stretch}
        clip = _clip(f"line-{ids[0]}", source, len(paced.audio), self._anchor(self.t, self._ref), 1.0, lines=ids)
        self._put("dialogue", str(group[0].get("speaker") or "VOICE"), clip, self.t, paced.audio)
        by_id = {int(line["i"]): line for line in group}  # type: ignore[call-overload]
        self.lines.extend(_timed(by_id[i], [entry]) for i, entry in _line_spans(self.placed[-1], by_id, self.sources))
        self._ref = (ids[-1], self.t + len(paced.audio))
        for i in ids:
            self._line_end[i] = self._ref[1]
        self.t = self.t + len(paced.audio) + int(SR * GAP_SECONDS)

    def finish(self) -> int:
        """Places the cues after the last line and closes the bed; returns the episode's length in samples."""
        if self.total is None:
            while self.pending:
                self._place(self.pending.pop(0))
            self._close_bed(self.t)
            self.total = max((p.end for p in self.placed), default=0) + int(SR * END_PAD_SECONDS)
        return self.total

    def frontier(self) -> int:
        """The first sample that can still change (the episode's length once finished)."""
        if self.total is not None:
            return self.total
        final = self.t - int(SR * SFX_OVERLAP_SECONDS)
        if self._bed is not None:
            if self.t - self._bed.start < 4 * int(SR * BED_FADE_SECONDS):
                final = min(final, self._bed.start)
            else:
                final = min(final, self.t - int(SR * BED_FADE_SECONDS))
        return max(0, final)

    def mixdown(self, start: int, end: int) -> np.ndarray:
        """The summed, unnormalised samples `[start, end)`; an open bed's settled part is its segments so far, faded in, under the beds automation so far."""
        total = self.total if self.total is not None else end
        end = min(end, total)
        placed = list(self.placed)
        if self._bed is not None and end > self._bed.start:
            for clip, at, audio in self._tiles(end, closing=False):
                placed.append(_Placed(track="beds", lane="main", field="(open bed)", clip=clip, audio=audio, start=at))
        return _mix_range(placed, {"beds": {"automation": self._automation()}}, self._when, start, end)

    def document(self) -> dict[str, object]:
        """The auto mix as a document proposal (`write_mix`, `by: "auto"`)."""
        return {
            "manifest_version": self.manifest_version,
            "tracks": {
                name: {"lanes": self.lanes[name], "volume": 0.0, "mute": False, "solo": False, "automation": self._automation() if name == "beds" else []}
                for name in TRACKS
            },
            "master": dict(AUTO_MASTER),
        }

    def rendered(self) -> Rendered:
        """The finished timeline as the mix's result: every line timed, the cues placed, through the master."""
        total = self.finish()
        audio, peak, _ = master(self.mixdown(0, total))
        timed = sorted(self.lines, key=lambda line: int(line["i"]))  # type: ignore[call-overload]
        return Rendered(audio=audio, lines=timed, cues=_cue_places(self.cues, self.placed), cues_generated=self.generated, cues_reused=self.reused, peak_before=peak)


def auto_timeline(manifest: Mapping[str, object], sources: Sources) -> Timeline:
    """Every line group of `manifest` added to a fresh `Timeline`, finished."""
    lines = _lines(manifest)
    missing = sorted({str(l["take"]) for l in lines if sources.take(str(l["take"])) is None})
    if missing:
        raise MixRefusal(f"take(s) not in the store: {', '.join(missing)}", missing_takes=missing)
    timeline = Timeline(sources.work, _cues(manifest), sources.library, sources.pacer, sources=sources, manifest_version=manifest.get("version"))
    for group in _group_lines(lines):
        timeline.add(group)
    timeline.finish()
    return timeline


def auto_document(manifest: Mapping[str, object], sources: Sources) -> dict[str, object]:
    """The automatic mix as a document proposal (what `pablo mix` writes as `mix.v<m>` with `by: "auto"`)."""
    return auto_timeline(manifest, sources).document()


# --- rendering a mix document ------------------------------------------------------------------------


def _load(doc: Mapping[str, object], manifest: Mapping[str, object], sources: Sources) -> list[_Placed]:
    cues = _cues(manifest)
    placed: list[_Placed] = []
    problems: list[Problem] = []
    missing: list[str] = []
    for track, lane, k, clip in clips(doc):
        at = clip_field(track, lane, k)
        source = clip["source"]
        assert isinstance(source, Mapping)
        key = str(source["key"])
        audio: np.ndarray | None
        if source["kind"] == "take":
            paced = sources.paced(key, float(source.get("stretch", 1.0)))
            if paced is None:
                missing.append(key)
                continue
            audio = paced.audio
        else:
            hint = None
            if "cue" in clip and int(clip["cue"]) < len(cues):  # type: ignore[call-overload]
                cue = cues[int(clip["cue"])]  # type: ignore[call-overload]
                hint = (str(cue.get("kind")), str(cue.get("desc")))
            audio = sources.cue(key, hint)
            if audio is None:
                problems.append(Problem(f"{at}.source.key", f"cue {key[:12]}... is not in the cue library ({sources.library.root})"))
                continue
        lo, hi = _samples(clip["in"]), _samples(clip["out"])
        if hi > len(audio) + 1:  # one sample of rounding is not past the end
            problems.append(Problem(f"{at}.out", f"{clip['out']} s is past the end of the source ({len(audio) / SR:.3f} s)"))
            continue
        placed.append(_Placed(track=track, lane=lane, field=at, clip=clip, audio=audio[lo:hi]))
    if missing:
        raise MixRefusal(f"take(s) not in the store: {', '.join(sorted(set(missing)))}", missing_takes=sorted(set(missing)))
    if problems:
        raise MixDocError(problems)
    return placed


def _resolve(placed: Sequence[_Placed]) -> Callable[[Mapping[str, object]], int | None]:
    """Gives every clip its start (samples) from its anchor; returns the anchor resolver (for automation)."""
    voicing: dict[int, list[_Placed]] = {}
    for p in placed:
        if p.track == "dialogue":
            for i in p.clip["lines"]:  # type: ignore[union-attr]
                voicing.setdefault(int(i), []).append(p)

    def when(anchor: Mapping[str, object]) -> int | None:
        if "at" in anchor:
            return _samples(anchor["at"])
        group = voicing.get(int(anchor["line"]), [])  # type: ignore[call-overload]
        if not group or any(p.start < 0 for p in group):
            return None
        edge = min(p.start for p in group) if anchor["edge"] == "start" else max(p.end for p in group)
        return edge + _samples(anchor.get("offset", 0.0))

    unresolved = list(placed)
    while unresolved:
        waiting: list[_Placed] = []
        for p in unresolved:
            start = when(p.clip["anchor"])  # type: ignore[arg-type]
            if start is None:
                waiting.append(p)
            elif start < 0:
                raise MixDocError([Problem(f"{p.field}.anchor", f"puts the clip {-start / SR:.3f} s before the start of the episode")])
            else:
                p.start = start
        if len(waiting) == len(unresolved):
            raise MixDocError([Problem(f"{waiting[0].field}.anchor", "the anchors form a cycle: this clip is anchored, through others, to itself")])
        unresolved = waiting
    return when


def render_document(manifest: Mapping[str, object], doc: Mapping[str, object], sources: Sources) -> Rendered:
    """Renders `doc` with `manifest`'s lines and cues; raises `MixDocError` naming any field it cannot use."""
    problems = validate(doc)
    if not problems:
        problems = check_against(doc, manifest)
    if problems:
        raise MixDocError(problems)
    placed = _load(doc, manifest, sources)
    when = _resolve(placed)
    total = max((p.end for p in placed), default=0) + int(SR * END_PAD_SECONDS)
    tracks = doc["tracks"]
    settings = doc["master"]
    assert isinstance(tracks, Mapping) and isinstance(settings, Mapping)
    audio, peak, _ = master(_mix_range(placed, tracks, when, 0, total), settings)
    return Rendered(
        audio=audio,
        lines=_line_timings(_lines(manifest), placed, sources),
        cues=_cue_places(_cues(manifest), placed),
        cues_generated=0,
        cues_reused=0,
        peak_before=peak,
    )


# --- the command --------------------------------------------------------------------------------


@dataclass(frozen=True)
class MixRequest:
    work: Path
    episode: int
    cues_dir: Path
    version: int | None = None
    document: Mapping[str, object] | None = None
    """A hand-made mix document (`--from`): rendered, then written as the next mix version, `by: "human"`."""
    auto: bool = False
    """`--auto`: a fresh auto mix even when the newest document fits (after the sound library or the rules changed)."""


@dataclass
class Seams:
    generators: GeneratorFactory
    pacer: Pacer = sox_pacer
    encoder: Encoder = aac_encoder
    log: Callable[[str], None] = field(default=lambda message: None)
    sounds: SoundLibrary | None = None
    """The CC0 sound library cues are built from before any generator runs (AGT-1799); None: every cue is generated."""
    loudness: Mapping[str, float] | None = None
    """Per-kind cue loudness targets (LUFS); None: `loudness.DEFAULT_TARGETS`."""

    def cue_library(self, root: Path) -> CueLibrary:
        return CueLibrary(root, self.generators, self.sounds, self.loudness)


def _refused(message: str, **extra: object) -> Result:
    return {"ok": False, "code": EXIT_REFUSED, "message": message, **extra}, EXIT_REFUSED


def _error(message: str) -> Result:
    return {"ok": False, "code": EXIT_ERROR, "message": message}, EXIT_ERROR


def mix(request: MixRequest, seams: Seams, *, timeline: Timeline | None = None, extra: Mapping[str, object] | None = None) -> Result:
    """Mixes a version into its episode file.

    `timeline` is a streamed episode's (AGT-1697): already built from this
    version's takes as they passed, so it is finished and put through the
    master rather than built again, and its document is written as the next
    mix version (`by: "auto"`); `extra` joins the manifest's `mix` block (the
    stream's segments and time to first audio).
    """
    work, episode = request.work, request.episode
    found = versions(work, episode)
    if not found:
        return _refused(f"episode {episode} has no manifest to mix: run `pablo perform --episode {episode}` first", episode=episode)
    version = request.version if request.version is not None else found[-1]
    if version not in found:
        return _refused(f"episode {episode} has no v{version} (versions: {', '.join(f'v{v}' for v in found)})", episode=episode, versions=found)
    manifest = read_version(work, episode, version)
    mixed = audio_versions(work, episode)
    remix = bool(manifest.get("audio"))
    if remix and version != found[-1]:
        return _refused(
            f"episode {episode} v{version} is already mixed and v{found[-1]} is newer; mix the newest version, which makes a new one",
            episode=episode,
            version=version,
            latest=found[-1],
        )
    started = time.monotonic()
    sources = timeline.sources if timeline is not None else Sources(work, seams.cue_library(request.cues_dir), seams.pacer, seams.log)
    existing = mix_versions(work, episode)
    superseded: int | None = None
    new_doc: tuple[Mapping[str, object], str] | None = None  # (proposal, by) to write once the mix succeeds
    try:
        if timeline is not None:
            newest = read_mix(work, episode, existing[-1]) if existing else None
            if newest is not None and newest.get("by") == "human":
                superseded = existing[-1]
            timeline.finish()
            doc = {**timeline.document(), "manifest_version": version}
            new_doc = (doc, "auto")
            doc_name = f"mix.v{(existing[-1] if existing else 0) + 1}.json"
        elif request.document is not None:
            doc: Mapping[str, object] = {**request.document, "manifest_version": version}
            new_doc = (doc, "human")
            doc_name = f"mix.v{(existing[-1] if existing else 0) + 1}.json"
        else:
            newest = read_mix(work, episode, existing[-1]) if existing else None
            if newest is not None:
                problems = validate(newest)
                if problems:
                    raise MixDocError(problems, where=f"mix.v{existing[-1]}.json")
            # An invalid newest document is refused above (a broken hand edit is never silently replaced); a valid
            # one that no longer fits the manifest (its takes, or a line it anchors to) gives way to the auto mix.
            if newest is not None and compatible(newest, manifest) and not request.auto:
                doc, doc_name = newest, f"mix.v{existing[-1]}.json"
            else:
                if newest is not None and newest.get("by") == "human":
                    superseded = existing[-1]
                doc = auto_document(manifest, sources)
                new_doc = (doc, "auto")
                doc_name = f"mix.v{(existing[-1] if existing else 0) + 1}.json"
        # The stream's segments came from the timeline's own mixdown, which is `_mix_range` over the very clips the
        # document holds: the episode file is that mixdown through the master, a document render of it the same.
        rendered = timeline.rendered() if timeline is not None else render_document(manifest, doc, sources)
        # The auto mix counts each cue it asks for; a document's render counts each asset it loads.
        rendered.cues_generated, rendered.cues_reused = sources.generated, sources.reused
        duration = round(len(rendered.audio) / SR, 3)
        with tempfile.TemporaryDirectory(prefix="pablo-mix-") as scratch:
            wav = Path(scratch) / f"ep{episode:02d}.wav"
            sf.write(str(wav), rendered.audio, SR, subtype="PCM_16")
            encoded = Path(scratch) / f"ep{episode:02d}.m4a"
            seams.encoder(wav, encoded)
            info: dict[str, object] = {
                "sample_rate": SR,
                "seconds": duration,
                "peak_before_normalise": round(rendered.peak_before, 4),
                "final_peak_db": FINAL_PEAK_DB,
                "codec": f"aac {AAC_BITRATE // 1000} kb/s",
                "cues_generated": rendered.cues_generated,
                "cues_reused": rendered.cues_reused,
                "document": doc_name,
                **(extra or {}),
                "wall": round(time.monotonic() - started, 3),
            }
            completed: dict[str, object] = {**manifest, "lines": rendered.lines, "cues": rendered.cues, "duration": duration, "mix": info}
            # The document first (exclusively: a racing writer fails here, before any manifest changes), then the manifest.
            try:
                written_doc = write_mix(work, episode, new_doc[0], by=new_doc[1]) if new_doc is not None else None
            except FileExistsError:
                return _error(f"another mix of episode {episode} wrote {doc_name} first; run the mix again")
            if written_doc is not None and written_doc.path.name != doc_name:
                written_doc.path.unlink()
                return _error(f"another mix of episode {episode} wrote {doc_name} first; run the mix again")
            try:
                if remix:
                    written = write_version(
                        work,
                        episode,
                        {name: completed[name] for name in ("script_sha256", "cast_hash", "engine", "pace_policy", "cues", "duration", "rtf_total", "render", "ttfa", "mix", "lines") if name in completed},
                        audio=encoded,
                    )
                    link_moved = True
                else:
                    link_moved = not any(v > version for v in mixed)
                    written = attach_mix(work, episode, version, completed, encoded, link=link_moved)
            except BaseException:
                if written_doc is not None:
                    written_doc.path.unlink()  # this run's own new version, never one that was there before
                raise
    except MixRefusal as refusal:
        return _refused(str(refusal), **refusal.extra)
    except MixDocError as invalid:
        return _refused(str(invalid), **invalid.extra)
    except (CueUnavailable, SoxUnavailable) as missing:
        return _refused(str(missing))
    except ManifestError as failure:
        return _error(f"writing episode {episode}'s mixed manifest failed: {failure}")
    except subprocess.CalledProcessError as failure:
        return _error(f"mixing episode {episode} failed: {failure.cmd[0]} exited {failure.returncode}")

    out_version = int(written.manifest["version"])  # type: ignore[call-overload]
    append_receipt(work, {"intent": "mix", "episode": episode, "version": out_version, "from_version": version, **info})
    audio_name = written.audio.name if written.audio else None
    set_aside = "was set aside by --auto" if request.auto else "does not fit this version's takes and was not used"
    return {
        "ok": True,
        "episode": episode,
        "version": out_version,
        "mixedFrom": version,
        "newVersion": remix,
        "manifest": str(written.path),
        "audio": str(written.audio) if written.audio else None,
        "link": str(written.link) if written.link else None,
        "linkMoved": link_moved,
        "duration": duration,
        "lines": len(rendered.lines),
        "cues": len(rendered.cues),
        "cuesGenerated": rendered.cues_generated,
        "cuesReused": rendered.cues_reused,
        "cueLibrary": str(request.cues_dir),
        "mixDocument": str(written_doc.path if written_doc is not None else episode_dir(work, episode) / doc_name),
        "mixBy": new_doc[1] if new_doc is not None else doc.get("by"),
        "mixWritten": written_doc is not None,
        "supersededMix": superseded,
        "cueSources": _cue_sources(rendered.cues, sources.library),

        "wall": info["wall"],
        "message": (
            f"episode {episode} v{out_version}: {duration:.1f} s, {len(rendered.lines)} lines, {len(rendered.cues)} cues "
            f"({rendered.cues_generated} generated, {rendered.cues_reused} reused) from {doc_name} -> {audio_name}"
            + (f"; mix.v{superseded}.json (by: human) {set_aside}" if superseded else "")
        ),
    }, EXIT_OK


# --- AC1: the aligner on the final file ---------------------------------------------------------


def decode(path: Path, scratch: Path) -> tuple[np.ndarray, int]:
    """The episode file as mono float samples (sndfile when it can, else afconvert/ffmpeg to WAV)."""
    try:
        return read_audio(path)
    except (RuntimeError, sf.LibsndfileError):
        pass
    target = scratch / "decoded.wav"
    afconvert, ffmpeg = shutil.which("afconvert"), shutil.which("ffmpeg")
    if afconvert is not None:
        subprocess.run([afconvert, "-f", "WAVE", "-d", "LEI16", str(path), str(target)], check=True)
    elif ffmpeg is not None:
        subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-i", str(path), str(target)], check=True)
    else:
        raise MixRefusal("cannot decode the episode file: afconvert and ffmpeg are both missing")
    return read_audio(target)


def check_timings(
    manifest: Mapping[str, object],
    audio_path: Path,
    align: Callable[[Path, str], Sequence[Mapping[str, object]]],
    *,
    tolerance: float = 0.15,
    pad: float = 1.0,
) -> dict[str, object]:
    """Re-measures every line's `start`/`end` with the aligner on the final file (AC1).

    For each line, the window `[start - pad, end + pad]` of the decoded episode
    is written out, `align(window_wav, text)` returns word timings (seconds from
    the window's start) for the line's script text, and the first word's start
    and last word's end are compared with the manifest's. `within` is the
    share of lines whose start and end are both within `tolerance` seconds.
    """
    raw = manifest.get("lines")
    lines = [l for l in raw if isinstance(l, Mapping)] if isinstance(raw, list) else []
    rows: list[dict[str, object]] = []
    with tempfile.TemporaryDirectory(prefix="pablo-check-") as scratch:
        samples, rate = decode(audio_path, Path(scratch))
        for line in lines:
            start, end = float(line["start"]), float(line["end"])  # type: ignore[arg-type]
            lo = max(0.0, start - pad)
            hi = min(len(samples) / rate, end + pad)
            window = Path(scratch) / f"line-{int(line['i'])}.wav"  # type: ignore[call-overload]
            sf.write(str(window), samples[int(lo * rate) : int(hi * rate)], rate, subtype="PCM_16")
            words = align(window, str(line.get("text", "")))
            if not words:
                rows.append({"i": line["i"], "ok": False, "reason": "aligner returned no words"})
                continue
            heard_start, heard_end = lo + float(words[0]["start"]), lo + float(words[-1]["end"])  # type: ignore[arg-type]
            d_start, d_end = heard_start - start, heard_end - end
            rows.append(
                {
                    "i": line["i"],
                    "start": start,
                    "end": end,
                    "aligned_start": round(heard_start, 3),
                    "aligned_end": round(heard_end, 3),
                    "d_start": round(d_start, 3),
                    "d_end": round(d_end, 3),
                    "ok": abs(d_start) <= tolerance and abs(d_end) <= tolerance,
                }
            )
    ok = sum(1 for row in rows if row["ok"])
    return {"lines": len(rows), "within": ok, "share": round(ok / len(rows), 4) if rows else 0.0, "tolerance": tolerance, "rows": rows}


def cues_dir_for(work: Path, explicit: str | None, library: str | None, vault: str | None) -> Path:
    """`--cues`, else `<library root>/cues` (shared by every work using the library), else the work's own `casting/cues`."""
    if explicit:
        return Path(explicit).expanduser()
    try:
        return resolve_root(library, vault) / "cues"
    except LibraryRefusal:
        return casting_dir(work) / "cues"


def _cue_sources(placed: Sequence[Mapping[str, object]], library: CueLibrary) -> list[dict[str, object]]:
    """Where each placed cue's audio came from: a recording (its id, source URL, licence, author) or a generator."""
    out: list[dict[str, object]] = []
    for cue in placed:
        key = cue.get("key")
        if not isinstance(key, str):
            continue
        sidecar = library.sidecar(key)
        sound = sidecar.get("sound")
        entry: dict[str, object] = {"kind": cue.get("kind"), "desc": cue.get("desc"), "key": key, "generator": sidecar.get("generator", "unknown")}
        if isinstance(sound, Mapping):
            entry["sound"] = {name: sound.get(name) for name in ("id", "title", "source_url", "licence", "author")}
            if isinstance(sidecar.get("loop"), Mapping):
                entry["loop"] = sidecar["loop"]
        out.append(entry)
    return out


def cmd_mix(
    work: Path | None,
    episode: str | None,
    version: int | None,
    cues: str | None,
    library: str | None,
    vault: str | None,
    seams: Seams,
    document: str | None = None,
    auto: bool = False,
) -> Result:
    if work is None:
        return _refused("mix needs --work <dir> (the work whose episode to mix)")
    if episode is None:
        return _refused("mix needs --episode N", missing=["--episode"])
    try:
        number = int(episode)
    except ValueError:
        return _error(f"--episode must be an integer, got {episode!r}")
    if number < 1:
        return _error(f"--episode must be a positive integer, got {number}")
    if version is not None and version < 1:
        return _error(f"--version must be a positive integer, got {version}")
    doc: Mapping[str, object] | None = None
    if document is not None:
        try:
            loaded = json.loads(Path(document).read_text(encoding="utf-8"))
        except OSError as unreadable:
            return _error(f"--from {document}: {unreadable}")
        except json.JSONDecodeError as broken:
            return _refused(f"--from {document} is not JSON: {broken}", field="(document)")
        problems = validate(loaded)
        if problems:
            invalid = MixDocError(problems, where=f"--from {document}")
            return _refused(str(invalid), **invalid.extra)
        doc = loaded
    root = cues_dir_for(work, cues, library, vault)
    if auto and doc is not None:
        return _refused("--auto writes a fresh auto mix; --from renders a given document: pass one or the other")
    return mix(MixRequest(work=work, episode=number, cues_dir=root, version=version, document=doc, auto=auto), seams)


__all__ = ["MixRequest", "Seams", "Sources", "Timeline", "auto_document", "auto_timeline", "check_timings", "cmd_mix", "master", "mix", "render_document"]
