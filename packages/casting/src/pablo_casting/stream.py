"""The progressive render's live half (AGT-1697): segments of an episode as its lines pass.

`perform --stream` hands each decided pass to an `EpisodeStream`, which adds
it to the mix's own `Timeline` (`mix.py`) and cuts every fixed-length segment
whose samples are already final into the listening directory, so a listener
can start an episode before its last line is performed. When the last line
has passed, the same timeline is finished, normalised and encoded as the
episode file (`mix.mix(..., timeline=...)`), so the final file is the
concatenated segments times the mix's one normalising gain, and its line
timings are the ones the stream reported.

**The listening directory** is `<work>/.pablo/out/stream/` (machine state,
gitignored, beside the other publish targets' `.pablo/out/`). This module
writes only an episode's live files:

    epNN/stream.json            the stream's index (below), rewritten atomically
    epNN/playlist.m3u8          an HLS-style event playlist of the segments
    epNN/segments/seg-NNNNN.wav 16-bit PCM at the mix's rate, written once

`pablo publish --target stream` (`packages/cli/src/radio-stream.ts`) writes the
published chapter beside them (`manifest.json`, `epNN.m4a`) and the
directory's `index.json`; the review player reads all of it.

`stream.json`: `episode`, `state` (`streaming`, `finished` once every segment
is cut, `mixed` once the episode file exists, `failed`), `sample_rate`,
`segment_seconds`, `playable` (true once `PLAYABLE_SECONDS` of the episode's
timeline have passed the gates, or the episode is finished), `seconds` (cut so
far), `lines_done` / `lines_total`, `segments` (`n`, `file`, `start`,
`seconds`), `lines` (each passed line's `i`, `speaker`, `text`, `start`,
`end`, `status`, `gates`, `failing`, in the final file's time), `ttfa` and,
once mixed, `version` and `audio`.

**Time to first audio** (`ttfa`, seconds from the start of `perform`, engine
load included): `first_audio` when the first segment is on disk, `playable`
when the episode became playable, `chapter` when the episode file exists;
`started` is the wall-clock start, so a caller (the story pipeline) can
measure from its own origin instead.

Segments are the summed mix before normalisation, clipped to full scale:
the gain that normalises the whole episode is known only at its end.
"""

from __future__ import annotations

import json
import os
import shutil
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

import numpy as np
import soundfile as sf

from pablo_casting.mix import SR, Timeline
from pablo_casting.receipts import now

SEGMENT_SECONDS = 6.0
"""HLS's customary target duration."""
PLAYABLE_SECONDS = 30.0
"""How much of the episode must have passed the gates before a listener is told to start."""

STATE_STREAMING = "streaming"
STATE_FINISHED = "finished"
STATE_MIXED = "mixed"
STATE_FAILED = "failed"


def stream_root(work: Path) -> Path:
    """The listening directory."""
    return work / ".pablo" / "out" / "stream"


def stream_dir(work: Path, episode: int) -> Path:
    return stream_root(work) / f"ep{episode:02d}"


def _write_atomic(path: Path, text: str) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}")
    temporary.write_text(text, encoding="utf-8")
    os.replace(temporary, path)


def _line_row(line: Mapping[str, object]) -> dict[str, object]:
    return {key: line.get(key) for key in ("i", "speaker", "text", "start", "end", "status", "gates", "failing")}


class EpisodeStream:
    """One episode's live stream: feed it each decided pass in line order, then `finish`."""

    def __init__(
        self,
        work: Path,
        episode: int,
        timeline: Timeline,
        *,
        lines_total: int,
        started: float,
        started_at: str,
        clock: Callable[[], float] = time.monotonic,
        segment_seconds: float = SEGMENT_SECONDS,
        playable_seconds: float = PLAYABLE_SECONDS,
    ) -> None:
        self.work = work
        self.episode = episode
        self.timeline = timeline
        self.lines_total = lines_total
        self.started = started
        self.clock = clock
        self.segment = int(round(segment_seconds * SR))
        self.segment_seconds = segment_seconds
        self.playable_seconds = playable_seconds
        self.dir = stream_dir(work, episode)
        self.segments: list[dict[str, object]] = []
        self.emitted = 0
        self.state = STATE_STREAMING
        self.playable = False
        self.version: int | None = None
        self.audio: str | None = None
        self.ttfa: dict[str, object] = {"first_audio": None, "playable": None, "chapter": None, "started": started_at}
        self._set_aside()
        (self.dir / "segments").mkdir(parents=True, exist_ok=True)
        self._write_index()

    def _set_aside(self) -> None:
        """An earlier stream of this episode (a run that stopped) is moved under `_superseded/`, never deleted."""
        if not self.dir.exists():
            return
        aside = stream_root(self.work) / "_superseded"
        aside.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
        shutil.move(str(self.dir), str(aside / f"{self.dir.name}-{stamp}-{uuid.uuid4().hex[:6]}"))

    def _elapsed(self) -> float:
        return round(self.clock() - self.started, 3)

    # -- feeding ----------------------------------------------------------------------------------

    def add(self, group: Sequence[Mapping[str, object]]) -> list[dict[str, object]]:
        """Adds a decided pass's lines to the timeline; returns the events for what that made available."""
        self.timeline.add(group)
        return self._cut(final=False)

    def finish(self) -> list[dict[str, object]]:
        """The last line has passed: the closing cues are placed and the rest of the episode is cut."""
        self.timeline.finish()
        events = self._cut(final=True)
        self.state = STATE_FINISHED
        self._write_index()
        return events

    def mixed(self, version: int, audio: str | None) -> dict[str, object]:
        """The episode file exists: records it and the time it took. Returns the event."""
        self.version, self.audio = version, audio
        self.ttfa["chapter"] = self._elapsed()
        self.state = STATE_MIXED
        self._write_index()
        return {"event": "chapter", "episode": self.episode, "version": version, "audio": audio, "ttfa": dict(self.ttfa)}

    def failed(self) -> None:
        self.state = STATE_FAILED
        self._write_index()

    # -- cutting ----------------------------------------------------------------------------------

    def _cut(self, *, final: bool) -> list[dict[str, object]]:
        events: list[dict[str, object]] = []
        frontier = self.timeline.frontier()
        while frontier - self.emitted >= self.segment or (final and self.emitted < frontier):
            end = min(self.emitted + self.segment, frontier)
            events.append(self._write_segment(self.emitted, end))
            self.emitted = end
        if not self.playable and self.segments and (final or self.timeline.t / SR >= self.playable_seconds):
            self.playable = True
            self.ttfa["playable"] = self._elapsed()
            events.append({"event": "playable", "episode": self.episode, "seconds": round(self.emitted / SR, 3), "ttfa": self.ttfa["playable"]})
        if events:
            self._write_index()
        return events

    def _write_segment(self, start: int, end: int) -> dict[str, object]:
        n = len(self.segments)
        name = f"seg-{n:05d}.wav"
        target = self.dir / "segments" / name
        staging = target.with_name(f".{name}.{uuid.uuid4().hex[:8]}.wav")
        samples = np.clip(self.timeline.mixdown(start, end), -1.0, 1.0)
        sf.write(str(staging), samples, SR, format="WAV", subtype="PCM_16")
        os.replace(staging, target)
        row = {"n": n, "file": f"segments/{name}", "start": round(start / SR, 6), "seconds": round((end - start) / SR, 6)}
        self.segments.append(row)
        if self.ttfa["first_audio"] is None:
            self.ttfa["first_audio"] = self._elapsed()
        return {"event": "segment", "episode": self.episode, **row}

    # -- the index --------------------------------------------------------------------------------

    def body(self) -> dict[str, object]:
        lines = sorted(self.timeline.lines, key=lambda line: int(line["i"]))  # type: ignore[call-overload]
        return {
            "episode": self.episode,
            "state": self.state,
            "sample_rate": SR,
            "segment_seconds": self.segment_seconds,
            "playable_after_seconds": self.playable_seconds,
            "playable": self.playable,
            "seconds": round(self.emitted / SR, 3),
            "lines_done": len(lines),
            "lines_total": self.lines_total,
            "segments": list(self.segments),
            "lines": [_line_row(line) for line in lines],
            "ttfa": dict(self.ttfa),
            "version": self.version,
            "audio": self.audio,
            "updated": now(),
        }

    def _write_index(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        _write_atomic(self.dir / "stream.json", json.dumps(self.body(), indent=2, ensure_ascii=False) + "\n")
        _write_atomic(self.dir / "playlist.m3u8", self.playlist())

    def playlist(self) -> str:
        """An HLS-style event playlist; `#EXT-X-ENDLIST` once every segment is cut."""
        target = max([int(np.ceil(float(s["seconds"]))) for s in self.segments] or [int(np.ceil(self.segment_seconds))])  # type: ignore[arg-type]
        rows = ["#EXTM3U", "#EXT-X-VERSION:3", f"#EXT-X-TARGETDURATION:{target}", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:EVENT"]
        for segment in self.segments:
            rows += [f"#EXTINF:{float(segment['seconds']):.3f},", str(segment["file"])]  # type: ignore[arg-type]
        if self.state in (STATE_FINISHED, STATE_MIXED):
            rows.append("#EXT-X-ENDLIST")
        return "\n".join(rows) + "\n"


__all__ = ["PLAYABLE_SECONDS", "SEGMENT_SECONDS", "EpisodeStream", "stream_dir", "stream_root"]
