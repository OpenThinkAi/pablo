"""The calibration rule on synthetic score sets (AGT-1682): 5th percentile vs midpoint, stricter wins."""

from __future__ import annotations

import random
import statistics

import pytest

from pablo_casting.calibrate import FEW, calibrate, fit_threshold, percentile


def test_percentile_interpolates_like_numpy() -> None:
    values = [float(v) for v in range(1, 11)]
    # numpy.percentile(range(1, 11), 5) == 1.45; (…, 95) == 9.55; (…, 50) == 5.5
    assert percentile(values, 5) == pytest.approx(1.45)
    assert percentile(values, 95) == pytest.approx(9.55)
    assert percentile(values, 50) == pytest.approx(5.5)
    assert percentile([3.0], 5) == 3.0


def test_a_well_separated_min_score_keeps_the_fifth_percentile() -> None:
    approved = [0.70 + i * 0.005 for i in range(40)]  # 0.700 .. 0.895
    others = [0.20 + i * 0.005 for i in range(40)]  # far below
    fit = fit_threshold("sim_min", "sim_card", "min", approved, others)
    assert fit.chose == "p5"
    assert fit.value == round(percentile(approved, 5), 3)
    assert fit.midpoint == pytest.approx((statistics.median(approved) + statistics.median(others)) / 2)


def test_an_overlapping_min_score_takes_the_stricter_midpoint() -> None:
    approved = [0.50 + i * 0.01 for i in range(30)]  # 0.50 .. 0.79, median 0.645
    others = [0.45 + i * 0.01 for i in range(30)]  # median 0.595
    fit = fit_threshold("sim_min", "sim_card", "min", approved, others)
    assert fit.chose == "midpoint"
    assert fit.value == pytest.approx(0.62, abs=1e-3)
    assert fit.value > percentile(approved, 5)


def test_a_max_score_mirrors_the_rule() -> None:
    approved = [0.0] * 25 + [0.02, 0.03, 0.04, 0.05, 0.06]
    rejected = [0.04, 0.06, 0.08, 0.10, 0.12]
    fit = fit_threshold("wer_max", "wer", "max", approved, rejected)
    p95 = percentile(approved, 95)
    mid = (statistics.median(approved) + statistics.median(rejected)) / 2
    assert fit.value == round(min(p95, mid), 3)
    assert fit.chose == ("midpoint" if mid < p95 else "p95")


def test_when_others_are_not_worse_the_percentile_stands_with_a_note() -> None:
    approved = [0.0] * 30
    others = [0.0] * 30
    fit = fit_threshold("wer_max", "wer", "max", approved, others)
    assert fit.chose == "p95"
    assert fit.midpoint is None
    assert fit.note is not None and "not worse" in fit.note


def test_without_others_the_percentile_stands() -> None:
    fit = fit_threshold("utmos_min", "utmos", "min", [3.9 + i * 0.01 for i in range(30)], [])
    assert fit.chose == "p5"
    assert fit.n_others == 0


def test_few_approved_takes_are_fitted_with_a_warning() -> None:
    fit = fit_threshold("utmos_min", "utmos", "min", [4.0, 4.1, 4.2], [])
    assert fit.note is not None and f"at least {FEW}" in fit.note


def test_inserted_span_is_proposed_as_a_whole_number() -> None:
    fit = fit_threshold("inserted_span_max", "inserted_span", "max", [0, 0, 0, 1, 1, 2] * 5, [])
    assert isinstance(fit.value, int)


@pytest.mark.parametrize("seed", [1, 7, 42, 1682])
def test_every_fit_is_the_stricter_of_the_two_on_random_sets(seed: int) -> None:
    rng = random.Random(seed)
    approved = [
        {"sim_card": rng.gauss(0.70, 0.04), "utmos": rng.gauss(4.0, 0.15), "wer": abs(rng.gauss(0.0, 0.02)), "bak": rng.gauss(4.1, 0.1)}
        for _ in range(60)
    ]
    others = [
        {"sim_card": rng.gauss(0.35, 0.10), "utmos": rng.gauss(3.7, 0.3), "wer": abs(rng.gauss(0.06, 0.04)), "bak": rng.gauss(3.9, 0.2)}
        for _ in range(60)
    ]
    fits = calibrate(approved, others)
    assert set(fits) == {"sim_min", "utmos_min", "wer_max", "bak_min"}
    for key, score, direction in (("sim_min", "sim_card", "min"), ("utmos_min", "utmos", "min"), ("bak_min", "bak", "min"), ("wer_max", "wer", "max")):
        a = [float(r[score]) for r in approved]
        o = [float(r[score]) for r in others]
        mid = (statistics.median(a) + statistics.median(o)) / 2
        if direction == "min":
            expected = max(percentile(a, 5), mid)
        else:
            expected = min(percentile(a, 95), mid)
        assert fits[key].value == pytest.approx(round(expected, 3), abs=1e-9), key


def test_records_without_a_score_are_skipped_and_bad_values_ignored() -> None:
    approved = [{"utmos": 4.0}, {"utmos": "4.2"}, {"utmos": ""}, {"utmos": None}, {"utmos": True}, {"sim_card": 0.7}]
    fits = calibrate(approved, [])
    assert fits["utmos_min"].n_approved == 2
    assert fits["sim_min"].n_approved == 1
