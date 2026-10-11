"""`mix --work W --episode N [--version k]`: the episode file (AGT-1684).

Assembles an episode's voice track from a manifest version's takes, places the
script's SFX, BED and MUSIC cues from the cue library (`cues.py`), normalises,
encodes `renders/epNN/epNN.v<k>.m4a`, moves the `epNN.m4a` link and writes each
line's `start`/`end` back into the manifest. The behaviour is the prototype's
(`radio/produce.py:463-573` in the Valley's Shadow sandbox):

- the voice track is the takes in line order, each paced by its manifest
  `stretch` (a sox WSOLA `tempo -s`; takes themselves are never paced on disk),
  with 0.35 s of air after each take;
- a cue sits where the manifest says (`after`: the spoken line it follows, -1 =
  before the first). An SFX starts 0.4 s early, over the air before it, at
  0.75 gain; MUSIC starts at once at 0.9 gain; both hold the voice track for
  their whole length plus 0.2 s;
- a BED runs from its cue to the next BED cue (or the end of the speech), looped
  at 0.16 gain with 1.5 s fades (a quarter of its span at most); `[BED: off]`
  ends it with nothing in its place;
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
audio, a missing generator (`mix` extra, sox) or encoder (afconvert, ffmpeg).
"""

from __future__ import annotations

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
from pablo_casting.cues import CUE_RATE, CueAsset, CueLibrary, CueUnavailable, GeneratorFactory, is_stop
from pablo_casting.manifest import ManifestError, attach_mix, audio_versions, read_version, versions, write_version
from pablo_casting.library import LibraryRefusal, resolve_root
from pablo_casting.organ import SoxUnavailable, require_sox
from pablo_casting.receipts import append_receipt
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
class _Bed:
    start: int
    audio: np.ndarray
    placement: dict[str, object]


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


def _fade_loop(loop: np.ndarray, span: int) -> np.ndarray:
    reps = np.tile(loop, span // len(loop) + 1)[:span].copy()
    fade = min(int(SR * BED_FADE_SECONDS), span // 4)
    if fade > 0:
        reps[:fade] *= np.linspace(0, 1, fade, dtype=np.float32)
        reps[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)
    return reps


def render(
    work: Path,
    manifest: Mapping[str, object],
    library: CueLibrary,
    pacer: Pacer,
    *,
    log: Callable[[str], None] = lambda message: None,
) -> Rendered:
    raw_lines = manifest.get("lines")
    lines = sorted((l for l in raw_lines if isinstance(l, Mapping)), key=lambda l: int(l["i"])) if isinstance(raw_lines, list) else []  # type: ignore[call-overload]
    raw_cues = manifest.get("cues")
    cues = [c for c in raw_cues if isinstance(c, Mapping)] if isinstance(raw_cues, list) else []

    takes: dict[str, _Take] = {}
    missing: list[str] = []
    for line in lines:
        key = str(line["take"])
        if key in takes:
            continue
        stored = read_take(work, key)
        if stored is None or not (stored.path / "take.wav").is_file():
            missing.append(key)
            continue
        audio, rate = read_audio(stored.path / "take.wav")
        takes[key] = _Take(audio=audio, rate=rate, words=_words(stored.record))
    if missing:
        raise MixRefusal(f"take(s) not in the store: {', '.join(sorted(set(missing)))}", missing_takes=sorted(set(missing)))

    timeline = Timeline(work, cues, library, pacer, log=log, takes=takes)
    for group in _group_lines(lines):
        timeline.add(group)
    return rendered_from(timeline)


class Timeline:
    """The episode's timeline, built one line group at a time (AGT-1697).

    `render` adds every group and finishes; `perform --stream` (`stream.py`)
    adds each group as its take passes the gates and cuts segments from the
    audio that is already final. Both run this one placement code, so a
    streamed episode's segments are the final mix's samples before its one
    normalising gain, and the line timings the stream reports are the final
    file's.

    A sample is final once nothing still to come can write to it
    (`frontier`): a voice take or MUSIC starts at `t`, an SFX up to
    `SFX_OVERLAP_SECONDS` before it, and an open BED's fade-out ends where it
    closes (no earlier than `t`) and lasts at most `BED_FADE_SECONDS`; while a
    BED is shorter than four fades its fade-in is not settled either.
    """

    def __init__(
        self,
        work: Path,
        cues: Sequence[Mapping[str, object]],
        library: CueLibrary,
        pacer: Pacer,
        *,
        log: Callable[[str], None] = lambda message: None,
        takes: dict[str, _Take] | None = None,
    ) -> None:
        self.work = work
        self.cues = [c for c in cues if isinstance(c, Mapping)]
        self.library = library
        self.pacer = pacer
        self.log = log
        self.takes: dict[str, _Take] = takes if takes is not None else {}
        self.pending = sorted(range(len(self.cues)), key=lambda k: (int(self.cues[k].get("after", -1)), k))  # type: ignore[call-overload]
        self.voice: list[tuple[int, np.ndarray]] = []
        self.beds: list[tuple[int, int, np.ndarray]] = []
        self.placed_cues: list[dict[str, object]] = [{} for _ in self.cues]
        self.lines: list[dict[str, object]] = []
        self.t = 0
        self.generated = 0
        self.reused = 0
        self.bed: _Bed | None = None
        self.total: int | None = None
        self._faded: dict[int, np.ndarray] = {}

    def _asset(self, cue: Mapping[str, object]) -> tuple[CueAsset, np.ndarray]:
        asset = self.library.ensure(str(cue["kind"]), str(cue["desc"]))
        if asset.generated:
            self.generated += 1
        else:
            self.reused += 1
        self.log(f"cue {asset.kind} {'generated' if asset.generated else 'reused'}: {asset.desc}")
        return asset, self.library.load(asset)

    def _close_bed(self, at: int) -> None:
        if self.bed is not None:
            self.beds.append((self.bed.start, at, self.bed.audio))
            self.bed.placement["end"] = round(at / SR, 3)
            self.bed = None

    def _place(self, k: int) -> None:
        cue = self.cues[k]
        kind, t = str(cue["kind"]), self.t
        base: dict[str, object] = {"kind": kind, "desc": cue["desc"], "after": cue.get("after"), "line": cue.get("line")}
        if kind == "BED":
            self._close_bed(t)
            if is_stop(str(cue["desc"])):
                self.placed_cues[k] = {**base, "asset": None, "start": round(t / SR, 3), "end": round(t / SR, 3)}
                return
            asset, audio = self._asset(cue)
            self.placed_cues[k] = {**base, "asset": asset.ref, "key": asset.key, "start": round(t / SR, 3), "end": None}
            self.bed = _Bed(start=t, audio=audio * BED_GAIN, placement=self.placed_cues[k])
            return
        asset, audio = self._asset(cue)
        overlap = int(SR * SFX_OVERLAP_SECONDS) if kind == "SFX" else 0
        start = max(0, t - overlap)
        self.voice.append((start, audio * CUE_GAIN.get(kind, 0.75)))
        end = start + len(audio)
        self.placed_cues[k] = {**base, "asset": asset.ref, "key": asset.key, "start": round(start / SR, 3), "end": round(end / SR, 3)}
        self.t = end + int(SR * CUE_TAIL_SECONDS)

    def _take(self, key: str) -> _Take:
        take = self.takes.get(key)
        if take is None:
            stored = read_take(self.work, key)
            if stored is None or not (stored.path / "take.wav").is_file():
                raise MixRefusal(f"take(s) not in the store: {key}", missing_takes=[key])
            audio, rate = read_audio(stored.path / "take.wav")
            take = self.takes[key] = _Take(audio=audio, rate=rate, words=_words(stored.record))
        return take

    def add(self, group: Sequence[Mapping[str, object]]) -> None:
        """Places the cues due before `group` (consecutive lines sharing one take, in line order), then its take."""
        if self.total is not None:
            raise ValueError("the timeline is finished")
        first = int(group[0]["i"])  # type: ignore[call-overload]
        while self.pending and int(self.cues[self.pending[0]].get("after", -1)) < first:  # type: ignore[call-overload]
            self._place(self.pending.pop(0))
        take = self._take(str(group[0]["take"]))
        stretch = float(group[0].get("stretch") or 1.0)  # type: ignore[arg-type]
        paced = self.pacer(take.audio, take.rate, stretch)
        at = self.t
        clip = resample(paced, take.rate, SR)
        self.voice.append((at, clip))
        span = (0.0, len(take.audio) / take.rate)
        # The stored word times come from the aligner on the untrimmed attempt, so the last word can end after
        # the take (trimmed at the last word plus the tail air) does: nothing is audible past the take's end.
        bounds = [(min(begin, span[1]), min(end, span[1])) for begin, end in _split_words(take.words, group, span)]
        warped = warp_times(take.audio, paced, take.rate, [t for pair in bounds for t in pair])
        for k, line in enumerate(group):
            start, end = at / SR + warped[2 * k], at / SR + warped[2 * k + 1]
            self.lines.append({**line, "start": round(start, 3), "end": round(end, 3)})
        self.t = at + len(clip) + int(SR * GAP_SECONDS)

    def finish(self) -> int:
        """Places the cues after the last line and closes the bed; returns the episode's length in samples."""
        if self.total is None:
            while self.pending:
                self._place(self.pending.pop(0))
            self._close_bed(self.t)
            self.total = self.t + int(SR * END_PAD_SECONDS)
        return self.total

    def frontier(self) -> int:
        """The first sample that can still change (the episode's length once finished)."""
        if self.total is not None:
            return self.total
        final = self.t - int(SR * SFX_OVERLAP_SECONDS)
        if self.bed is not None:
            if self.t - self.bed.start < 4 * int(SR * BED_FADE_SECONDS):
                final = min(final, self.bed.start)
            else:
                final = min(final, self.t - int(SR * BED_FADE_SECONDS))
        return max(0, final)

    def mixdown(self, start: int, end: int) -> np.ndarray:
        """The summed, unnormalised samples `[start, end)`: voice and cues first, then the beds, as the mix adds them."""
        total = self.total if self.total is not None else end
        end = min(end, total)
        out = np.zeros(max(0, end - start), np.float32)
        if end <= start:
            return out
        for at, clip in self.voice:
            clip = clip[: max(0, total - at)]
            lo, hi = max(start, at), min(end, at + len(clip))
            if lo < hi:
                out[lo - start : hi - start] += clip[lo - at : hi - at]
        for k, (b_start, b_end, loop) in enumerate(self.beds):
            if b_end <= b_start or not len(loop):
                continue
            lo, hi = max(start, b_start), min(end, b_end)
            if lo < hi:
                faded = self._faded.get(k)
                if faded is None:
                    faded = self._faded[k] = _fade_loop(loop, b_end - b_start)
                out[lo - start : hi - start] += faded[lo - b_start : hi - b_start]
        bed = self.bed
        if bed is not None and len(bed.audio) and end > bed.start:
            # Still open: only its settled part is ever asked for (`frontier`), the loop with its full fade-in.
            lo = max(start, bed.start)
            reps = np.tile(bed.audio, (end - bed.start) // len(bed.audio) + 1)[: end - bed.start].copy()
            fade = int(SR * BED_FADE_SECONDS)
            reps[:fade] *= np.linspace(0, 1, fade, dtype=np.float32)[: len(reps)]
            out[lo - start : end - start] += reps[lo - bed.start :]
        return out


def normalise(buffer: np.ndarray) -> tuple[np.ndarray, float, float]:
    """The prototype's two steps (under 0.95 peak, then to -1 dBFS) as the one gain they amount to.

    Returns `(audio, peak_before, gain)`.
    """
    peak = float(np.abs(buffer).max()) if len(buffer) else 0.0
    gain = 1.0 / max(1.0, peak / PEAK)
    if peak * gain > 0:
        gain *= 10 ** (FINAL_PEAK_DB / 20) / (peak * gain)
    return (buffer * np.float32(gain)).astype(np.float32), peak, gain


def rendered_from(timeline: Timeline) -> Rendered:
    """The finished timeline as the mix's result: every line timed, the cues placed, normalised."""
    total = timeline.finish()
    audio, peak, _ = normalise(timeline.mixdown(0, total))
    timed = sorted(timeline.lines, key=lambda line: int(line["i"]))  # type: ignore[call-overload]
    return Rendered(audio=audio, lines=timed, cues=timeline.placed_cues, cues_generated=timeline.generated, cues_reused=timeline.reused, peak_before=peak)


# --- the command --------------------------------------------------------------------------------


@dataclass(frozen=True)
class MixRequest:
    work: Path
    episode: int
    cues_dir: Path
    version: int | None = None


@dataclass
class Seams:
    generators: GeneratorFactory
    pacer: Pacer = sox_pacer
    encoder: Encoder = aac_encoder
    log: Callable[[str], None] = field(default=lambda message: None)


def _refused(message: str, **extra: object) -> Result:
    return {"ok": False, "code": EXIT_REFUSED, "message": message, **extra}, EXIT_REFUSED


def _error(message: str) -> Result:
    return {"ok": False, "code": EXIT_ERROR, "message": message}, EXIT_ERROR


def mix(request: MixRequest, seams: Seams, *, timeline: Timeline | None = None, extra: Mapping[str, object] | None = None) -> Result:
    """Mixes a version into its episode file.

    `timeline` is a streamed episode's (AGT-1697): already built from this
    version's takes as they passed, so it is finished and normalised rather
    than built again; `extra` joins the manifest's `mix` block (the stream's
    segments and time to first audio).
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
    library = CueLibrary(request.cues_dir, seams.generators)
    try:
        rendered = render(work, manifest, library, seams.pacer, log=seams.log) if timeline is None else rendered_from(timeline)
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
                "wall": round(time.monotonic() - started, 3),
                **(extra or {}),
            }
            completed: dict[str, object] = {**manifest, "lines": rendered.lines, "cues": rendered.cues, "duration": duration, "mix": info}
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
    except MixRefusal as refusal:
        return _refused(str(refusal), **refusal.extra)
    except (CueUnavailable, SoxUnavailable) as missing:
        return _refused(str(missing))
    except ManifestError as failure:
        return _error(f"writing episode {episode}'s mixed manifest failed: {failure}")
    except subprocess.CalledProcessError as failure:
        return _error(f"mixing episode {episode} failed: {failure.cmd[0]} exited {failure.returncode}")

    out_version = int(written.manifest["version"])  # type: ignore[call-overload]
    append_receipt(work, {"intent": "mix", "episode": episode, "version": out_version, "from_version": version, **info})
    audio_name = written.audio.name if written.audio else None
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
        "wall": info["wall"],
        "message": (
            f"episode {episode} v{out_version}: {duration:.1f} s, {len(rendered.lines)} lines, {len(rendered.cues)} cues "
            f"({rendered.cues_generated} generated, {rendered.cues_reused} reused) -> {audio_name}"
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


def cmd_mix(
    work: Path | None,
    episode: str | None,
    version: int | None,
    cues: str | None,
    library: str | None,
    vault: str | None,
    seams: Seams,
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
    root = cues_dir_for(work, cues, library, vault)
    return mix(MixRequest(work=work, episode=number, cues_dir=root, version=version), seams)


__all__ = ["MixRequest", "Seams", "check_timings", "cmd_mix", "mix", "render"]
