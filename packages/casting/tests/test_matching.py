"""Auto-casting (AGT-1698): `cast --auto` over a fixture library of six cards.

The cards carry synthetic stored ECAPA embeddings (seeded random 192-d
vectors, one a near copy of another), so distinctness is exercised without a
model. Every library and work is a tmp directory, never a real vault.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from pablo_casting.cli import run
from pablo_casting.library import card_hash
from pablo_casting.matching import Thresholds, cosine, score, thresholds_from
from pablo_casting.config import ConfigRefusal

SCRIPT = """---
chapter: 1
title: The Harbour Ledger
---
CAST: CORA=f "thirties, low-medium, measured, warm, dry, period, lead", EDWIN=m "forties, deep, expansive, warm, period", NELL=f "thirties, low-medium, dry, warm", RAMON=m "seventies, reedy, gruff, cool, period"

CORA: (dryly) The ledger does not lie, Edwin.
EDWIN: (warmly) Ledgers lie all the time, Cora.
NELL: Someone has to count the boats.
RAMON: Not in my day.
"""

_rng = np.random.default_rng(1698)
_BASE = {name: _rng.standard_normal(192) for name in ("cora", "maren", "edwin", "ned", "tom")}
# cora-twin is cora with a little noise: an ECAPA cosine well above the 0.75 cut.
_BASE["cora-twin"] = _BASE["cora"] + 0.2 * _rng.standard_normal(192)

CARDS: dict[str, dict[str, object]] = {
    "cora": {"gender": "f", "age": "30s", "pitch": "low-medium", "energy": "measured", "warmth": "warm", "register": "dry", "era": "period", "roles": ["lead"]},
    # Fits NELL perfectly, but sounds like cora.
    "cora-twin": {"gender": "f", "age": "30s", "pitch": "low-medium", "warmth": "warm", "register": "dry", "era": "period"},
    # NELL's distinct fallback: age and warmth agree, pitch a band away, register not: 4/6.
    "maren": {"gender": "f", "age": "30s", "pitch": "medium", "warmth": "warm", "register": "plain", "era": "modern"},
    "edwin": {"gender": "m", "age": "40s", "pitch": "low", "energy": "lively", "warmth": "warm", "register": "theatrical", "era": "period"},
    # Would fit RAMON exactly, but is retired.
    "ned": {"gender": "m", "age": "70s", "pitch": "high", "warmth": "cool", "register": "gruff", "era": "period"},
    "tom": {"gender": "m", "age": "20s", "pitch": "medium-high", "energy": "lively", "warmth": "warm", "register": "folksy", "era": "modern"},
}


@pytest.fixture
def env(tmp_path: Path) -> dict[str, str]:
    return {"HOME": str(tmp_path / "home"), "XDG_CONFIG_HOME": str(tmp_path / "config"), "HF_HUB_CACHE": str(tmp_path / "hf"), "USER": "tester"}


def _write_card(vault: Path, slug: str, traits: dict[str, object], *, retired: bool = False) -> None:
    directory = vault / "casting" / "voices" / slug
    directory.mkdir(parents=True, exist_ok=True)
    card: dict[str, object] = {
        "slug": slug,
        "description": f"fixture voice {slug}",
        "reference": {"file": "reference.flac", "sha256": f"ref-{slug}"},
        "embedding": {"model": "speechbrain/spkrec-ecapa-voxceleb", "file": "embedding.ecapa.npy"},
        "traits": traits,
    }
    if retired:
        card["retired"] = {"at": "2026-10-10T00:00:00Z", "by": "matt"}
    (directory / "card.json").write_text(json.dumps(card, indent=2), encoding="utf-8")
    np.save(directory / "embedding.ecapa.npy", _BASE[slug].astype(np.float32))


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    root = tmp_path / "vault"
    for slug, traits in CARDS.items():
        _write_card(root, slug, traits, retired=slug == "ned")
    return root


@pytest.fixture
def work(vault: Path) -> Path:
    episodes = vault / "stories" / "harbour" / "outputs" / "radio" / "episodes"
    episodes.mkdir(parents=True)
    (episodes / "01-the-harbour-ledger.md").write_text(SCRIPT, encoding="utf-8")
    return vault / "stories" / "harbour"


def call(env: dict[str, str], *argv: str) -> tuple[dict[str, object], int]:
    (body, code), _ = run([*argv, "--json"], env)
    return body, code


def auto(env: dict[str, str], vault: Path, work: Path, *extra: str) -> tuple[dict[str, object], int]:
    return call(env, "cast", "--auto", "--work", str(work), "--vault", str(vault), *extra)


def cast_json(work: Path) -> dict[str, dict[str, object]]:
    return json.loads((work / "outputs" / "radio" / "casting" / "cast.json").read_text(encoding="utf-8"))["roles"]


def rows(body: dict[str, object]) -> dict[str, dict[str, object]]:
    return {str(row["role"]): row for row in body["bindings"]}  # type: ignore[union-attr]


def write_config(env: dict[str, str], body: object) -> None:
    path = Path(env["XDG_CONFIG_HOME"]) / "pablo" / "casting.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body), encoding="utf-8")


# ---- AC1: six cards, four roles: the expected binds, distinctness, the fourth needs design

def test_the_fixture_twins_are_within_the_cut_and_the_rest_are_not() -> None:
    assert cosine(_BASE["cora"], _BASE["cora-twin"]) > 0.75
    for a in ("cora", "maren", "edwin", "tom"):
        for b in ("cora", "maren", "edwin", "tom"):
            if a != b:
                assert cosine(_BASE[a], _BASE[b]) < 0.75


def test_auto_cast_binds_the_expected_cards_and_hands_the_fourth_role_to_design(env: dict[str, str], vault: Path, work: Path) -> None:
    body, code = auto(env, vault, work, "--episode", "1")
    assert code == 0 and body["ok"] is True
    bound = rows(body)
    assert {role: row["slug"] for role, row in bound.items()} == {"CORA": "cora", "EDWIN": "edwin", "NELL": "maren"}
    assert bound["CORA"]["score"] == 1.0 and bound["CORA"]["review"] is False
    assert bound["EDWIN"]["score"] == 1.0 and bound["EDWIN"]["review"] is False
    # cora-twin scores 1.0 for NELL but sounds like CORA's voice: maren binds in the review band.
    assert bound["NELL"]["score"] == pytest.approx(0.667, abs=0.001) and bound["NELL"]["review"] is True

    [ramon] = body["needsDesign"]  # type: ignore[misc]
    assert ramon["role"] == "RAMON"
    assert ramon["best"]["slug"] == "tom" and ramon["best"]["score"] < 0.6
    assert "below 0.6" in ramon["reason"]
    assert body["complete"] is False
    assert body["episodes"] == [1]


def test_two_roles_are_never_bound_to_voices_within_the_distinctness_cut(env: dict[str, str], vault: Path, work: Path) -> None:
    body, _ = auto(env, vault, work)
    slugs = [str(row["slug"]) for row in body["bindings"]]  # type: ignore[union-attr]
    assert len(slugs) == len(set(slugs))
    for i, a in enumerate(slugs):
        for b in slugs[i + 1 :]:
            assert cosine(_BASE[a], _BASE[b]) <= 0.75
    assert "cora-twin" not in slugs
    assert rows(body)["NELL"]["runnerUp"] is None  # cora-twin was skipped, not ranked


def test_cast_json_records_by_match_the_score_and_the_runner_up(env: dict[str, str], vault: Path, work: Path) -> None:
    auto(env, vault, work, "--all")
    roles = cast_json(work)
    assert set(roles) == {"CORA", "EDWIN", "NELL"}
    cora = roles["CORA"]
    assert cora["by"] == "match" and cora["slug"] == "cora" and cora["score"] == 1.0
    assert cora["card_hash"] == card_hash(json.loads((vault / "casting/voices/cora/card.json").read_text()))
    # Nothing is bound before CORA, so cora-twin still ranks: the runner-up (no energy, no role kind: 7/8.5).
    assert cora["runner_up"] == {"slug": "cora-twin", "score": pytest.approx(7 / 8.5, abs=0.001)}
    assert roles["EDWIN"]["runner_up"]["slug"] == "tom"  # type: ignore[index]
    assert roles["NELL"]["review"] is True and roles["CORA"]["review"] is False


def test_rerunning_keeps_existing_bindings_and_counts_them_as_bound(env: dict[str, str], vault: Path, work: Path) -> None:
    auto(env, vault, work)
    first = cast_json(work)
    body, code = auto(env, vault, work)
    assert code == 0
    assert cast_json(work) == first
    assert all(row["new"] is False and row["pin"] == "ok" for row in body["bindings"])  # type: ignore[union-attr]
    assert [r["role"] for r in body["needsDesign"]] == ["RAMON"]  # type: ignore[union-attr]


def test_a_hand_bound_voice_is_kept_and_blocks_its_sound_alikes(env: dict[str, str], vault: Path, work: Path) -> None:
    body, code = call(env, "bind", "--work", str(work), "--vault", str(vault), "--role", "NELL", "--voice", "cora-twin")
    assert code == 0, body
    body, _ = auto(env, vault, work)
    bound = rows(body)
    assert bound["NELL"]["slug"] == "cora-twin" and bound["NELL"]["by"] == "manual" and bound["NELL"]["new"] is False
    # cora sounds like cora-twin, so CORA cannot have it, and maren (4/8.5) is too weak a fit.
    assert "CORA" not in bound
    cora = next(r for r in body["needsDesign"] if r["role"] == "CORA")  # type: ignore[union-attr]
    assert cora["alike"] == ["cora"] and cora["best"]["slug"] == "maren"


def test_thresholds_come_from_the_config(env: dict[str, str], vault: Path, work: Path) -> None:
    write_config(env, {"matching": {"review": 0.7}})
    body, _ = auto(env, vault, work)
    assert sorted(r["role"] for r in body["needsDesign"]) == ["NELL", "RAMON"]  # type: ignore[union-attr]
    assert body["thresholds"]["review"] == 0.7  # type: ignore[index]


def test_a_looser_distinctness_cut_lets_the_twin_through(env: dict[str, str], vault: Path, work: Path) -> None:
    write_config(env, {"matching": {"distinct": 1.0}})
    body, _ = auto(env, vault, work)
    assert rows(body)["NELL"]["slug"] == "cora-twin" and rows(body)["NELL"]["review"] is False


def test_no_distinct_candidate_is_needs_design(env: dict[str, str], vault: Path, work: Path) -> None:
    for slug in ("maren",):
        card_path = vault / "casting" / "voices" / slug / "card.json"
        card = json.loads(card_path.read_text())
        card["retired"] = {"at": "x", "by": "matt"}
        card_path.write_text(json.dumps(card))
    body, _ = auto(env, vault, work)
    nell = next(r for r in body["needsDesign"] if r["role"] == "NELL")  # type: ignore[union-attr]
    assert "no distinct candidate" in nell["reason"] and nell["alike"] == ["cora-twin"]


def test_an_undeclared_speaker_needs_design(env: dict[str, str], vault: Path, work: Path) -> None:
    script = work / "outputs" / "radio" / "episodes" / "01-the-harbour-ledger.md"
    script.write_text(SCRIPT + "HARBOURMASTER: Tide's turning.\n", encoding="utf-8")
    body, _ = auto(env, vault, work)
    master = next(r for r in body["needsDesign"] if r["role"] == "HARBOURMASTER")  # type: ignore[union-attr]
    assert "not on the CAST: line" in master["reason"]


# ---- AC2: the --json body lists every binding with score, runner-up and by; review marked

def test_the_json_body_lists_every_binding(env: dict[str, str], vault: Path, work: Path) -> None:
    body, _ = auto(env, vault, work)
    for row in body["bindings"]:  # type: ignore[union-attr]
        assert {"role", "slug", "cardHash", "by", "score", "runnerUp", "review"} <= set(row)
        assert row["by"] == "match"
    assert [row["role"] for row in body["bindings"] if row["review"]] == ["NELL"]  # type: ignore[union-attr]
    assert "NELL marked review" in str(body["message"]) and "RAMON needs a designed voice" in str(body["message"])


# ---- AC3: a retired card is never matched; a story that already pins it still performs

def test_a_retired_card_is_never_matched(env: dict[str, str], vault: Path, work: Path) -> None:
    body, _ = auto(env, vault, work)
    every = [row["slug"] for row in body["bindings"]] + [row["runnerUp"]["slug"] for row in body["bindings"] if row["runnerUp"]]  # type: ignore[union-attr,index]
    every += [r["best"]["slug"] for r in body["needsDesign"] if r["best"]]  # type: ignore[union-attr,index]
    assert "ned" not in every
    # Unretired, ned is RAMON's exact fit: retirement is the only thing keeping it out.
    card_path = vault / "casting" / "voices" / "ned" / "card.json"
    card = json.loads(card_path.read_text())
    del card["retired"]
    card_path.write_text(json.dumps(card))
    body, _ = auto(env, vault, work)
    assert rows(body)["RAMON"]["slug"] == "ned" and rows(body)["RAMON"]["score"] == 1.0


def test_a_story_that_pins_a_retired_voice_still_performs(env: dict[str, str], vault: Path, work: Path) -> None:
    auto(env, vault, work)
    pinned = cast_json(work)["EDWIN"]
    body, code = call(env, "voices", "retire", "edwin", "--vault", str(vault))
    assert code == 0 and body["hash"] == pinned["card_hash"]

    body, code = auto(env, vault, work)
    edwin = rows(body)["EDWIN"]
    assert edwin["slug"] == "edwin" and edwin["pin"] == "ok" and edwin["new"] is False
    assert cast_json(work)["EDWIN"] == pinned
    # The pin still clears the performance precondition once every role is bound.
    call(env, "bind", "--work", str(work), "--vault", str(vault), "--role", "RAMON", "--voice", "tom")
    status, code = call(env, "status", "--work", str(work), "--episode", "1")
    assert code == 0 and status["ready"] is True
    # ...but a new story never matches the retired voice.
    other = vault / "stories" / "other" / "outputs" / "radio" / "episodes"
    other.mkdir(parents=True)
    (other / "01-x.md").write_text('CAST: BRAM=m "forties, deep, expansive, warm, period"\nBRAM: Hello.\n', encoding="utf-8")
    body, _ = auto(env, vault, vault / "stories" / "other")
    assert "BRAM" not in rows(body)
    [bram] = body["needsDesign"]  # type: ignore[misc]
    assert bram["role"] == "BRAM" and bram["best"]["slug"] == "tom"


# ---- refusals and the scorer

def test_refusals(env: dict[str, str], vault: Path, work: Path, tmp_path: Path) -> None:
    assert auto(env, vault, work, "--episode", "1", "--all")[1] == 2
    assert auto(env, vault, work, "--episode", "9")[1] == 2
    assert auto(env, vault, work, "--candidate", "2")[1] == 2
    assert call(env, "cast", "--auto", "--vault", str(vault))[1] == 2
    empty = tmp_path / "empty"
    empty.mkdir()
    body, code = auto(env, vault, empty)
    assert code == 2 and "no radio scripts" in str(body["message"])
    write_config(env, {"matching": {"bind": 0.5, "review": 0.6}})
    assert auto(env, vault, work)[1] == 2


def test_thresholds_from_validates() -> None:
    assert thresholds_from(None) == Thresholds()
    assert thresholds_from({"weights": {"roles": 1}}).weights["roles"] == 1.0
    for bad in ({"bind": 2}, {"weights": {"accent": 1}}, {"weights": {"age": -1}}, {"nope": 1}, {"distinct": True}):
        with pytest.raises(ConfigRefusal):
            thresholds_from(bad)


def test_score_weights_and_neighbouring_bands() -> None:
    weights = Thresholds().weights
    assert score({"gender": "f"}, {"gender": "f"}, weights) == 1.0
    assert score({"age": "30s"}, {"age": "40s"}, weights) == 0.5
    assert score({"age": "30s", "register": "dry"}, {"age": "30s"}, weights) == pytest.approx(2 / 3)
    assert score({"roles": ["lead"]}, {"roles": ["lead", "bookkeeper"]}, weights) == 1.0
