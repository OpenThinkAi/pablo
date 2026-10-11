"""Shared mix maths (AGT-1765): the one spec the Python export and the TS preview both follow.

The TS twin is `packages/cli/views/mixmath.ts`; both are tested against
`packages/casting/tests/fixtures/mixmath-golden.json` within 1e-4. Change a
formula here and you must change the twin and regenerate the golden file.

Spec
- `db_to_gain(db) = 10^(db/20)`; `-inf` dB is exactly 0. `gain_to_db(g) = 20*log10(g)`,
  and `g <= 0` is `-inf`.
- A fade curve maps progress x in [0, 1] (clamped) to a gain rising 0 -> 1:
  linear `x`; scurve `x*x*(3-2x)`; log `log10(1+9x)`; exp `(10^x - 1)/9`
  (exp is the mirror of log: `exp(x) = 1 - log(1-x)`).
- Fade-in gain at t seconds into a fade of length L is `curve(t/L)`; fade-out is
  `curve(1 - t/L)`. A length <= 0 is no fade (gain 1).
- Buffer fades: a fade of n samples puts sample j (0-based within the fade) at
  progress `j/n` (in), or `1 - j/n` (out; the fade occupies the last n samples).
- Equal-power crossfade at progress x: `(out, in) = (cos(x*pi/2), sin(x*pi/2))`.
- Automation: breakpoints `{t, db, curve}` (seconds, dB, curve of the segment
  that STARTS at the point, default linear). Before the first point the value is
  the first point's dB; after the last it holds the last dB. Inside a segment the
  value is `db0 + (db1 - db0) * curve(x)` in the dB domain, then converted to
  gain. Equal times are a step: the later point wins. Points are sorted by t.
"""

from __future__ import annotations

import math
from typing import Mapping, Sequence

import numpy as np

CURVES = ("linear", "scurve", "log", "exp")


def db_to_gain(db: float) -> float:
    if db == -math.inf:
        return 0.0
    return 10.0 ** (db / 20.0)


def gain_to_db(gain: float) -> float:
    if gain <= 0.0:
        return -math.inf
    return 20.0 * math.log10(gain)


def fade_curve(curve: str, x: float) -> float:
    """Gain (0 -> 1) at fade progress x, clamped to [0, 1]."""
    x = min(1.0, max(0.0, x))
    if curve == "linear":
        return x
    if curve == "scurve":
        return x * x * (3.0 - 2.0 * x)
    if curve == "log":
        return math.log10(1.0 + 9.0 * x)
    if curve == "exp":
        return (10.0**x - 1.0) / 9.0
    raise ValueError(f"unknown fade curve: {curve!r}")


def fade_in_gain(curve: str, length: float, t: float) -> float:
    if length <= 0.0:
        return 1.0
    return fade_curve(curve, t / length)


def fade_out_gain(curve: str, length: float, t: float) -> float:
    """`t` is seconds since the fade-out began."""
    if length <= 0.0:
        return 1.0
    return fade_curve(curve, 1.0 - t / length)


def apply_fade(buffer: np.ndarray, curve: str, length: int, direction: str) -> np.ndarray:
    """A copy of `buffer` (frames on axis 0) with a `length`-sample fade at its start ("in") or end ("out")."""
    if direction not in ("in", "out"):
        raise ValueError(f"direction must be 'in' or 'out', got {direction!r}")
    out = np.array(buffer, copy=True)
    if out.dtype.kind != "f":
        out = out.astype(np.float32)
    n = min(int(length), out.shape[0])
    if n <= 0:
        return out
    if direction == "in":
        gains = [fade_curve(curve, j / length) for j in range(n)]
    else:
        gains = [fade_curve(curve, 1.0 - j / length) for j in range(n)]
    shaped = np.asarray(gains, dtype=np.float64).reshape((n,) + (1,) * (out.ndim - 1))
    if direction == "in":
        out[:n] = out[:n] * shaped
    else:
        out[out.shape[0] - n :] = out[out.shape[0] - n :] * shaped
    return out


def equal_power_crossfade(x: float) -> tuple[float, float]:
    """`(outgoing, incoming)` gains at crossfade progress x in [0, 1]."""
    x = min(1.0, max(0.0, x))
    return math.cos(x * math.pi / 2.0), math.sin(x * math.pi / 2.0)


def automation_db_at(points: Sequence[Mapping], t: float) -> float:
    pts = sorted(points, key=lambda p: p["t"])  # stable: equal t keeps input order
    if not pts:
        return 0.0
    if t < pts[0]["t"]:
        return float(pts[0]["db"])
    k = 0
    for i, p in enumerate(pts):
        if p["t"] <= t:
            k = i
    if k == len(pts) - 1:
        return float(pts[k]["db"])
    a, b = pts[k], pts[k + 1]
    x = (t - a["t"]) / (b["t"] - a["t"])
    return float(a["db"]) + (float(b["db"]) - float(a["db"])) * fade_curve(a.get("curve", "linear"), x)


def automation_gain_at(points: Sequence[Mapping], t: float) -> float:
    return db_to_gain(automation_db_at(points, t))


def sample_automation(points: Sequence[Mapping], sample_rate: int, frames: int, start: float = 0.0) -> np.ndarray:
    """Linear gain per frame for `frames` frames starting at `start` seconds (float32)."""
    return np.array(
        [automation_gain_at(points, start + i / sample_rate) for i in range(frames)], dtype=np.float32
    )
