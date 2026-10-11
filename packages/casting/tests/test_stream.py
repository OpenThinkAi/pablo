"""`perform --stream`: segments as the lines pass, the episode file from the same timeline (AGT-1697). Model-free.

A slow fake engine (a tone per take, optionally held at one call) stands in for
the GPU; the cue generator, pacer and encoder are `test_mix`'s fakes, so the
"m4a" is the mixed WAV and can be read back. Every script line, cue and voice
here is invented.
"""

from __future__ import annotations

import io
import json
import shutil
import threading
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from pablo_casting.binding import bind
from pablo_casting.cli import run
from pablo_casting.engines import EngineSpec, RecordingEngine, VoiceRef
from pablo_casting.manifest import episode_dir, read_version, versions
from pablo_casting.mix import MixRequest, mix
from pablo_casting.perform import PerformRequest, perform
from pablo_casting.receipts import receipts_path
from pablo_casting.stream import PLAYABLE_SECONDS, SEGMENT_SECONDS, stream_dir, stream_root
from pablo_casting.takes import Synthesis, TakeInputs
from pablo_casting.wav import Audio
from test_mix import FakeCues, seams
from test_perform import fake_scorers, make_card

SENTENCES = [
    "The tide came in early over the shingle tonight.",
    "Nobody on the quay had seen a lantern since noon.",
    "Mavis counted the boats twice and got two answers.",
    "Otto said the fog would lift before the late ferry.",
    "It did not lift, and the ferry did not come.",
    "Somewhere past the breakwater a bell kept its own time.",
    "The harbour master wrote the hour in a careful hand.",
    "Rain followed the fog the way a dog follows a cart.",
    "By ten the lamps along the front had all gone amber.",
    "Mavis kept the kettle on for whoever came in wet.",
    "Otto came in wet, as he always did, and said nothing.",
    "The bell stopped, and the whole town listened to it stop.",
    "Then the ferry horn, low and long, from the wrong side.",
]


def script() -> str:
    rows = ['CAST: MAVIS=f "forties, warm", OTTO=m "sixties, gruff"', "[MUSIC: a brass sting]", "[BED: rain on a tin roof]"]
    for k, sentence in enumerate(SENTENCES):
        rows.append(f"{'MAVIS' if k % 2 == 0 else 'OTTO'}: {sentence}")
        if k == 4:
            rows.append("[SFX: a door bangs]")
        if k == 9:
            rows.append("[BED: off]")
    return "\n".join(rows) + "\n"


@dataclass
class ToneEngine(RecordingEngine):
    """The recording engine with a tone instead of silence, so the mix has something to sum; optionally held at one call."""

    hold_at: int | None = None
    holding: threading.Event = field(default_factory=threading.Event)
    release: threading.Event = field(default_factory=threading.Event)
    seen: list[dict[str, object]] = field(default_factory=list)
    work: Path | None = None

    def synthesize(self, inputs: TakeInputs) -> Synthesis:
        n = len(self.calls)
        if self.work is not None:
            index = stream_dir(self.work, 1) / "stream.json"
            self.seen.append(json.loads(index.read_text(encoding="utf-8")) if index.is_file() else {})
        if self.hold_at is not None and n == self.hold_at:
            self.holding.set()
            assert self.release.wait(10), "the test never released the engine"
        silent = super().synthesize(inputs)
        frames = len(silent.audio.frames) // 2
        t = np.arange(frames) / self.sample_rate
        wave = 0.3 * np.sin(2 * np.pi * (180 + 20 * (n % 5)) * t) * (t < frames / self.sample_rate - 0.18)
        pcm = (wave * 32767).astype("<i2").tobytes()
        return Synthesis(audio=Audio(frames=pcm, sample_rate=self.sample_rate), peak_memory_gb=1.5, ttfa=0.01)


class Factory:
    def __init__(self, **kwargs: object) -> None:
        self.kwargs = kwargs
        self.engine: ToneEngine | None = None

    def __call__(self, spec: EngineSpec, voices: Mapping[str, VoiceRef], env: Mapping[str, str]) -> ToneEngine:
        self.engine = ToneEngine(spec=spec, voices=voices, wps=(2.8,), **self.kwargs)  # type: ignore[arg-type]
        return self.engine


@pytest.fixture
def setup(tmp_path: Path) -> tuple[Path, Path]:
    work = tmp_path / "work"
    episodes = work / "outputs" / "radio" / "episodes"
    episodes.mkdir(parents=True)
    (episodes / "01-the-late-ferry.md").write_text(script(), encoding="utf-8")
    library = tmp_path / "library"
    make_card(library, "mavis")
    make_card(library, "otto")
    bind(work, library / "voices", "MAVIS", "mavis")
    bind(work, library / "voices", "OTTO", "otto")
    return work, library


def go(work: Path, library: Path, factory: Factory, *, stream: bool = True, cues: FakeCues | None = None):
    mixer, _ = seams(cues)
    err, out = io.StringIO(), io.StringIO()
    body, code = perform(
        PerformRequest(work=work, episode=1, engine="chatterbox-turbo", voices_dir=library / "voices", json_lines=True, stream=stream, cues_dir=library / "cues"),
        env={},
        engine_factory=factory,
        scorer_factory=fake_scorers,
        err=err,
        out=out,
        mixer=mixer,
    )
    return body, code, [json.loads(line) for line in out.getvalue().splitlines()]


def index(work: Path) -> dict[str, object]:
    return json.loads((stream_dir(work, 1) / "stream.json").read_text(encoding="utf-8"))


def segments_audio(work: Path) -> np.ndarray:
    rows = index(work)["segments"]
    parts = [sf.read(str(stream_dir(work, 1) / row["file"]), dtype="float32")[0] for row in rows]  # type: ignore[index]
    return np.concatenate(parts)


# AC2: segments as lines pass, the final file is their concatenation ------------------------------


def test_the_episode_streams_in_fixed_segments_and_the_final_file_is_their_concatenation(setup: tuple[Path, Path]) -> None:
    work, library = setup
    body, code, events = go(work, library, Factory())
    assert code == 0, body
    stream = index(work)
    assert stream["state"] == "mixed" and stream["version"] == 1
    rows = stream["segments"]
    assert len(rows) >= 7
    assert all(row["seconds"] == pytest.approx(SEGMENT_SECONDS, abs=1e-4) for row in rows[:-1])  # type: ignore[index]
    assert all(rows[k + 1]["start"] == pytest.approx(rows[k]["start"] + rows[k]["seconds"], abs=1e-4) for k in range(len(rows) - 1))  # type: ignore[index]

    manifest = read_version(work, 1, 1)
    final, rate = sf.read(str(episode_dir(work, 1) / str(manifest["audio"])), dtype="float32")
    joined = segments_audio(work)
    assert rate == 44_100 and len(joined) == len(final)
    # One gain apart (the normalisation), up to 16-bit rounding.
    gain = float(np.dot(final, joined) / np.dot(joined, joined))
    assert np.max(np.abs(final - gain * joined)) < 2e-3
    assert stream["seconds"] == pytest.approx(manifest["duration"], abs=1e-3)

    # The timings the stream reported are the final file's.
    timed = {line["i"]: line for line in manifest["lines"]}
    assert len(stream["lines"]) == len(SENTENCES)  # type: ignore[arg-type]
    for line in stream["lines"]:  # type: ignore[union-attr]
        assert abs(line["start"] - timed[line["i"]]["start"]) <= 0.15
        assert abs(line["end"] - timed[line["i"]]["end"]) <= 0.15

    playlist = (stream_dir(work, 1) / "playlist.m3u8").read_text(encoding="utf-8")
    assert playlist.startswith("#EXTM3U") and playlist.rstrip().endswith("#EXT-X-ENDLIST")
    assert playlist.count("#EXTINF:") == len(rows)
    kinds = [e["event"] for e in events]
    assert kinds.index("segment") < kinds.index("done") < kinds.index("chapter")
    assert kinds.count("segment") == len(rows) and kinds.count("playable") == 1


def test_the_stream_is_the_mix_pablo_mix_would_make(setup: tuple[Path, Path], tmp_path: Path) -> None:
    """Performed without `--stream` and mixed afterwards, the same script gives the same file and timings."""
    work, library = setup
    plain = tmp_path / "plain"
    shutil.copytree(work, plain)
    _, code, _ = go(work, library, Factory())
    assert code == 0
    _, code, _ = go(plain, library, Factory(), stream=False)
    assert code == 0 and not stream_root(plain).exists()
    mixer, _ = seams()
    _, code = mix(MixRequest(work=plain, episode=1, cues_dir=library / "cues"), mixer)
    assert code == 0
    streamed, mixed = read_version(work, 1, 1), read_version(plain, 1, 1)
    assert [(l["take"], l["start"], l["end"]) for l in streamed["lines"]] == [(l["take"], l["start"], l["end"]) for l in mixed["lines"]]
    a, _ = sf.read(str(episode_dir(work, 1) / str(streamed["audio"])), dtype="float32")
    b, _ = sf.read(str(episode_dir(plain, 1) / str(mixed["audio"])), dtype="float32")
    assert np.max(np.abs(a - b)) < 1e-4


def test_playback_can_begin_once_thirty_seconds_have_passed_while_the_rest_still_renders(setup: tuple[Path, Path]) -> None:
    work, library = setup
    factory = Factory(hold_at=len(SENTENCES) - 1, work=work)
    result: dict[str, object] = {}
    worker = threading.Thread(target=lambda: result.update(zip(("body", "code", "events"), go(work, library, factory))))
    worker.start()
    try:
        assert _wait(lambda: factory.engine is not None and factory.engine.holding.is_set())
        # The last line is still with the engine: no manifest, no episode file, but a playable stream.
        assert versions(work, 1) == []
        live = index(work)
        assert live["state"] == "streaming" and live["playable"] is True
        assert live["lines_done"] == len(SENTENCES) - 1 and live["lines_total"] == len(SENTENCES)
        assert all((stream_dir(work, 1) / row["file"]).is_file() for row in live["segments"])  # type: ignore[index, union-attr]
        assert live["ttfa"]["first_audio"] is not None and live["ttfa"]["playable"] is not None  # type: ignore[index]
        # Before 30 s of the episode had passed it was not yet playable; from then on it was.
        engine = factory.engine
        assert engine is not None
        for seen in engine.seen:
            if not seen or not seen.get("lines"):
                continue
            passed = max(float(line["end"]) for line in seen["lines"])  # type: ignore[union-attr]
            if passed < PLAYABLE_SECONDS - SEGMENT_SECONDS:
                assert seen["playable"] is False
        assert any(seen.get("playable") is True for seen in engine.seen)
    finally:
        if factory.engine is not None:
            factory.engine.release.set()
        worker.join(10)
    assert result["code"] == 0, result["body"]
    assert index(work)["state"] == "mixed"


# AC3: time to first audio in the manifest and the receipts ----------------------------------------


def test_time_to_first_audio_is_in_the_manifest_and_the_receipts(setup: tuple[Path, Path]) -> None:
    work, library = setup
    body, code, _ = go(work, library, Factory())
    assert code == 0
    ttfa = read_version(work, 1, 1)["ttfa"]
    assert 0 <= ttfa["first_audio"] <= ttfa["playable"]
    assert isinstance(ttfa["started"], str)
    rows = [json.loads(line) for line in receipts_path(work).read_text(encoding="utf-8").splitlines()]
    performed = next(r for r in rows if r["intent"] == "perform")
    streamed = next(r for r in rows if r["intent"] == "stream")
    assert performed["ttfa"]["first_audio"] == ttfa["first_audio"]
    assert streamed["ttfa"]["first_audio"] == ttfa["first_audio"]
    assert streamed["ttfa"]["chapter"] >= ttfa["playable"]
    assert body["ttfa"]["chapter"] == streamed["ttfa"]["chapter"]
    assert read_version(work, 1, 1)["mix"]["stream"]["segments"] == len(index(work)["segments"])  # type: ignore[arg-type]


# AC4: nothing here changes a take or what changed_lines means ---------------------------------------


def test_streaming_changes_no_take_and_no_manifest_semantics(setup: tuple[Path, Path], tmp_path: Path) -> None:
    work, library = setup
    plain = tmp_path / "plain"
    shutil.copytree(work, plain)
    go(work, library, Factory())
    go(plain, library, Factory(), stream=False)
    streamed, performed = read_version(work, 1, 1), read_version(plain, 1, 1)
    assert streamed["changed_lines"] == performed["changed_lines"] == list(range(len(SENTENCES)))
    assert streamed["parent"] is None and streamed["flags_applied"] == []
    assert [l["take"] for l in streamed["lines"]] == [l["take"] for l in performed["lines"]]
    for a, b in zip(streamed["lines"], performed["lines"], strict=True):
        assert {k: v for k, v in a.items() if k not in ("start", "end")} == b
    assert versions(work, 1) == [1]


def test_a_stream_that_stopped_is_set_aside_and_the_rerun_resumes(setup: tuple[Path, Path]) -> None:
    work, library = setup
    body, code, _ = go(work, library, Factory(fail_on_call=5))
    assert code == 1, body
    assert index(work)["state"] == "failed"
    body, code, _ = go(work, library, Factory())
    assert code == 0, body
    assert body["takesReused"] == 5
    aside = list((stream_root(work) / "_superseded").iterdir())
    assert len(aside) == 1 and json.loads((aside[0] / "stream.json").read_text(encoding="utf-8"))["state"] == "failed"


def test_cli_perform_stream_passes_through(setup: tuple[Path, Path], capsys: pytest.CaptureFixture[str]) -> None:
    work, library = setup
    mixer, _ = seams()
    (body, code), _ = run(
        ["perform", "--work", str(work), "--episode", "1", "--library", str(library), "--stream", "--json-lines", "--json"],
        {},
        scorers=fake_scorers,
        engines=Factory(),
        mixer=mixer,
    )
    assert code == 0, body
    assert body["stream"] == str(stream_dir(work, 1)) and Path(str(body["audio"])).is_file()
    events = [json.loads(line)["event"] for line in capsys.readouterr().out.splitlines()]
    assert events[0] == "start" and events[-1] == "chapter" and "segment" in events and "playable" in events
    assert (library / "cues").is_dir()  # the library's cue directory, shared with `pablo mix`


def test_cli_perform_stream_builds_the_real_mix_seams(setup: tuple[Path, Path]) -> None:
    """With no injected mixer the CLI makes the real one (a regression: it once raised before refusing)."""
    work, library = setup

    class Unavailable(RecordingEngine):
        def load(self) -> dict[str, object]:
            from pablo_casting.engines import EngineUnavailable

            raise EngineUnavailable("no engine in this test")

    (body, code), _ = run(
        ["perform", "--work", str(work), "--episode", "1", "--library", str(library), "--stream", "--json"],
        {},
        scorers=fake_scorers,
        engines=lambda spec, voices, env: Unavailable(spec=spec, voices=voices),
    )
    assert code == 2, body  # sox missing, or the engine refused: a refusal either way, never a crash
    assert versions(work, 1) == []


def _wait(predicate, seconds: float = 10.0) -> bool:  # type: ignore[no-untyped-def]
    done = threading.Event()
    for _ in range(int(seconds / 0.01)):
        if predicate():
            return True
        done.wait(0.01)
    return False
