"""`gate calibrate`: fit each threshold from approved takes and the others.

The design's rule ("Quality gates and thresholds to calibrate"): set each
threshold at the 5th percentile of the approved takes, or the midpoint to the
other distribution, whichever is stricter. Concretely, for a score where
higher is better (`sim_card`, `utmos`, ...):

    p        = 5th percentile of approved            (linear interpolation, numpy's default)
    midpoint = (median(approved) + median(others)) / 2
    value    = max(p, midpoint)                      (the stricter of the two)

and for one where lower is better (`wer`, `inserted_span`) the mirror image:
the 95th percentile, and `min(p, midpoint)`. When `others` is empty, or its
median is not on the worse side of the approved median (the two are not
separated on that score, as WER usually is not between voices), the midpoint
says nothing and the percentile stands; the fit records why.

`others` are the takes Matt did not approve: other voices scored against this
card (for the similarity gates) and rejected takes. Records are score sets,
not audio, so calibrating never loads a model: a directory of JSON files (a
`pablo gate --json` body, a `take.json` with a `gates` or `scores` block, or a
flat object of scores) and/or CSV files (one take per row, `results.csv`).

Pure Python; the default tests drive it with synthetic score sets.
"""

from __future__ import annotations

import csv
import json
import math
import statistics
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

# (threshold key, score key, direction): "min" = higher is better.
FITTED: tuple[tuple[str, str, str], ...] = (
    ("wer_max", "wer", "max"),
    ("inserted_span_max", "inserted_span", "max"),
    ("sim_min", "sim_card", "min"),
    ("centroid_min", "sim_role_centroid", "min"),
    ("utmos_min", "utmos", "min"),
    ("pq_min", "pq", "min"),
    ("bak_min", "bak", "min"),
    ("ovrl_min", "ovrl", "min"),
)

PERCENTILE = 5.0
# Fewer approved takes than this and a fit is reported with a warning (the
# design's C17 calibrates from at least 30 per role).
FEW = 20


class CalibrationRefusal(Exception):
    pass


def percentile(values: Sequence[float], q: float) -> float:
    """The q-th percentile with linear interpolation between closest ranks (numpy's default)."""
    if not values:
        raise ValueError("percentile of no values")
    ordered = sorted(values)
    rank = (len(ordered) - 1) * q / 100.0
    low = math.floor(rank)
    high = math.ceil(rank)
    return ordered[low] + (ordered[high] - ordered[low]) * (rank - low)


@dataclass(frozen=True)
class Fit:
    key: str
    score: str
    direction: str
    n_approved: int
    n_others: int
    percentile: float
    midpoint: float | None
    chose: str
    value: float | int
    note: str | None

    def as_body(self) -> dict[str, object]:
        body: dict[str, object] = {
            "score": self.score,
            "direction": "higher is better" if self.direction == "min" else "lower is better",
            "approved": self.n_approved,
            "others": self.n_others,
            "percentile": round(self.percentile, 4),
            "midpoint": None if self.midpoint is None else round(self.midpoint, 4),
            "chose": self.chose,
            "value": self.value,
        }
        if self.note:
            body["note"] = self.note
        return body


def fit_threshold(key: str, score: str, direction: str, approved: Sequence[float], others: Sequence[float]) -> Fit:
    """One threshold by the design's rule. `approved` must be non-empty."""
    p = percentile(approved, PERCENTILE if direction == "min" else 100.0 - PERCENTILE)
    label = f"p{PERCENTILE:g}" if direction == "min" else f"p{100.0 - PERCENTILE:g}"
    midpoint: float | None = None
    chose, value, note = label, p, None
    if others:
        a, o = statistics.median(approved), statistics.median(others)
        separated = o < a if direction == "min" else o > a
        if separated:
            midpoint = (a + o) / 2
            stricter = midpoint > p if direction == "min" else midpoint < p
            if stricter:
                chose, value = "midpoint", midpoint
        else:
            note = "others are not worse than approved on this score; the percentile stands"
    if len(approved) < FEW:
        note = (note + "; " if note else "") + f"only {len(approved)} approved takes (calibrate from at least {FEW})"
    rounded: float | int = round(value) if key == "inserted_span_max" else round(value, 3)
    return Fit(key, score, direction, len(approved), len(others), p, midpoint, chose, rounded, note)


def calibrate(approved: Sequence[Mapping[str, object]], others: Sequence[Mapping[str, object]]) -> dict[str, Fit]:
    """Fits every threshold whose score the approved records carry."""
    fits: dict[str, Fit] = {}
    for key, score, direction in FITTED:
        a = _column(approved, score)
        if not a:
            continue
        fits[key] = fit_threshold(key, score, direction, a, _column(others, score))
    return fits


def _column(records: Iterable[Mapping[str, object]], score: str) -> list[float]:
    out: list[float] = []
    for record in records:
        value = record.get(score)
        if isinstance(value, bool) or value is None or value == "":
            continue
        try:
            number = float(value)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            continue
        if math.isfinite(number):
            out.append(number)
    return out


def scores_of(obj: object) -> Mapping[str, object] | None:
    if not isinstance(obj, dict):
        return None
    for key in ("scores", "gates"):
        if isinstance(obj.get(key), dict) and any(not isinstance(v, dict) for v in obj[key].values()):
            return obj[key]
    return obj


def read_records(directory: Path) -> list[Mapping[str, object]]:
    """Every score record under `directory` (recursively): JSON objects or CSV rows. Unreadable files refuse."""
    if not directory.is_dir():
        raise CalibrationRefusal(f"{directory} is not a directory")
    records: list[Mapping[str, object]] = []
    for path in sorted(directory.rglob("*")):
        if path.suffix == ".json" and path.is_file():
            try:
                record = scores_of(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError) as failure:
                raise CalibrationRefusal(f"{path} is not valid JSON: {failure}") from failure
            if record is not None:
                records.append(record)
        elif path.suffix == ".csv" and path.is_file():
            try:
                with path.open(newline="", encoding="utf-8") as handle:
                    records.extend(dict(row) for row in csv.DictReader(handle))
            except (OSError, csv.Error) as failure:
                raise CalibrationRefusal(f"{path} is not a readable CSV: {failure}") from failure
    return records
