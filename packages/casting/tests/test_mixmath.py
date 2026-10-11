"""Mix maths against the golden vectors shared with the TS twin (AGT-1765). Model-free."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest

from pablo_casting import mixmath as m

G = json.loads((Path(__file__).parent / "fixtures" / "mixmath-golden.json").read_text())
TOL = G["tolerance"]


def close(a: float, b: float) -> None:
    assert abs(a - b) <= TOL, (a, b)


def test_golden_db_gain():
    for r in G["db"]:
        close(m.db_to_gain(r["db"]), r["gain"])
    for r in G["gain_to_db"]:
        close(m.gain_to_db(r["gain"]), r["db"])
    assert m.db_to_gain(-math.inf) == 0.0
    assert m.gain_to_db(0.0) == -math.inf


def test_golden_fade_curves():
    assert sorted(G["curves"]) == sorted(m.CURVES)
    for c in m.CURVES:
        for r in G["curves"][c]:
            close(m.fade_curve(c, r["x"]), r["gain"])
    for r in G["fade_in"]:
        close(m.fade_in_gain(r["curve"], r["length"], r["t"]), r["gain"])
    for r in G["fade_out"]:
        close(m.fade_out_gain(r["curve"], r["length"], r["t"]), r["gain"])


def test_golden_buffer_fades():
    for r in G["buffer_fades"]:
        out = m.apply_fade(np.array(r["input"], dtype=np.float32), r["curve"], r["length"], r["direction"])
        assert len(out) == len(r["output"])
        for a, b in zip(out, r["output"]):
            close(float(a), b)


def test_golden_equal_power_crossfade():
    for r in G["crossfade"]:
        o, i = m.equal_power_crossfade(r["x"])
        close(o, r["out"])
        close(i, r["in"])
        close(o * o + i * i, 1.0)


def test_golden_automation():
    pts = G["automation"]["points"]
    for r in G["automation"]["samples"]:
        close(m.automation_db_at(pts, r["t"]), r["db"])
        close(m.automation_gain_at(pts, r["t"]), r["gain"])
    b = G["automation"]["buffer"]
    out = m.sample_automation(pts, b["sample_rate"], b["frames"], b["start"])
    assert len(out) == len(b["gains"])
    for a, e in zip(out, b["gains"]):
        close(float(a), e)


def test_edges():
    assert m.fade_in_gain("exp", 0, 0) == 1.0
    assert m.automation_db_at([], 3) == 0.0
    with pytest.raises(ValueError):
        m.fade_curve("nope", 0.5)
    stereo = m.apply_fade(np.ones((10, 2), dtype=np.float32), "linear", 5, "in")
    assert stereo.shape == (10, 2) and stereo[0, 1] == 0.0 and stereo[9, 0] == 1.0
