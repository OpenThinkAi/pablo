"""The mixer view's placement and envelopes against mix.py's (AGT-1768). Model-free.

`fixtures/mix-anchors-golden.json` holds a mix document and what `mix.py` makes of it: every clip's start and
end on the timeline (samples), each clip's gain envelope (gain, fades, same-lane equal-power crossfades) at a
handful of samples, and a track's automation breakpoints and gains. The TS twin
(`packages/cli/test/mixer-logic.test.ts`) asserts the same numbers from `views/mixer-logic.ts`, so preview and
export place and shape clips alike. When the maths changes on purpose, regenerate `expected` with
`uv run python tests/test_mixer_view_parity.py` and change both sides.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

from pablo_casting.mix import SR, _clip_audio, _Placed, _resolve, _samples
from pablo_casting.mixdoc import clip_field, clips, validate
from pablo_casting.mixmath import automation_gain_at

FIXTURE = Path(__file__).parent / "fixtures" / "mix-anchors-golden.json"
AUTOMATION_TIMES = [0.0, 0.5, 1.0, 1.55, 2.0, 2.4, 3.0, 3.5, 4.0, 5.0]


def probes(length: int) -> list[int]:
    """The samples each envelope is checked at (the TS side reads them from the fixture)."""
    marks = [0, 1, 2, length // 10, length // 4, length // 3, length // 2, 2 * length // 3, 3 * length // 4, 9 * length // 10, length - 2, length - 1]
    return sorted({j for j in marks if 0 <= j < length})


def compute(doc: dict[str, object]) -> dict[str, object]:
    placed = [
        _Placed(track=track, lane=lane, field=clip_field(track, lane, k), clip=clip, audio=np.ones(_samples(clip["out"]) - _samples(clip["in"]), np.float32))  # type: ignore[index]
        for track, lane, k, clip in clips(doc)
    ]
    when = _resolve(placed)
    lanes: dict[tuple[str, str], list[_Placed]] = {}
    for p in placed:
        lanes.setdefault((p.track, p.lane), []).append(p)
    envelopes: dict[str, list[list[float]]] = {}
    for members in lanes.values():
        members.sort(key=lambda p: p.start)
        for k, p in enumerate(members):
            audio = _clip_audio(members, k)
            envelopes[str(p.clip["id"])] = [[j, round(float(audio[j]), 6)] for j in probes(len(audio))]
    tracks = doc["tracks"]
    assert isinstance(tracks, dict)
    automation = tracks["beds"]["automation"]
    points = [{"t": (when(point["anchor"]) or 0) / SR, "db": float(point["db"]), "curve": point.get("curve", "linear")} for point in automation]
    return {
        "placement": {str(p.clip["id"]): [p.start, p.end] for p in placed},
        "envelopes": envelopes,
        "automation": {
            "track": "beds",
            "points": [[round(p["t"], 9), p["db"], p["curve"]] for p in points],
            "gains": [[t, round(automation_gain_at(points, t), 6)] for t in AUTOMATION_TIMES],
        },
    }


def test_fixture_document_is_valid():
    assert validate(json.loads(FIXTURE.read_text())["document"]) == []


def test_mix_py_places_and_shapes_the_fixture_as_recorded():
    golden = json.loads(FIXTURE.read_text())
    got = compute(golden["document"])
    want = golden["expected"]
    assert got["placement"] == want["placement"]
    assert got["automation"]["points"] == want["automation"]["points"]
    for t, gain in want["automation"]["gains"]:
        assert abs(dict(map(tuple, got["automation"]["gains"]))[t] - gain) < 1e-6
    assert set(got["envelopes"]) == set(want["envelopes"])
    for clip_id, rows in want["envelopes"].items():
        assert [j for j, _ in got["envelopes"][clip_id]] == [j for j, _ in rows], clip_id
        for (_, a), (_, b) in zip(got["envelopes"][clip_id], rows):
            assert abs(a - b) < 1e-5, clip_id


if __name__ == "__main__":  # regenerate: prints the fixture with `expected` recomputed
    golden = json.loads(FIXTURE.read_text())
    golden["expected"] = compute(golden["document"])
    json.dump(golden, sys.stdout, indent=1)
    sys.stdout.write("\n")
