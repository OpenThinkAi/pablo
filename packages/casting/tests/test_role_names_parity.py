"""The role list the radio output's stage checks read without Python (AGT-1686).

`packages/cli/src/outputs/radio/script.ts` reads a script's role names so `pablo perform`
can refuse an unbound role before anything is provisioned. It must be the same list as
`Script.role_names()`; both test suites read `fixtures/role_names.json`, so neither reader
can drift from the other. Scripts there are invented.

Also the AGT-1694 carry-over: the announcer and the narrator are roles like any other, so
one with no description is reported by `pablo check`.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pablo_casting.script import parse_script

FIXTURE = Path(__file__).parent / "fixtures" / "role_names.json"
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_role_names_match_the_shared_fixture(case: dict[str, object]) -> None:
    assert parse_script(str(case["script"])).role_names() == case["roles"]


def test_an_undescribed_announcer_or_narrator_is_reported() -> None:
    script = parse_script('CAST: ANNOUNCER=m, MAE=f "fifties, dry"\nANNOUNCER: Good evening.\nNARRATOR: The pond froze.\nMAE: Sit.\n')
    assert script.undescribed == ["ANNOUNCER", "NARRATOR"]
