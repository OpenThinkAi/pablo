"""The mixer's Cast panel reads (AGT-2157): `castpanel roles` and `castpanel preview`. Model-free.

Every script, card and voice here is invented; nothing reads a real vault.
"""

from __future__ import annotations

import base64
import io
import json
import wave
from pathlib import Path

import pytest
from test_perform import SCRIPT, Factory, go, make_card

from pablo_casting.binding import bind
from pablo_casting.cli import run
from pablo_casting.receipts import receipts_path


@pytest.fixture
def setup(tmp_path: Path) -> tuple[Path, Path]:
    work = tmp_path / "work"
    episodes = work / "outputs" / "radio" / "episodes"
    episodes.mkdir(parents=True)
    (episodes / "01-the-harbour-light.md").write_text(SCRIPT, encoding="utf-8")
    library = tmp_path / "library"
    make_card(library, "mavis")
    make_card(library, "otto")
    make_card(library, "fenn")
    bind(work, library / "voices", "MAVIS", "mavis")
    return work, library


def castpanel(work: Path, library: Path, *rest: str, engines: Factory | None = None) -> tuple[dict[str, object], int]:
    (body, code), _ = run(["castpanel", *rest, "--work", str(work), "--library", str(library)], {}, engines=engines)
    return body, code


def test_roles_lists_each_role_its_description_binding_and_lines(setup: tuple[Path, Path]) -> None:
    work, library = setup
    body, code = castpanel(work, library, "roles", "--episode", "1")
    assert code == 0, body
    assert body["performed"] is False
    roles = {r["role"]: r for r in body["roles"]}  # type: ignore[union-attr]
    assert list(roles) == ["MAVIS", "OTTO"]
    assert roles["MAVIS"]["description"] == "forties, warm, quick" and roles["MAVIS"]["gender"] == "f"
    assert roles["MAVIS"]["voice"]["slug"] == "mavis" and roles["MAVIS"]["voice"]["state"] == "ok" and roles["MAVIS"]["voice"]["by"] == "manual"
    assert roles["OTTO"]["voice"] is None
    assert [line["i"] for line in roles["MAVIS"]["lines"]] == [0, 2]
    assert [line["i"] for line in roles["OTTO"]["lines"]] == [1, 3]
    assert roles["OTTO"]["lines"][1]["text"] == "And I am always right."
    assert roles["MAVIS"]["stale"] == []


def test_roles_names_the_lines_a_rebind_left_in_the_old_voice(setup: tuple[Path, Path]) -> None:
    work, library = setup
    bind(work, library / "voices", "OTTO", "otto")
    body, code, _, _ = go(work, library, Factory(wps=(3.0,)))
    assert code == 0, body
    bind(work, library / "voices", "OTTO", "fenn")
    body, code = castpanel(work, library, "roles", "--episode", "1")
    assert code == 0, body
    roles = {r["role"]: r for r in body["roles"]}  # type: ignore[union-attr]
    assert body["performed"] is True
    assert roles["OTTO"]["stale"] == [1, 3] and roles["MAVIS"]["stale"] == []


def test_preview_reads_one_line_in_a_library_voice_and_writes_no_take(setup: tuple[Path, Path]) -> None:
    work, library = setup
    factory = Factory(wps=(3.0,))
    body, code = castpanel(work, library, "preview", "--episode", "1", "--line", "3", "--voice", "fenn", engines=factory)
    assert code == 0, body
    assert body["role"] == "OTTO" and body["voice"] == "fenn" and body["text"] == "And I am always right."
    with wave.open(io.BytesIO(base64.b64decode(str(body["b64"])))) as wav:
        assert wav.getframerate() == 24_000 and wav.getnframes() > 0
    assert factory.engine is not None and len(factory.engine.calls) == 1
    assert factory.engine.calls[0]["voices"] == [body["cardHash"]]
    assert not (work / "outputs" / "radio" / "casting" / "takes").exists()
    rows = [json.loads(line) for line in receipts_path(work).read_text(encoding="utf-8").splitlines()]
    assert [r["intent"] for r in rows] == ["preview"] and rows[0]["voice"] == "fenn"


def test_preview_refuses_a_retired_voice_a_missing_line_and_missing_flags(setup: tuple[Path, Path]) -> None:
    work, library = setup
    card = library / "voices" / "fenn" / "card.json"
    data = json.loads(card.read_text(encoding="utf-8"))
    card.write_text(json.dumps({**data, "retired": {"at": "2026-10-01", "by": "author"}}), encoding="utf-8")
    body, code = castpanel(work, library, "preview", "--episode", "1", "--line", "0", "--voice", "fenn", engines=Factory())
    assert code == 2 and "retired" in str(body["message"])
    body, code = castpanel(work, library, "preview", "--episode", "1", "--line", "9", "--voice", "otto", engines=Factory())
    assert code == 2 and "no line 9" in str(body["message"])
    body, code = castpanel(work, library, "preview", "--episode", "1", engines=Factory())
    assert code == 2 and body["missing"] == ["--line", "--voice"]
    body, code = castpanel(work, library, "nope", "--episode", "1")
    assert code == 1


def test_roles_refuses_an_episode_with_no_script(setup: tuple[Path, Path]) -> None:
    work, library = setup
    body, code = castpanel(work, library, "roles", "--episode", "4")
    assert code == 2 and "no script for episode 4" in str(body["message"])
