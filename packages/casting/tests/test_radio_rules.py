"""The radio rules template's checks (AGT-1694): directions outside the vocabulary, more than one per line, undescribed roles.

Scripts are invented here; no manuscript text, no model.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from pablo_casting.cli import run

BAD_SCRIPT = """CAST: MAE=f "fifties, dry, unhurried", TOBY=m, ANNOUNCER=m "forties, warm, brisk"

[MUSIC: Theme, a thin organ line]
ANNOUNCER: (warm) Good evening.
MAE: (approaching) Sit down, Toby.
TOBY: (smiling) I would rather stand.
MAE: (dry) (urgent) Then stand quickly.
TOBY: (dryly) Fine.
MAE: (tender) The kettle is on.
"""


@pytest.fixture
def env(tmp_path: Path) -> dict[str, str]:
    return {"HOME": str(tmp_path / "home"), "XDG_CONFIG_HOME": str(tmp_path / "config"), "HF_HUB_CACHE": str(tmp_path / "hf")}


def episode_work(tmp_path: Path, text: str) -> Path:
    work = tmp_path / "vault" / "novels" / "show"
    episodes = work / "outputs" / "radio" / "episodes"
    episodes.mkdir(parents=True)
    (episodes / "01-invented.md").write_text(text, encoding="utf-8")
    return work


def check(env: dict[str, str], work: Path) -> dict[str, object]:
    (body, code), _ = run(["check", "--work", str(work), "--json"], env)
    assert code == 0
    return body


def test_check_reports_bad_directions_and_undescribed_roles_with_lines(env: dict[str, str], tmp_path: Path) -> None:
    body = check(env, episode_work(tmp_path, BAD_SCRIPT))
    # the second parenthetical of line 7 is a stray, so it is listed here too (and as a multiple below)
    assert {(u["line"], u["text"]) for u in body["unknownDirections"]} == {(5, "(approaching)"), (6, "(smiling)"), (7, "(urgent)")}  # type: ignore[union-attr]
    assert [(m["line"], m["text"]) for m in body["offVocabulary"]] == [(8, "(dryly)")]  # type: ignore[union-attr]
    assert body["offVocabulary"][0]["mapped"] == {"dryly": "dry"}  # type: ignore[index]
    assert [(m["line"], m["directions"]) for m in body["multipleDirections"]] == [(7, ["(dry)", "(urgent)"])]  # type: ignore[union-attr]
    assert [r["role"] for r in body["undescribedRoles"]] == ["TOBY"]  # type: ignore[union-attr]


def test_a_clean_described_script_reports_nothing(env: dict[str, str], tmp_path: Path) -> None:
    work = episode_work(
        tmp_path,
        'CAST: MAE=f "fifties, dry", NARRATOR=m "sixties, warm"\nNARRATOR: Evening.\nMAE: (dry, slow) Sit down (sighs) now.\n',
    )
    body = check(env, work)
    assert (body["unknownDirections"], body["offVocabulary"], body["multipleDirections"], body["undescribedRoles"]) == ([], [], [], [])


def test_an_undeclared_speaker_is_undescribed(env: dict[str, str], tmp_path: Path) -> None:
    body = check(env, episode_work(tmp_path, 'CAST: MAE=f "fifties, dry"\nMAE: Hello.\nOTT: Hullo.\n'))
    assert [r["role"] for r in body["undescribedRoles"]] == ["OTT"]  # type: ignore[union-attr]


def test_a_stray_parenthetical_in_the_words_counts_as_a_second_direction(env: dict[str, str], tmp_path: Path) -> None:
    body = check(env, episode_work(tmp_path, 'CAST: MAE=f "fifties, dry"\nMAE: (dry) Sit down (waving) please.\n'))
    assert [(m["line"], m["directions"]) for m in body["multipleDirections"]] == [(2, ["(dry)", "(waving)"])]  # type: ignore[union-attr]
