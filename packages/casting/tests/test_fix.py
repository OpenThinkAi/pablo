"""`fix` end to end over a recording fake engine, fake scorers and a fake mixer (AGT-1685). Model-free.

Every script, card and voice here is invented; nothing reads a real vault.
"""

from __future__ import annotations

import io
import json
from collections.abc import Callable
from pathlib import Path

import pytest
from test_mix import seams
from test_perform import Factory, fake_scorers, go, make_card

from pablo_casting.binding import bind
from pablo_casting.cli import run
from pablo_casting.engines import DIA, TURBO, Pass, PassLine, VoiceRef, adapt, normalise_reasons, retake_pace
from pablo_casting.fix import FixRequest, fix, flags_done_path
from pablo_casting.manifest import episode_dir, flags_path, read_version, versions
from pablo_casting.takes import read_take

LINES = 60
SCRIPT = (
    'CAST: MAVIS=f "forties, warm, quick", OTTO=m "sixties, gruff"\n'
    "[SFX: a door creaks]\n"
    + "".join(f"{'MAVIS' if k % 2 == 0 else 'OTTO'}: Invented line number {k} of the harbour show.\n" for k in range(LINES))
)


@pytest.fixture
def episode(tmp_path: Path) -> tuple[Path, Path]:
    work = tmp_path / "work"
    episodes = work / "outputs" / "radio" / "episodes"
    episodes.mkdir(parents=True)
    (episodes / "01-the-harbour-light.md").write_text(SCRIPT, encoding="utf-8")
    library = tmp_path / "library"
    make_card(library, "mavis")
    make_card(library, "otto")
    bind(work, library / "voices", "MAVIS", "mavis")
    bind(work, library / "voices", "OTTO", "otto")
    return work, library


def performed_and_mixed(work: Path, library: Path, cues: Path) -> None:
    body, code, _, _ = go(work, library, Factory(wps=(3.0,)))
    assert code == 0 and body["lines"] == LINES, body
    mixer, _ = seams()
    (mix_body, mix_code), _ = run(["mix", "--work", str(work), "--episode", "1", "--cues", str(cues)], {}, mixer=mixer)
    assert mix_code == 0, mix_body


def flag(work: Path, *flags: tuple[int, str | None], episode: int = 1) -> list[str]:
    path = flags_path(work)
    raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"flags": []}
    ids = []
    for line, reason in flags:
        flag_id = f"f-player-{episode}-{line}-{len(raw['flags'])}"
        ids.append(flag_id)
        raw["flags"].append({"id": flag_id, "episode": episode, "line": line, "reason": reason, "by": "player", "at": "2026-10-11T00:00:00.000Z"})
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(raw, indent=2), encoding="utf-8")
    return ids


def do_fix(
    work: Path,
    library: Path,
    cues: Path,
    factory: Factory | None = None,
    *,
    mixer: Callable[[int], tuple[dict[str, object], int]] | None = None,
    use_mixer: bool = True,
):
    s, _ = seams()
    from pablo_casting.mix import cmd_mix

    remix = mixer or (lambda version: cmd_mix(work, "1", version, str(cues), None, None, s))
    err = io.StringIO()
    return fix(
        FixRequest(work=work, episode=1, voices_dir=library / "voices"),
        env={},
        engine_factory=factory or Factory(wps=(3.0,)),
        scorer_factory=lambda: fake_scorers(),
        mixer=remix if use_mixer else None,
        err=err,
    )


# AC1 -------------------------------------------------------------------------


def test_two_flagged_lines_of_sixty_change_and_nothing_else_does(episode: tuple[Path, Path], tmp_path: Path) -> None:
    work, library = episode
    cues = tmp_path / "cues"
    performed_and_mixed(work, library, cues)
    v1 = read_version(work, 1, 1)
    v1_audio = (episode_dir(work, 1) / "ep01.v1.m4a").read_bytes()
    flag(work, (7, "flat"), (41, "wrong voice"))

    factory = Factory(wps=(3.0,))
    body, code = do_fix(work, library, cues, factory)
    assert code == 0, body
    assert body["changedLines"] == [7, 41] and body["version"] == 2 and body["mixed"] is True
    v2 = read_version(work, 1, 2)
    assert v2["parent"] == 1 and v2["changed_lines"] == [7, 41]
    old = {line["i"]: line["take"] for line in v1["lines"]}
    new = {line["i"]: line["take"] for line in v2["lines"]}
    assert len(new) == LINES
    assert [i for i in new if new[i] != old[i]] == [7, 41]
    assert all(read_take(work, new[i]) is not None for i in new)
    # Only two lines reached the engine, one pass each (both first attempts passed).
    assert len(factory.engine.calls) == 2  # type: ignore[union-attr]
    # The remix: v2 has audio, the link moved, v1's audio is byte-identical.
    root = episode_dir(work, 1)
    assert v2["audio"] == "ep01.v2.m4a" and (root / "ep01.v2.m4a").is_file()
    assert (root / "ep01.m4a").resolve() == (root / "ep01.v2.m4a").resolve()
    assert (root / "ep01.v1.m4a").read_bytes() == v1_audio
    assert all("start" in line for line in v2["lines"])
    # The pace policy is perform's: a retake read inside the role's band is not stretched.
    assert [v2["lines"][i]["stretch"] for i in (7, 41)] == [1.0, 1.0]


# AC2 -------------------------------------------------------------------------


def test_flags_with_their_reasons_are_recorded_and_moved_to_done(episode: tuple[Path, Path], tmp_path: Path) -> None:
    work, library = episode
    cues = tmp_path / "cues"
    performed_and_mixed(work, library, cues)
    ids = flag(work, (7, "flat"), (41, "wrong voice"))
    other = flag(work, (3, "clipped"), episode=2)
    body, code = do_fix(work, library, cues)
    assert code == 0, body
    v2 = read_version(work, 1, 2)
    assert [(f["id"], f["line"], f["reason"], f["by"]) for f in v2["flags_applied"]] == [(ids[0], 7, "flat", "player"), (ids[1], 41, "wrong voice", "player")]
    by_line = {line["i"]: line for line in v2["lines"]}
    assert by_line[7]["fix"]["reasons"] == ["flat"] and by_line[7]["fix"]["flags"] == [ids[0]]
    assert by_line[7]["fix"]["replaced_take"] == read_version(work, 1, 1)["lines"][7]["take"]
    # flags.json keeps only the other episode's flag; flags-done.json holds ours with the version.
    assert [f["id"] for f in json.loads(flags_path(work).read_text())["flags"]] == other
    done = json.loads(flags_done_path(work).read_text())["flags"]
    assert [(f["id"], f["fixed_in"], f["reason"]) for f in done] == [(ids[0], 2, "flat"), (ids[1], 2, "wrong voice")]
    assert all(f["fixed_at"] for f in done)


def test_reasons_bump_the_adapter_and_the_attempts_start_past_the_old_ones(episode: tuple[Path, Path], tmp_path: Path) -> None:
    work, library = episode
    cues = tmp_path / "cues"
    performed_and_mixed(work, library, cues)
    flag(work, (7, "flat"), (41, "wrong voice"), (12, "rushed"), (20, "clipped"))
    factory = Factory(wps=(3.0,))
    body, code = do_fix(work, library, cues, factory)
    assert code == 0, body
    calls = {call["inputs"].lines[0].text.split()[3]: call["inputs"] for call in factory.engine.calls}  # type: ignore[union-attr]
    assert calls["7"].params["temperature"] == 0.95 and calls["7"].params["retake"] == "flat"
    assert calls["41"].params["temperature"] == 0.65 and calls["41"].params["retake"] == "wrong voice"
    assert calls["12"].params["temperature"] == 0.8 and calls["12"].direction.pace == "slow"
    assert calls["20"].params["temperature"] == 0.8 and calls["20"].params["retake"] == "clipped"
    v1, v2 = read_version(work, 1, 1), read_version(work, 1, 2)
    for i in (7, 41, 12, 20):
        assert v2["lines"][i]["attempt"] >= v1["lines"][i]["attempts"]  # new attempt numbers, so new derived seeds
        assert v2["lines"][i]["take"] != v1["lines"][i]["take"]
    # `rushed` slowed the pace target by the slow multiplier (0.85 of the card's 2.8 w/s).
    assert v2["lines"][12]["pace"]["target_wps"] == round(2.8 * 0.85, 3)
    assert v1["lines"][12]["pace"]["target_wps"] == 2.8
    assert v2["changed_lines"] == [7, 12, 20, 41]


def test_two_flags_on_one_line_are_one_retake_with_both_reasons(episode: tuple[Path, Path], tmp_path: Path) -> None:
    work, library = episode
    cues = tmp_path / "cues"
    performed_and_mixed(work, library, cues)
    ids = flag(work, (7, "flat"), (7, "wrong voice"))
    factory = Factory(wps=(3.0,))
    body, code = do_fix(work, library, cues, factory)
    assert code == 0, body
    assert len(factory.engine.calls) == 1  # type: ignore[union-attr]
    params = factory.engine.calls[0]["inputs"].params  # type: ignore[union-attr]
    assert params["temperature"] == 0.65 and params["retake"] == "flat+wrong voice"  # the voice wins
    v2 = read_version(work, 1, 2)
    assert [f["id"] for f in v2["flags_applied"]] == ids and v2["changed_lines"] == [7]


def test_a_second_fix_of_the_same_line_is_a_third_version_with_new_attempts(episode: tuple[Path, Path], tmp_path: Path) -> None:
    work, library = episode
    cues = tmp_path / "cues"
    performed_and_mixed(work, library, cues)
    flag(work, (7, "other"))
    assert do_fix(work, library, cues)[1] == 0
    flag(work, (7, "other"))
    body, code = do_fix(work, library, cues)
    assert code == 0, body
    assert versions(work, 1) == [1, 2, 3]
    takes = [read_version(work, 1, v)["lines"][7]["take"] for v in (1, 2, 3)]
    assert len(set(takes)) == 3
    attempts = [read_version(work, 1, v)["lines"][7]["attempts"] for v in (1, 2, 3)]
    assert attempts == sorted(set(attempts))  # the count only grows


def test_a_retake_that_still_fails_is_flagged_again_automatically(episode: tuple[Path, Path], tmp_path: Path) -> None:
    work, library = episode
    cues = tmp_path / "cues"
    performed_and_mixed(work, library, cues)
    flag(work, (7, "flat"))
    body, code = do_fix(work, library, cues, Factory(wps=(5.0,)))  # too fast to ever fit the pace range
    assert code == 0, body
    assert body["bestOfFailed"] == 1 and len(body["flags"]) == 1  # type: ignore[arg-type]
    open_flags = json.loads(flags_path(work).read_text())["flags"]
    assert [(f["line"], f["by"]) for f in open_flags] == [(7, "auto")]


# AC3 -------------------------------------------------------------------------


def test_no_open_flags_is_a_refusal_naming_the_episode(episode: tuple[Path, Path], tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    work, library = episode
    cues = tmp_path / "cues"
    performed_and_mixed(work, library, cues)
    before = sorted(p.name for p in episode_dir(work, 1).iterdir())
    for flagged_elsewhere in (False, True):
        if flagged_elsewhere:
            flag(work, (3, "flat"), episode=2)
        body, code = do_fix(work, library, cues)
        assert code == 2 and body["ok"] is False and "episode 1 has no open flags" in str(body["message"])
    assert versions(work, 1) == [1] and sorted(p.name for p in episode_dir(work, 1).iterdir()) == before
    (cli_body, cli_code), _ = run(["fix", "--work", str(work), "--episode", "1", "--library", str(library), "--cues", str(cues), "--json"], {}, scorers=fake_scorers, engines=Factory(wps=(3.0,)), mixer=seams()[0])
    assert cli_code == 2 and "episode 1" in str(cli_body["message"])


def test_an_episode_never_performed_is_a_refusal(episode: tuple[Path, Path], tmp_path: Path) -> None:
    work, library = episode
    body, code = do_fix(work, library, tmp_path / "cues")
    assert code == 2 and "pablo perform --episode 1" in str(body["message"])


# the command line ----------------------------------------------------------------


def test_the_command_line_fixes_and_remixes(episode: tuple[Path, Path], tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    work, library = episode
    cues = tmp_path / "cues"
    performed_and_mixed(work, library, cues)
    flag(work, (7, "flat"), (41, "flat"))
    factory = Factory(wps=(3.0,))
    (body, code), wants_json = run(
        ["fix", "--work", str(work), "--episode", "1", "--library", str(library), "--cues", str(cues), "--json-lines", "--json"],
        {},
        scorers=fake_scorers,
        engines=factory,
        mixer=seams()[0],
    )
    assert (code, wants_json, body["ok"], body["changedLines"]) == (0, True, True, [7, 41]), body
    assert str(body["audio"]).endswith("ep01.v2.m4a") and body["mixed"] is True
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [e["event"] for e in events] == ["start", "line", "line", "done"] and [e["i"] for e in events if e["event"] == "line"] == [7, 41]


# refusals that write nothing -----------------------------------------------------------


def test_a_flag_pointing_outside_the_version_or_without_an_id_is_refused(episode: tuple[Path, Path], tmp_path: Path) -> None:
    work, library = episode
    cues = tmp_path / "cues"
    performed_and_mixed(work, library, cues)
    flag(work, (LINES, "flat"))
    body, code = do_fix(work, library, cues)
    assert code == 2 and "0-59" in str(body["message"])
    flags_path(work).write_text(json.dumps({"flags": [{"episode": 1, "line": 3}]}), encoding="utf-8")
    body, code = do_fix(work, library, cues)
    assert code == 2 and "no id" in str(body["message"])
    assert versions(work, 1) == [1]


def test_an_unflagged_line_that_no_longer_matches_the_script_is_refused(episode: tuple[Path, Path], tmp_path: Path) -> None:
    work, library = episode
    cues = tmp_path / "cues"
    performed_and_mixed(work, library, cues)
    script = next((work / "outputs" / "radio" / "episodes").glob("01-*.md"))
    script.write_text(script.read_text(encoding="utf-8").replace("line number 30 ", "line number thirty "), encoding="utf-8")
    flag(work, (7, "flat"))
    body, code = do_fix(work, library, cues)
    assert code == 2 and "30" in str(body["message"]) and versions(work, 1) == [1]
    # Editing the *flagged* line's words is the way to rewrite a line: that is allowed.
    script.write_text(SCRIPT.replace("line number 7 ", "line number seven "), encoding="utf-8")
    factory = Factory(wps=(3.0,))
    body, code = do_fix(work, library, cues, factory)
    assert code == 0, body
    assert read_version(work, 1, 2)["lines"][7]["text"].startswith("Invented line number seven ")
    assert "seven" in factory.engine.calls[0]["text"]  # type: ignore[union-attr]


def test_a_rebound_role_is_refused_because_it_changes_unflagged_lines(episode: tuple[Path, Path], tmp_path: Path) -> None:
    work, library = episode
    cues = tmp_path / "cues"
    performed_and_mixed(work, library, cues)
    make_card(library, "fenn")
    bind(work, library / "voices", "OTTO", "fenn")
    flag(work, (7, "wrong voice"))
    body, code = do_fix(work, library, cues)
    assert code == 2 and "cast changed" in str(body["message"]) and versions(work, 1) == [1]


def test_a_script_with_a_different_number_of_lines_is_refused(episode: tuple[Path, Path], tmp_path: Path) -> None:
    work, library = episode
    cues = tmp_path / "cues"
    performed_and_mixed(work, library, cues)
    script = next((work / "outputs" / "radio" / "episodes").glob("01-*.md"))
    script.write_text(script.read_text(encoding="utf-8") + "MAVIS: One more.\n", encoding="utf-8")
    flag(work, (7, "flat"))
    body, code = do_fix(work, library, cues)
    assert code == 2 and "61 spoken lines" in str(body["message"])


# the remix ------------------------------------------------------------------------


def test_a_failed_remix_leaves_the_version_written_and_says_how_to_finish(episode: tuple[Path, Path], tmp_path: Path) -> None:
    work, library = episode
    cues = tmp_path / "cues"
    performed_and_mixed(work, library, cues)
    flag(work, (7, "flat"))
    body, code = do_fix(work, library, cues, mixer=lambda version: ({"ok": False, "code": 2, "message": "sox is not installed"}, 2))
    assert code == 2 and body["ok"] is False and "pablo mix --episode 1" in str(body["message"]) and body["version"] == 2
    assert read_version(work, 1, 2)["audio"] is None
    assert json.loads(flags_path(work).read_text())["flags"] == []  # moved: v2 is where they landed


def test_without_a_mixer_the_version_is_written_unmixed(episode: tuple[Path, Path], tmp_path: Path) -> None:
    work, library = episode
    cues = tmp_path / "cues"
    performed_and_mixed(work, library, cues)
    flag(work, (7, "flat"))
    body, code = do_fix(work, library, cues, use_mixer=False)
    assert code == 0 and body["mixed"] is False and read_version(work, 1, 2)["audio"] is None


# a Dia pass would carry unflagged lines along; a fix re-records the flagged line alone ---------


def test_a_dia_episode_is_fixed_one_line_to_a_take(episode: tuple[Path, Path], tmp_path: Path) -> None:
    work, library = episode
    cues = tmp_path / "cues"
    body, code, _, _ = go(work, library, Factory(wps=(3.0,)), engine=DIA.name)
    assert code == 0, body
    v1 = read_version(work, 1, 1)
    assert len({line["take"] for line in v1["lines"]}) < LINES  # lines share takes
    # Pick a line that shares its take; its pass-mates must stay on the old take.
    shared = next(line["i"] for line in v1["lines"] if sum(1 for other in v1["lines"] if other["take"] == line["take"]) > 1)
    flag(work, (shared, "flat"))
    factory = Factory(wps=(3.0,))
    body, code = do_fix(work, library, cues, factory, use_mixer=False)
    assert code == 0, body
    assert read_version(work, 1, 2)["changed_lines"] == [shared]
    assert len(factory.engine.calls) == 1 and len(factory.engine.calls[0]["inputs"].lines) == 1  # type: ignore[union-attr]


# the adapter ----------------------------------------------------------------------------


VOICE = VoiceRef(card_hash="h" * 64, slug="mavis", reference=Path("ref.flac"), transcript="x", seconds=24.0)


def test_the_adapter_changes_nothing_without_reasons_and_documents_what_each_reason_bumps() -> None:
    one = Pass((PassLine(0, "MAVIS", "Hello."),))
    plain = adapt(TURBO, one, {"MAVIS": VOICE}, None, None)
    assert plain == adapt(TURBO, one, {"MAVIS": VOICE}, None, None, ())  # existing keys stay as they were
    assert plain["temperature"] == 0.8 and "retake" not in plain
    assert adapt(TURBO, one, {"MAVIS": VOICE}, None, None, ("flat",))["temperature"] == 0.95
    assert adapt(TURBO, one, {"MAVIS": VOICE}, None, None, ("wrong voice",))["temperature"] == 0.65
    assert adapt(TURBO, one, {"MAVIS": VOICE}, None, None, ("rushed",))["temperature"] == 0.8
    assert adapt(DIA, one, {"MAVIS": VOICE}, None, None, ("flat",))["temperature"] == 1.25
    assert normalise_reasons(["Flat", "wrong  VOICE", "best of 4 failed: wer", None, "flat"]) == ("flat", "wrong voice")
    assert [retake_pace(p, ("rushed",)) for p in (None, "quick", "slow")] == ["slow", None, "slow"]
    assert retake_pace("quick", ("flat",)) == "quick"
