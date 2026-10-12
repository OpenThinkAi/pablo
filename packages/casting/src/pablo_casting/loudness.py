"""Integrated loudness (ITU-R BS.1770-4, mono) and the per-kind cue normalisation (AGT-1786, AGT-1799).

Every cue asset is measured once (its LUFS is cached in the cue sidecar) and
brought to a per-kind target before the mix's own gain, so a hot asset no
longer stays hot: the mix document's clip gain stays the human-editable offset
on top (`mixmath`). The K-weighting is the standard's two biquads (the
pre-filter high shelf and the RLB high pass), designed for the asset's own
rate as libebur128 does and applied in the frequency domain (one
FFT, no scipy); the gating is the standard's: 400 ms blocks every 100 ms, an
absolute gate at -70 LUFS and a relative one 10 LU under the gated mean. A
signal shorter than one block is one block.

The gain is capped so the normalised peak stays at or under `PEAK_CEILING`: a
quiet asset with one loud transient is not pushed into clipping (the cap is
recorded as `limited`).
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass

import numpy as np

DEFAULT_TARGETS: dict[str, float] = {"SFX": -24.0, "BED": -30.0, "MUSIC": -17.0}
"""LUFS per cue kind; the casting config's `loudness` overrides any of them.

SFX is AGT-1786's -24. BED and MUSIC sit at the median of the Valley's Shadow
ep01 assets Matt had already listened to (beds -26 to -38, organ -15.5 to
-17.6), so normalising evens out the outliers without moving the balance he
accepted; AGT-1786's -32 and -20 would have pulled every bed and every organ
cue several dB down against the dialogue.
"""
PEAK_CEILING = 0.98
SILENT = -70.0
"""The absolute gate: anything at or under it is silence and is never amplified."""

_SHELF = (1681.974450955533, 3.999843853973347, 0.7071752369554196)  # fc, gain dB, Q
_HIGHPASS = (38.13547087602444, 0.5003270373238773)  # fc, Q


def _shelf(rate: int) -> tuple[list[float], list[float]]:
    """The pre-filter high shelf (libebur128's design of the standard's filter, exact at 48 kHz)."""
    fc, gain, q = _SHELF
    k = math.tan(math.pi * fc / rate)
    vh = 10 ** (gain / 20.0)
    vb = vh**0.4996667741545416
    a0 = 1 + k / q + k * k
    return [(vh + vb * k / q + k * k) / a0, 2 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0], [1.0, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0]


def _highpass(rate: int) -> tuple[list[float], list[float]]:
    """The RLB high pass."""
    fc, q = _HIGHPASS
    k = math.tan(math.pi * fc / rate)
    a0 = 1 + k / q + k * k
    return [1.0, -2.0, 1.0], [1.0, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0]


def _response(coeffs: tuple[list[float], list[float]], z: np.ndarray) -> np.ndarray:
    b, a = coeffs
    return (b[0] + b[1] * z + b[2] * z**2) / (a[0] + a[1] * z + a[2] * z**2)


def k_weighted(audio: np.ndarray, rate: int) -> np.ndarray:
    """The K-weighted signal (both stages), through one zero-padded FFT."""
    x = np.asarray(audio, dtype=np.float64).reshape(-1)
    n = len(x)
    if n == 0:
        return x
    size = 1 << int(math.ceil(math.log2(n + rate)))  # a second of padding: the high pass's tail does not wrap onto the start
    spectrum = np.fft.rfft(x, size)
    z = np.exp(-1j * np.pi * np.arange(len(spectrum)) / (len(spectrum) - 1))  # z^-1 at each bin
    spectrum *= _response(_shelf(rate), z) * _response(_highpass(rate), z)
    return np.fft.irfft(spectrum, size)[:n]


def integrated_lufs(audio: np.ndarray, rate: int) -> float:
    """BS.1770-4 integrated loudness of a mono signal, in LUFS (`SILENT` or lower for silence)."""
    y = k_weighted(audio, rate)
    if len(y) == 0:
        return float("-inf")
    block, hop = int(round(0.4 * rate)), int(round(0.1 * rate))
    if len(y) <= block:
        powers = np.array([float(np.mean(y**2))])
    else:
        squares = np.concatenate([[0.0], np.cumsum(y**2)])
        starts = np.arange(0, len(y) - block + 1, hop)
        powers = (squares[starts + block] - squares[starts]) / block
    with np.errstate(divide="ignore"):
        loudness = -0.691 + 10 * np.log10(powers)
    gated = powers[loudness > SILENT]
    if gated.size == 0:
        return float("-inf")
    relative = -0.691 + 10 * math.log10(float(np.mean(gated))) - 10.0
    kept = powers[(loudness > SILENT) & (loudness > relative)]
    if kept.size == 0:
        return float("-inf")
    return round(-0.691 + 10 * math.log10(float(np.mean(kept))), 3)


@dataclass(frozen=True)
class Normalisation:
    lufs: float
    target: float
    gain_db: float
    limited: bool

    def as_body(self) -> dict[str, object]:
        return {"lufs": self.lufs, "target": self.target, "gain_db": self.gain_db, "limited": self.limited}


def normalisation(lufs: float, peak: float, target: float) -> Normalisation:
    """The gain that puts an asset measured at `lufs` on `target`, capped so its `peak` stays under `PEAK_CEILING`."""
    if not math.isfinite(lufs) or lufs <= SILENT:
        return Normalisation(lufs=lufs if math.isfinite(lufs) else SILENT, target=target, gain_db=0.0, limited=False)
    gain_db = target - lufs
    limited = False
    if peak > 0:
        ceiling_db = 20 * math.log10(PEAK_CEILING / peak)
        if gain_db > ceiling_db:
            gain_db, limited = ceiling_db, True
    return Normalisation(lufs=lufs, target=target, gain_db=round(gain_db, 4), limited=limited)


def targets_from(config: Mapping[str, object] | None) -> dict[str, float]:
    """The per-kind targets: the defaults, with the config's `loudness` numbers over them."""
    out = dict(DEFAULT_TARGETS)
    for kind, value in (config or {}).items():
        if kind in out and isinstance(value, (int, float)) and not isinstance(value, bool):
            out[kind] = float(value)
    return out
