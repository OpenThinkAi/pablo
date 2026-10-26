"""`fix --line`, `takes line` and `takes choose` (AGT-2155): the mixer's punch list on the Python side. Model-free.

Every script, card and voice here is invented (test_fix's fixture); nothing reads a real vault.
"""

from __future__ import annotations

import json
from pathlib import Path

from test_fix import do_fix, episode, flag, performed_and_mixed  # noqa: F401 -- `episode` is a fixture
from test_mix import seams
from test_perform import Factory, fake_scorers

from pablo_casting.choose import CHOSEN_REASON, choose_take, line_takes
from pablo_casting.cli import run
from pablo_casting.fix import FixRequest, fix, flags_done_path
from pablo_casting.manifest import flags_path, read_version, versions


def fix_line(work: Path, library: Path, cues: Path, line: int):
    s, _ = seams()
    from pablo_casting.mix import cmd_mix

    return fix(
        FixRequest(work=work, episode=1, voices_dir=library / "voices", lines=(line,)),
        env={},
        engine_factory=Factory(wps=(3.0,)),
        scorer_factory=lambda: fake_scorers(),
        mixer=lambda version: cmd_mix(work, "1", version, str(cues), None, None, s),
    )


def open_flags(work: Path) -> list[dict[str, object]]:
    return json.loads(flags_path(work).read_text(encoding="utf-8"))["flags"]


def test_fix_one_line_applies_only_its_flags_and_leaves_the_rest_open(episode: tuple[Path, Path], tmp_path: Path) -> None:  # noqa: F811
    work, library = episode
    cues = tmp_path / "cues"
    performed_and_mixed(work, library, cues)
    flag(work, (7, "flat"), (41, "wrong voice"))
    body, code = fix_line(work, library, cues, 7)
    assert code == 0, body
    assert body["changedLines"] == [7]
    assert [f["line"] for f in open_flags(work)] == [41]
    done = json.loads(flags_done_path(work).read_text(encoding="utf-8"))["flags"]
    assert [f["line"] for f in done] == [7]


def test_fix_a_line_with_no_open_flag_is_a_refusal(episode: tuple[Path, Path], tmp_path: Path) -> None:  # noqa: F811
    work, library = episode
    cues = tmp_path / "cues"
    performed_and_mixed(work, library, cues)
    flag(work, (41, "flat"))
    body, code = fix_line(work, library, cues, 7)
    assert code == 2 and "no open flag on line(s) 7" in str(body["message"])
    assert versions(work, 1) == [1]


def test_retake_compare_and_choose_the_old_take_back(episode: tuple[Path, Path], tmp_path: Path) -> None:  # noqa: F811
    work, library = episode
    cues = tmp_path / "cues"
    performed_and_mixed(work, library, cues)
    original = read_version(work, 1, 1)["lines"][7]["take"]
    flag(work, (7, "flat"), (41, "flat"))
    body, code = fix_line(work, library, cues, 7)
    assert code == 0, body
    retaken = read_version(work, 1, 2)["lines"][7]["take"]
    assert retaken != original

    listed, code = line_takes(work, 1, 7)
    assert code == 0, listed
    takes = listed["takes"]
    assert [t["key"] for t in takes] == [original, retaken]  # type: ignore[union-attr]
    assert [t["current"] for t in takes] == [False, True]  # type: ignore[union-attr]
    assert takes[1]["reasons"] == ["flat"] and takes[0]["versions"] == [1]  # type: ignore[index]

    s, _ = seams()
    from pablo_casting.mix import cmd_mix

    chosen, code = choose_take(work, 1, 7, original[:10], lambda version: cmd_mix(work, "1", version, str(cues), None, None, s))
    assert code == 0, chosen
    assert chosen["take"] == original and chosen["mixed"] is True
    v3 = read_version(work, 1, int(chosen["version"]))  # type: ignore[call-overload]
    assert v3["changed_lines"] == [7] and v3["lines"][7]["take"] == original
    assert v3["lines"][7]["chosen"] == {"from_version": 1, "replaced_take": retaken, "in_version": 2}
    assert v3["flags_applied"][0]["reason"] == CHOSEN_REASON
    # The choice flag is done, the other line's flag is still open, and every other line kept its take.
    assert [f["line"] for f in open_flags(work)] == [41]
    done = json.loads(flags_done_path(work).read_text(encoding="utf-8"))["flags"]
    assert any(f["reason"] == CHOSEN_REASON and f["fixed_in"] == v3["version"] for f in done)
    v2 = read_version(work, 1, 2)
    assert all(a["take"] == b["take"] for a, b in zip(v2["lines"], v3["lines"]) if a["i"] != 7)

    again, code = line_takes(work, 1, 7)
    assert [t["current"] for t in again["takes"]] == [True, False]  # type: ignore[union-attr]
    assert again["takes"][0]["versions"] == [1, 3]  # type: ignore[index]


def test_choosing_the_current_take_or_one_the_line_never_had_writes_nothing(episode: tuple[Path, Path], tmp_path: Path) -> None:  # noqa: F811
    work, library = episode
    cues = tmp_path / "cues"
    performed_and_mixed(work, library, cues)
    current = read_version(work, 1, 1)["lines"][7]["take"]
    other = read_version(work, 1, 1)["lines"][8]["take"]
    body, code = choose_take(work, 1, 7, current, None)
    assert code == 2 and "nothing to choose" in str(body["message"])
    body, code = choose_take(work, 1, 7, other, None)
    assert code == 2 and "never had take" in str(body["message"])
    assert versions(work, 1) == [1]
    assert not flags_path(work).exists() or open_flags(work) == []


def test_the_command_line_lists_and_chooses(episode: tuple[Path, Path], tmp_path: Path) -> None:  # noqa: F811
    work, library = episode
    cues = tmp_path / "cues"
    performed_and_mixed(work, library, cues)
    original = read_version(work, 1, 1)["lines"][3]["take"]
    flag(work, (3, "rushed"))
    (body, code), _ = run(
        ["fix", "--work", str(work), "--episode", "1", "--line", "3", "--library", str(library), "--cues", str(cues), "--json"],
        {},
        scorers=fake_scorers,
        engines=Factory(wps=(3.0,)),
        mixer=seams()[0],
    )
    assert code == 0 and body["changedLines"] == [3], body
    (listed, code), _ = run(["takes", "line", "--work", str(work), "--episode", "1", "--line", "3", "--json"], {})
    assert code == 0 and len(listed["takes"]) == 2, listed
    (chosen, code), _ = run(
        ["takes", "choose", original, "--work", str(work), "--episode", "1", "--line", "3", "--cues", str(cues), "--json"], {}, mixer=seams()[0]
    )
    assert code == 0 and chosen["version"] == 3 and chosen["mixed"] is True, chosen
    (missing, code), _ = run(["takes", "line", "--work", str(work), "--episode", "1", "--json"], {})
    assert code == 2 and missing["missing"] == ["--line"]
