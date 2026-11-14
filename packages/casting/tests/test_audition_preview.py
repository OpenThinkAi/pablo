"""`audition --preview` (AGT-2298): candidates read the work's own text. Model-free.

The fake designer renders the candidates and the recording engine stands in for the performance engine. Every script,
card and voice here is invented; nothing reads a real vault.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from pathlib import Path

import pytest
from test_perform import Factory, make_card

from pablo_casting.cli import run
from pablo_casting.config import CastingConfig
from pablo_casting.fakes import fake_toolkit
from pablo_casting.library import card_hash
from pablo_casting.passage import EXPOSITORY, PASSAGE_ID, passage_by_sha
from pablo_casting.receipts import receipts_path
from pablo_casting.toolkit import Toolkit

READING = """---
output: narrated
unit: 1
---
CAST: NARRATOR="the narrator, reading the prose"

NARRATOR: The harbour town grew where the river met the sea.

NARRATOR: Its mills needed a steady current, and its market needed a landing.

NARRATOR: By 1850 the population had doubled twice.
"""

ENV_BASE = {"USER": "tester"}


@pytest.fixture
def env(tmp_path: Path) -> dict[str, str]:
    return {**ENV_BASE, "HOME": str(tmp_path / "home"), "XDG_CONFIG_HOME": str(tmp_path / "config"), "HF_HUB_CACHE": str(tmp_path / "hf")}


@pytest.fixture
def setup(tmp_path: Path, env: dict[str, str]) -> tuple[Path, Path]:
    work = tmp_path / "work"
    readings = work / "outputs" / "narrated" / "readings"
    readings.mkdir(parents=True)
    (readings / "01-the-harbour.md").write_text(READING, encoding="utf-8")
    library = tmp_path / "library"
    library.mkdir()
    return work, library


def toolkits(env: Mapping[str, str], config: CastingConfig) -> Toolkit:
    return fake_toolkit()


def audition(work: Path, library: Path, env: dict[str, str], n: int = 2) -> None:
    (body, code), _ = run(
        ["audition", "--role", "NARRATOR", "--describe", "an older woman, warm, measured", "--seed", "5", "-n", str(n), "--library", str(library), "--work", str(work), "--json"],
        env,
        toolkits=toolkits,
    )
    assert code == 0, body


def preview(work: Path, library: Path, env: dict[str, str], factory: Factory, *rest: str) -> tuple[dict[str, object], int]:
    (body, code), _ = run(["audition", "--preview", "--library", str(library), "--work", str(work), "--json", *rest], env, engines=factory)
    return body, code


def test_each_candidate_reads_the_units_own_lines(setup: tuple[Path, Path], env: dict[str, str]) -> None:
    work, library = setup
    audition(work, library, env)
    factory = Factory(wps=(3.0,))
    body, code = preview(work, library, env, factory, "--role", "NARRATOR", "--output", "narrated", "--episode", "1")
    assert code == 0, body
    files = [Path(str(p["file"])) for p in body["previews"]]  # type: ignore[union-attr]
    assert [f.name for f in files] == ["candidate-1.u1-l0-2.wav", "candidate-2.u1-l0-2.wav"]
    assert all(f.is_file() and f.stat().st_size > 44 and f.parent.name == "previews" for f in files)
    assert body["text"]["source"] == "work" and body["text"]["lines"] == [0, 1, 2]  # type: ignore[index]
    assert factory.engine is not None and len(factory.engine.calls) == 2
    spoken = str(factory.engine.calls[0]["text"])
    assert "harbour town grew" in spoken and "doubled twice" in spoken and "stove" not in spoken


def test_lines_range_selects_a_slice(setup: tuple[Path, Path], env: dict[str, str]) -> None:
    work, library = setup
    audition(work, library, env, n=1)
    factory = Factory()
    body, code = preview(work, library, env, factory, "--role", "NARRATOR", "--output", "narrated", "--episode", "1", "--lines", "1-1")
    assert code == 0, body
    assert body["text"]["lines"] == [1]  # type: ignore[index]
    assert factory.engine is not None
    text = str(factory.engine.calls[0]["text"])
    assert "steady current" in text and "harbour town" not in text
    body, code = preview(work, library, env, Factory(), "--role", "NARRATOR", "--output", "narrated", "--episode", "1", "--lines", "9-12")
    assert code == 2 and "none of" in str(body["message"])


def test_narrator_without_a_unit_defaults_to_the_expository_passage(setup: tuple[Path, Path], env: dict[str, str]) -> None:
    work, library = setup
    audition(work, library, env, n=1)
    factory = Factory()
    body, code = preview(work, library, env, factory, "--role", "NARRATOR")
    assert code == 0, body
    assert body["text"]["source"] == "expository"  # type: ignore[index]
    assert factory.engine is not None
    text = str(factory.engine.calls[0]["text"])
    assert "Most towns grew up beside water" in text and "!" not in EXPOSITORY and "!" not in text
    # Another role keeps the fixed passage, and the flag overrides either default.
    audition_other = preview(work, library, env, Factory(), "--role", "NARRATOR", "--passage", "fixed")[0]
    assert audition_other["text"]["source"] == "fixed"  # type: ignore[index]


def test_a_library_voice_can_be_read_too_and_retired_is_refused(setup: tuple[Path, Path], env: dict[str, str]) -> None:
    work, library = setup
    make_card(library, "fenn")
    factory = Factory()
    body, code = preview(work, library, env, factory, "--voice", "fenn", "--output", "narrated", "--episode", "1")
    assert code == 0, body
    assert [p["voice"] for p in body["previews"]] == ["fenn"]  # type: ignore[union-attr]
    assert factory.engine is not None and set(factory.engine.calls[0]["voices"]) == {card_hash(json.loads((library / "voices" / "fenn" / "card.json").read_text()))}
    card_path = library / "voices" / "fenn" / "card.json"
    card = json.loads(card_path.read_text())
    card_path.write_text(json.dumps({**card, "retired": {"at": "2026-01-01", "reason": "x"}}))
    body, code = preview(work, library, env, Factory(), "--voice", "fenn")
    assert code == 2 and "retired" in str(body["message"])


def test_provenance_is_untouched_and_the_passage_stays_the_fixed_one(setup: tuple[Path, Path], env: dict[str, str]) -> None:
    work, library = setup
    audition(work, library, env, n=1)
    folder = library / "voices" / "narrator" / "auditions"
    before = {p.name: p.read_bytes() for p in folder.iterdir() if p.is_file()}
    body, code = preview(work, library, env, Factory(), "--role", "NARRATOR", "--output", "narrated", "--episode", "1")
    assert code == 0, body
    assert {p.name: p.read_bytes() for p in folder.iterdir() if p.is_file()} == before
    record = json.loads((folder / "1.json").read_text())
    assert record["passage"]["id"] == PASSAGE_ID and passage_by_sha(record["passage"]["sha256"]) is not None
    assert passage_by_sha(hashlib.sha256(EXPOSITORY.encode()).hexdigest()) is None
    assert not (work / "outputs" / "narrated" / "casting" / "takes").exists()
    rows = [json.loads(line) for line in receipts_path(work).read_text().splitlines()]
    assert [r["intent"] for r in rows if r["intent"] == "preview"] == ["preview"]
    # `voices list` still counts one candidate: the previews folder is not a candidate.
    (listed, code), _ = run(["voices", "list", "--library", str(library), "--json"], env)
    assert code == 0, listed


def test_refusals_name_what_is_missing(setup: tuple[Path, Path], env: dict[str, str]) -> None:
    work, library = setup
    body, code = preview(work, library, env, Factory())
    assert code == 2 and "--role" in str(body["message"])
    body, code = preview(work, library, env, Factory(), "--role", "NARRATOR")
    assert code == 2 and "no audition candidates" in str(body["message"])
    audition(work, library, env, n=1)
    body, code = preview(work, library, env, Factory(), "--role", "NARRATOR", "--lines", "0-1")
    assert code == 2 and "--lines needs" in str(body["message"])
    body, code = preview(work, library, env, Factory(), "--role", "NARRATOR", "--candidate", "7")
    assert code == 2 and "no candidate 7" in str(body["message"])
    body, code = preview(work, library, env, Factory(), "--role", "NARRATOR", "--passage", "bogus")
    assert code == 2 and "unknown --passage" in str(body["message"])
    body, code = preview(work, library, env, Factory(), "--role", "NARRATOR", "--passage", "work")
    assert code == 2 and "--unit" in str(body["message"])
