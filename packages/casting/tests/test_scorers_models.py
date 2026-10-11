"""The real scorer stack, by hand on the Studio: `uv sync --extra scorers --extra emotion && uv run pytest -m models -s`.

Excluded from the default run (and from stamp's `casting-test`): it loads every
scorer's weights, downloading them on first use. Point it at a real take:

    PABLO_CASTING_TAKE=/path/take.wav PABLO_CASTING_LINE="the script line" \\
        uv run pytest -m models -s tests/test_scorers_models.py

It prints the scores and each scorer's wall seconds, which is how the
ticket's timing criterion ("a 10-second take scores in under 10 s on the
Studio") is recorded, not asserted.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from pablo_casting.gate_command import audio_seconds, run_scorers
from pablo_casting.scorers import SCORERS, Take, real_scorers

pytestmark = pytest.mark.models


@pytest.fixture
def take() -> Take:
    audio = os.environ.get("PABLO_CASTING_TAKE")
    line = os.environ.get("PABLO_CASTING_LINE")
    if not audio or not line:
        pytest.skip("set PABLO_CASTING_TAKE and PABLO_CASTING_LINE to a real take and its script line")
    path = Path(audio)
    return Take(audio=path, line=line, seconds=audio_seconds(path), card_reference=path)


def test_the_real_stack_scores_a_take(take: Take) -> None:  # pragma: no cover - hand-run
    scores, ran = run_scorers(take, real_scorers())
    print(json.dumps({"seconds": take.seconds, "scores": {k: v for k, v in scores.items() if k != "timings"}, "scorers": ran}, indent=2))
    for info in SCORERS:
        if info.soft and any(r.get("skipped") for r in ran if r["name"] == info.name):
            continue
        for measure in info.measures:
            assert measure in scores, measure
    # The take against itself as the card reference: identity must be near 1.
    assert scores["sim_card"] > 0.95
