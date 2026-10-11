"""`pablo check`, `pablo status --for episode N` and `pablo bind` on the Python side, model-free."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from pablo_casting.binding import card_hash
from pablo_casting.cli import run

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def env(tmp_path: Path) -> dict[str, str]:
    return {"HOME": str(tmp_path / "home"), "XDG_CONFIG_HOME": str(tmp_path / "config"), "HF_HUB_CACHE": str(tmp_path / "hf")}


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    root = tmp_path / "vault"
    for slug, extra in (("cora", {}), ("edwin", {}), ("old-ned", {"retired": True})):
        card = {"slug": slug, "reference": {"sha256": f"ref-{slug}"}, **extra}
        directory = root / "casting" / "voices" / slug
        directory.mkdir(parents=True)
        (directory / "card.json").write_text(json.dumps(card), encoding="utf-8")
    return root


@pytest.fixture
def work(vault: Path) -> Path:
    """A radio work: scripts under outputs/radio/episodes."""
    episodes = vault / "novels" / "show" / "outputs" / "radio" / "episodes"
    episodes.mkdir(parents=True)
    shutil.copy(FIXTURES / "01-the-lighthouse-supper.md", episodes)
    shutil.copy(FIXTURES / "grammar.md", episodes / "02-every-grammar-case.md")
    return vault / "novels" / "show"


@pytest.fixture
def sandbox_work(vault: Path) -> Path:
    """The sandbox shape: episode scripts as chapters, no outputs directory."""
    chapters = vault / "novels" / "drama" / "chapters"
    chapters.mkdir(parents=True)
    shutil.copy(FIXTURES / "01-the-lighthouse-supper.md", chapters)
    (chapters / "02-prose.md").write_text("Just prose, no cast line.\n", encoding="utf-8")
    return vault / "novels" / "drama"


def call(env: dict[str, str], *argv: str) -> tuple[dict[str, object], int]:
    (body, code), _ = run([*argv, "--json"], env)
    return body, code


def bind(env: dict[str, str], vault: Path, work: Path, role: str, voice: str) -> tuple[dict[str, object], int]:
    return call(env, "bind", "--work", str(work), "--vault", str(vault), "--role", role, "--voice", voice)


# ---- AC3: check lists unknown directions with line numbers and unbound roles

def test_check_lists_unknown_directions_with_line_numbers_and_unbound_roles(env: dict[str, str], work: Path) -> None:
    body, code = call(env, "check", "--work", str(work))
    assert code == 0 and body["ok"] is True
    unknown = body["unknownDirections"]
    assert isinstance(unknown, list)
    chapter = (work / "outputs/radio/episodes/01-the-lighthouse-supper.md").read_text().splitlines()
    one = [u for u in unknown if u["file"].endswith("01-the-lighthouse-supper.md")]
    assert {u["text"] for u in one} == {"(approaching)", "(smiling)", "(small laugh)"}
    for u in one:
        assert u["text"] in chapter[u["line"] - 1]
    assert {(u["episode"], u["role"]) for u in body["unboundRoles"] if u["episode"] == 1} == {  # type: ignore[union-attr]
        (1, "ORLA"), (1, "BRAM"), (1, "MR. PELL"), (1, "MRS. PELL"), (1, "ANNOUNCER"), (1, "NARRATOR"),
    }


def test_check_one_episode_and_counts(env: dict[str, str], work: Path) -> None:
    body, _ = call(env, "check", "--work", str(work), "--episode", "1")
    episodes = body["episodes"]
    assert isinstance(episodes, list) and len(episodes) == 1
    assert (episodes[0]["lines"], episodes[0]["cues"]) == (15, 8)


def test_check_a_missing_episode_is_a_refusal(env: dict[str, str], work: Path) -> None:
    body, code = call(env, "check", "--work", str(work), "--episode", "9")
    assert code == 2 and body["ok"] is False


def test_check_reads_scripts_from_chapters_when_there_is_no_radio_output(env: dict[str, str], sandbox_work: Path) -> None:
    body, code = call(env, "check", "--work", str(sandbox_work))
    assert code == 0
    assert [e["episode"] for e in body["episodes"]] == [1]  # type: ignore[union-attr]  # the prose chapter has no CAST line


def test_check_drops_a_role_once_bound(env: dict[str, str], vault: Path, work: Path) -> None:
    assert bind(env, vault, work, "CORA", "cora")[1] == 0
    body, _ = call(env, "check", "--work", str(work), "--episode", "1")
    assert all(u["role"] != "CORA" for u in body["unboundRoles"])  # type: ignore[union-attr]


# ---- AC3: status --for episode N is exit 2 while any role is unbound

def test_status_is_exit_2_while_a_role_is_unbound(env: dict[str, str], vault: Path, work: Path) -> None:
    body, code = call(env, "status", "--work", str(work), "--episode", "1")
    assert code == 2 and body["ready"] is False
    missing = body["missing"]
    assert isinstance(missing, list) and len(missing) == 6 and "ORLA" in " ".join(missing)

    for role, voice in (("BRAM", "edwin"), ("ORLA", "cora")):
        assert bind(env, vault, work, role, voice)[1] == 0
    body, code = call(env, "status", "--work", str(work), "--episode", "1")
    assert code == 2 and len(body["missing"]) == 4  # type: ignore[arg-type]


def test_status_is_ready_when_every_role_is_bound(env: dict[str, str], vault: Path, work: Path) -> None:
    for role in ("ORLA", "BRAM", "MR. PELL", "MRS. PELL", "ANNOUNCER", "NARRATOR"):
        assert bind(env, vault, work, role, "cora")[1] == 0
    body, code = call(env, "status", "--work", str(work), "--episode", "1")
    assert code == 0 and body["ready"] is True and body["missing"] == []


def test_status_counts_an_undeclared_speaker_as_unbound(env: dict[str, str], work: Path) -> None:
    body, code = call(env, "status", "--work", str(work), "--episode", "2")
    assert code == 2
    assert any("ALDERMAN OTT" in m for m in body["missing"])  # type: ignore[union-attr]


def test_status_for_an_episode_with_no_script_is_not_ready(env: dict[str, str], work: Path) -> None:
    body, code = call(env, "status", "--work", str(work), "--episode", "7")
    assert code == 2 and body["ready"] is False


def test_status_needs_an_episode(env: dict[str, str], work: Path) -> None:
    assert call(env, "status", "--work", str(work))[1] == 2


# ---- AC4: cast.json pins the card hash and records by: manual; bind refuses absent and retired slugs

def test_bind_pins_the_card_hash_and_records_manual(env: dict[str, str], vault: Path, work: Path) -> None:
    body, code = bind(env, vault, work, "cora", "cora")
    assert code == 0 and body["role"] == "CORA"
    cast = json.loads((work / "outputs/radio/casting/cast.json").read_text())
    card = json.loads((vault / "casting/voices/cora/card.json").read_text())
    entry = cast["roles"]["CORA"]
    assert entry["slug"] == "cora" and entry["by"] == "manual"
    assert entry["card_hash"] == card_hash(card) and len(entry["card_hash"]) == 64  # library.card_hash, hex
    assert "at" in entry and cast["version"] == 1


def test_card_hash_follows_the_reference(vault: Path) -> None:
    card = json.loads((vault / "casting/voices/cora/card.json").read_text())
    changed = {**card, "reference": {"sha256": "different"}}
    assert card_hash(card) != card_hash(changed)
    assert card_hash(card) == card_hash(dict(reversed(list(card.items()))))  # key order does not matter


def test_retiring_a_bound_voice_keeps_its_pin_and_refuses_new_binds(env: dict[str, str], vault: Path, work: Path) -> None:
    """AGT-1679: `voices retire` leaves the card hash alone (stories that pin it still match) but bind refuses it."""
    bind(env, vault, work, "CORA", "cora")
    pinned = json.loads((work / "outputs/radio/casting/cast.json").read_text())["roles"]["CORA"]["card_hash"]
    body, code = call(env, "voices", "retire", "cora", "--vault", str(vault))
    assert code == 0 and body["hash"] == pinned
    retired = json.loads((vault / "casting/voices/cora/card.json").read_text())
    assert card_hash(retired) == pinned
    refused, code = bind(env, vault, work, "CORA", "cora")
    assert code == 2 and "retired" in str(refused["message"])


def test_bind_refuses_a_slug_not_in_the_library(env: dict[str, str], vault: Path, work: Path) -> None:
    body, code = bind(env, vault, work, "CORA", "nobody")
    assert code == 2 and "no voice" in str(body["message"])
    assert not (work / "outputs/radio/casting/cast.json").exists()


def test_bind_refuses_a_retired_voice(env: dict[str, str], vault: Path, work: Path) -> None:
    body, code = bind(env, vault, work, "CORA", "old-ned")
    assert code == 2 and "retired" in str(body["message"])
    assert not (work / "outputs/radio/casting/cast.json").exists()


@pytest.mark.parametrize("slug", ["../cora", "cora/..", "/etc/passwd", "Cora", "", ".hidden"])
def test_bind_refuses_a_slug_that_escapes_the_library(env: dict[str, str], vault: Path, work: Path, slug: str) -> None:
    assert bind(env, vault, work, "CORA", slug)[1] == 2


def test_bind_refuses_a_role_no_script_declares(env: dict[str, str], vault: Path, work: Path) -> None:
    body, code = bind(env, vault, work, "CORRA", "cora")
    assert code == 2 and "CORRA" in str(body["message"])


def test_rebinding_replaces_and_says_so(env: dict[str, str], vault: Path, work: Path) -> None:
    bind(env, vault, work, "CORA", "cora")
    body, code = bind(env, vault, work, "CORA", "edwin")
    assert code == 0 and body["replaced"] == "cora"
    cast = json.loads((work / "outputs/radio/casting/cast.json").read_text())
    assert cast["roles"]["CORA"]["slug"] == "edwin"


def test_bind_in_a_work_without_an_output_directory_uses_casting_cast_json(env: dict[str, str], vault: Path, sandbox_work: Path) -> None:
    assert bind(env, vault, sandbox_work, "ORLA", "cora")[1] == 0
    assert (sandbox_work / "casting" / "cast.json").is_file()


def test_bind_needs_a_library(env: dict[str, str], work: Path) -> None:
    body, code = call(env, "bind", "--work", str(work), "--role", "CORA", "--voice", "cora")
    assert code == 2 and "library" in str(body["message"])


def test_bind_honours_the_configured_library(env: dict[str, str], vault: Path, work: Path) -> None:
    config = Path(env["XDG_CONFIG_HOME"]) / "pablo" / "casting.json"
    config.parent.mkdir(parents=True)
    config.write_text(json.dumps({"library": str(vault / "casting")}), encoding="utf-8")  # the library root (AGT-1679)
    assert call(env, "bind", "--work", str(work), "--role", "CORA", "--voice", "cora")[1] == 0


def test_a_corrupt_cast_json_is_a_refusal_not_a_crash(env: dict[str, str], vault: Path, work: Path) -> None:
    path = work / "outputs/radio/casting/cast.json"
    path.parent.mkdir(parents=True)
    path.write_text("{not json", encoding="utf-8")
    assert call(env, "check", "--work", str(work))[1] == 2
    assert bind(env, vault, work, "CORA", "cora")[1] == 2


def test_script_command_returns_the_parsed_records(env: dict[str, str], work: Path) -> None:
    body, code = call(env, "script", "--work", str(work), "--episode", "2")
    assert code == 0 and body["lines"] > 0 and body["cues"] == 4  # type: ignore[operator]
    assert call(env, "script", "--work", str(work), "--episode", "9")[1] == 2


def test_commands_that_need_a_work_refuse_without_one(env: dict[str, str]) -> None:
    for command in ("script", "check", "status", "bind"):
        assert call(env, command)[1] == 2
