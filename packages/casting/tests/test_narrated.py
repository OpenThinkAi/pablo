"""The narrated output performed and mixed (AGT-2158, D-7) over the fake engine, scorers and mixer. Model-free.

A narrated unit is a reading of another output's prose (`outputs/narrated/readings/NN-*.md`, AGT-2137): a
`CAST:` line naming the narrator, then `NARRATOR:` lines (and a character's line only when the reading gave
dialogue to one). `--output narrated` (or `$PABLO_CASTING_OUTPUT`) points every command at that output's
scripts and its own casting state, `outputs/narrated/casting/`, beside the radio output's and never in it.
Every script, card and voice here is invented; nothing reads a real vault.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from test_mix import seams
from test_perform import Factory, fake_scorers, make_card

from pablo_casting import outputs
from pablo_casting.cli import run
from pablo_casting.manifest import read_version
from pablo_casting.receipts import receipts_path

# What `narrate.ts` writes for a two-paragraph unit read by one narrator.
READING = """---
output: narrated
unit: 1
---
CAST: NARRATOR="the narrator, reading the prose"

NARRATOR: The fog came in over the harbour before the lamps were lit.

NARRATOR: Mavis counted the boats twice and wrote the number down.
"""

# A reading made with `--voices characters`: the narrator and one character.
CHARACTERS = """CAST: NARRATOR="the narrator, reading the prose", MAVIS="Mavis, speaking their dialogue"

NARRATOR: Mavis looked at the water.
MAVIS: Mind the step.
NARRATOR: she said, and went in.
"""

RADIO = """CAST: OTTO=m "sixties, gruff"
OTTO: An invented radio line that must stay radio's.
"""


def card_with_traits(library: Path, slug: str, traits: dict[str, object]) -> None:
    make_card(library, slug)
    path = library / "voices" / slug / "card.json"
    card = json.loads(path.read_text(encoding="utf-8"))
    path.write_text(json.dumps({**card, "traits": traits}, indent=2) + "\n", encoding="utf-8")


@pytest.fixture
def narrated(tmp_path: Path) -> tuple[Path, Path]:
    work = tmp_path / "work"
    readings = work / "outputs" / "narrated" / "readings"
    readings.mkdir(parents=True)
    (readings / "01-the-harbour.md").write_text(READING, encoding="utf-8")
    (readings / "02-the-step.md").write_text(CHARACTERS, encoding="utf-8")
    episodes = work / "outputs" / "radio" / "episodes"
    episodes.mkdir(parents=True)
    (episodes / "01-the-harbour-light.md").write_text(RADIO, encoding="utf-8")
    library = tmp_path / "library"
    card_with_traits(library, "reader", {"gender": "f", "age": "40s", "roles": ["narrator"]})
    return work, library


def call(*argv: str, env: dict[str, str] | None = None, **seams_: object) -> tuple[dict[str, object], int]:
    (body, code), _ = run([*argv, "--json"], env or {}, **seams_)  # type: ignore[arg-type]
    return body, code


def test_a_narrated_unit_is_auto_cast_performed_and_mixed_in_its_own_output(narrated: tuple[Path, Path], tmp_path: Path) -> None:
    work, library = narrated
    common = ("--work", str(work), "--library", str(library), "--episode", "1", "--output", "narrated")

    cast, code = call("cast", "--auto", *common)
    assert code == 0, cast
    bound = json.loads((work / "outputs" / "narrated" / "casting" / "cast.json").read_text(encoding="utf-8"))["roles"]
    # The narrator is cast from the library; unit 1 has no character lines, so it is the only role.
    assert list(bound) == ["NARRATOR"] and bound["NARRATOR"]["slug"] == "reader"

    performed, code = call("perform", *common, scorers=fake_scorers, engines=Factory(wps=(3.0,)))
    assert code == 0, performed
    assert performed["lines"] == 2 and str(performed["manifest"]).endswith("outputs/narrated/casting/renders/ep01/v1.json")

    mixer, cues = seams()
    # The pablo CLI names the output through the environment; the same as --output.
    mixed, code = call("mix", "--work", str(work), "--episode", "1", "--cues", str(tmp_path / "cues"), env={outputs.OUTPUT_ENV: "narrated"}, mixer=mixer)
    assert code == 0, mixed
    assert cues.made == []  # a reading has no cues: dialogue only
    with outputs.using(outputs.NARRATED):
        manifest = read_version(work, 1, 1)
    assert manifest is not None and manifest["audio"] == "ep01.v1.m4a"
    assert (work / "outputs" / "narrated" / "casting" / "renders" / "ep01" / "ep01.v1.m4a").is_file()

    # The radio output's casting state is never touched, and its episode 1 is still unperformed.
    assert not (work / "outputs" / "radio" / "casting").exists()
    status, code = call("status", "--work", str(work), "--episode", "1")
    assert code == 2 and status["roles"] == ["OTTO"], status

    rows = [json.loads(line) for line in receipts_path(work).read_text(encoding="utf-8").splitlines()]
    assert rows and all(row.get("output") == "narrated" for row in rows)


def test_character_voices_are_cast_only_when_the_reading_has_them(narrated: tuple[Path, Path]) -> None:
    work, library = narrated
    card_with_traits(library, "mavis", {"gender": "f", "age": "40s"})
    body, code = call("check", "--work", str(work), "--episode", "2", "--output", "narrated")
    assert code == 0 and [row["role"] for row in body["unboundRoles"]] == ["NARRATOR", "MAVIS"], body  # type: ignore[union-attr,index]
    body, code = call("cast", "--auto", "--work", str(work), "--library", str(library), "--episode", "2", "--output", "narrated")
    assert code == 0, body
    roles = json.loads((work / "outputs" / "narrated" / "casting" / "cast.json").read_text(encoding="utf-8"))["roles"]
    assert set(roles) == {"NARRATOR", "MAVIS"}


def test_an_unknown_output_and_a_narrated_stream_are_refused(narrated: tuple[Path, Path]) -> None:
    work, library = narrated
    body, code = call("perform", "--work", str(work), "--episode", "1", "--output", "novel")
    assert code == 2 and "unknown output" in str(body["message"])
    body, code = call("perform", "--work", str(work), "--library", str(library), "--episode", "1", "--output", "narrated", "--stream")
    assert code == 2 and "--stream" in str(body["message"])
    assert not (work / "outputs" / "narrated" / "casting").exists()
