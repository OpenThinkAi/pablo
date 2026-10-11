"""Cast cards and the voice library (AGT-1679): `audition`, `cast`, `voices`.

Every test drives the fake toolkit (`pablo_casting.fakes`): no model is loaded
and every library is a tmp directory, never a real vault.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
from collections.abc import Mapping
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from pablo_casting.cli import run
from pablo_casting.config import CastingConfig
from pablo_casting.fakes import FakeDesigner, fake_toolkit
from pablo_casting.library import CARD_FILES, Library, card_hash
from pablo_casting.passage import PASSAGE, PASSAGE_SHA256
from pablo_casting.toolkit import Toolkit

DESCRIPTION = "A woman in her thirties, low-medium pitch, dry and exact, warm underneath, measured pace"
TRAITS = json.dumps({"gender": "f", "age": "30s", "pitch": "low-medium", "register": "dry", "roles": ["lead"]})

# The design's card.json, key for key (pm project pablo-casting, "The cast card and the voice library").
CARD_KEYS = [
    "slug", "description", "designed", "reference", "embedding", "traits", "pace",
    "admitted", "performance", "gates", "created", "by", "notes",
]  # fmt: skip
DESIGNED_KEYS = ["engine", "weights_sha256", "instruct", "seed", "candidate"]
REFERENCE_KEYS = ["file", "sha256", "seconds", "transcript", "sample_rate"]


@pytest.fixture
def env(tmp_path: Path) -> dict[str, str]:
    return {
        "HOME": str(tmp_path / "home"),
        "XDG_CONFIG_HOME": str(tmp_path / "config"),
        "HF_HUB_CACHE": str(tmp_path / "hf"),
        "USER": "tester",
    }


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    path = tmp_path / "vault"
    path.mkdir()
    return path


def toolkits(designer: FakeDesigner | None = None):
    def factory(env: Mapping[str, str], config: CastingConfig) -> Toolkit:
        return fake_toolkit(designer)

    return factory


def call(argv: list[str], env: dict[str, str], designer: FakeDesigner | None = None) -> tuple[dict[str, object], int]:
    (body, code), _ = run([*argv, "--json"], env, toolkits=toolkits(designer))
    return body, code


def audition(vault: Path, env: dict[str, str], *extra: str, designer: FakeDesigner | None = None, role: str = "CORA") -> tuple[dict[str, object], int]:
    return call(
        ["audition", "--role", role, "--describe", DESCRIPTION, "--traits", TRAITS, "--seed", "100", "--vault", str(vault), *extra],
        env,
        designer,
    )


def cast(vault: Path, env: dict[str, str], candidate: int, *extra: str, designer: FakeDesigner | None = None, role: str = "CORA") -> tuple[dict[str, object], int]:
    return call(["cast", "--role", role, "--candidate", str(candidate), "--vault", str(vault), *extra], env, designer)


def voice(vault: Path, slug: str = "cora") -> Path:
    return vault / "casting" / "voices" / slug


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    ).stdout


# --- audition (AC1) ---------------------------------------------------------


def test_audition_leaves_n_candidates_each_with_provenance_and_scores(vault: Path, env: dict[str, str]) -> None:
    body, code = audition(vault, env, "-n", "3")
    assert code == 0, body
    folder = voice(vault) / "auditions"
    assert sorted(p.name for p in folder.iterdir()) == [
        "1.ecapa.npy", "1.json", "1.wav", "2.ecapa.npy", "2.json", "2.wav", "3.ecapa.npy", "3.json", "3.wav",
    ]  # fmt: skip
    for number, seed in ((1, 100), (2, 101), (3, 102)):
        record = json.loads((folder / f"{number}.json").read_text())
        assert record["candidate"] == number
        assert record["designer"] == {"name": "qwen3", "engine": "fake/qwen3-designer", "weights_sha256": "0" * 64}
        assert record["instruct"] == DESCRIPTION
        assert record["seed"] == seed
        assert record["passage"]["sha256"] == PASSAGE_SHA256
        assert set(record["scores"]) == {"utmos", "pitch_hz", "wps", "ecapa"}
        assert record["scores"]["utmos"] == 4.1
        assert 80 <= record["scores"]["pitch_hz"] <= 270
        assert 2.4 <= record["scores"]["wps"] <= 3.4
        assert set(record["scores"]["ecapa"]) == {str(n) for n in (1, 2, 3) if n != number}
        assert record["trim"]["ok"] is True
        assert record["traits"]["gender"] == "f"
    assert [c["candidate"] for c in body["candidates"]] == [1, 2, 3]  # type: ignore[index]


def test_near_duplicates_are_marked_on_both_sides(vault: Path, env: dict[str, str]) -> None:
    # Seeds 100 and 101 render the same voice; 102 a different one.
    designer = FakeDesigner(name="qwen3", pitch=lambda instruct, seed: 120.0 if seed < 102 else 230.0)
    body, code = audition(vault, env, "-n", "3", designer=designer)
    assert code == 0, body
    records = {c["candidate"]: c for c in body["candidates"]}  # type: ignore[union-attr]
    assert records[1]["near_duplicates"] == [2]
    assert records[2]["near_duplicates"] == [1]
    assert records[3]["near_duplicates"] == []
    assert records[1]["scores"]["ecapa"]["2"] >= 0.75
    assert records[1]["scores"]["ecapa"]["3"] < 0.75


def test_a_second_round_continues_the_numbering_and_overwrites_nothing(vault: Path, env: dict[str, str]) -> None:
    audition(vault, env, "-n", "2")
    first = (voice(vault) / "auditions" / "1.wav").read_bytes()
    body, code = audition(vault, env, "-n", "2")
    assert code == 0
    assert [c["candidate"] for c in body["candidates"]] == [3, 4]  # type: ignore[union-attr]
    assert (voice(vault) / "auditions" / "1.wav").read_bytes() == first


def test_audition_writes_the_library_gitignore_on_first_use(vault: Path, env: dict[str, str]) -> None:
    audition(vault, env, "-n", "1")
    lines = (vault / "casting" / ".gitignore").read_text().splitlines()
    for pattern in ("auditions/", "takes/", "recast/", "renders/*.m4a"):
        assert pattern in lines
    audition(vault, env, "-n", "1")
    assert (vault / "casting" / ".gitignore").read_text().splitlines() == lines


def test_audition_receipt_per_render(vault: Path, env: dict[str, str], tmp_path: Path) -> None:
    work = tmp_path / "work"
    work.mkdir()
    audition(vault, env, "-n", "2", "--work", str(work))
    receipts = [json.loads(line) for line in (work / ".pablo" / "casting" / "receipts.jsonl").read_text().splitlines()]
    assert [r["intent"] for r in receipts] == ["audition", "audition"]
    assert {"engine", "weights_sha256", "inputs_sha256", "seed", "wall", "audio_seconds", "rtf"} <= set(receipts[0])


@pytest.mark.parametrize(
    ("argv", "needle"),
    [
        (["audition", "--describe", DESCRIPTION], "--role"),
        (["audition", "--role", "CORA"], "--describe"),
        (["audition", "--role", "CORA", "--describe", DESCRIPTION, "--designer", "dia"], "unknown designer"),
        (["audition", "--role", "CORA", "--describe", DESCRIPTION, "-n", "0"], "-n must be"),
        (["audition", "--role", "CORA", "--describe", DESCRIPTION, "--traits", '{"gender":"woman"}'], "trait gender"),
        (["audition", "--role", "CORA", "--describe", DESCRIPTION, "--traits", '{"accent":"posh"}'], "unknown trait"),
        (["audition", "--role", "!!!", "--describe", DESCRIPTION], "--slug"),
    ],
)
def test_audition_refusals(vault: Path, env: dict[str, str], argv: list[str], needle: str) -> None:
    body, code = call([*argv, "--vault", str(vault)], env)
    assert code == 2, body
    assert needle in str(body["message"])
    assert not (voice(vault) / "auditions").exists()


def test_the_cast_line_mapper_only_produces_valid_card_traits() -> None:
    """One vocabulary: whatever `traits.normalise` maps from a `CAST:` description is a valid card block."""
    from pablo_casting.traits import normalise, parse_traits

    for gender, description in (
        ("f", "thirties, dry, exact, warm underneath, low-medium, measured"),
        ("m", "forties, expansive, boisterous to tender, deep, folksy, 1919"),
        ("m", "elderly narrator, gruff, cool, quiet, modern"),
    ):
        mapped = normalise("ROLE", gender, description).traits
        assert parse_traits(mapped) == mapped


def test_no_library_is_a_refusal(env: dict[str, str]) -> None:
    body, code = call(["audition", "--role", "CORA", "--describe", DESCRIPTION], env)
    assert code == 2
    assert "library" in str(body["message"])


def test_the_config_library_wins_over_the_vault(vault: Path, env: dict[str, str], tmp_path: Path) -> None:
    config = Path(env["XDG_CONFIG_HOME"]) / "pablo" / "casting.json"
    config.parent.mkdir(parents=True)
    config.write_text(json.dumps({"library": str(tmp_path / "shared")}))
    body, code = audition(vault, env, "-n", "1")
    assert code == 0
    assert body["library"] == str(tmp_path / "shared")
    assert (tmp_path / "shared" / "voices" / "cora" / "auditions" / "1.json").exists()


@pytest.mark.skipif(importlib.util.find_spec("mlx_audio") is not None, reason="the `scorers` extra is installed (gate/perform provision it), so the real designer would load")
def test_the_real_toolkit_is_a_refusal_until_the_model_stacks_are_installed(vault: Path, env: dict[str, str]) -> None:
    # No toolkit override: the real one. Its designer imports mlx-audio lazily, which this venv lacks.
    (body, code), _ = run(["audition", "--role", "CORA", "--describe", DESCRIPTION, "--vault", str(vault), "--json"], env)
    assert code == 2, body
    assert "mlx-audio" in str(body["message"])


def test_importing_the_real_adapters_loads_no_model_stack() -> None:
    script = "import sys, pablo_casting.real, pablo_casting.cli; print(sorted(m for m in ('mlx', 'mlx_audio', 'torch', 'speechbrain', 'mlx_whisper') if m in sys.modules))"
    out = subprocess.run([sys.executable, "-c", script], check=True, capture_output=True, text=True).stdout
    assert out.strip() == "[]"


# --- cast (AC2, AC3) --------------------------------------------------------


def test_cast_writes_the_design_card_and_prints_its_hash(vault: Path, env: dict[str, str]) -> None:
    audition(vault, env, "-n", "3")
    body, code = cast(vault, env, 2, "--notes", "picked over 1 and 3")
    assert code == 0, body
    card = json.loads((voice(vault) / "card.json").read_text())
    assert list(card) == CARD_KEYS
    assert list(card["designed"]) == DESIGNED_KEYS
    assert list(card["reference"]) == REFERENCE_KEYS
    assert body["hash"] == card_hash(card)
    assert str(body["hash"]) in str(body["message"])

    record = json.loads((voice(vault) / "auditions" / "2.json").read_text())
    assert card["slug"] == "cora"
    assert card["description"] == DESCRIPTION
    assert card["designed"] == {
        "engine": record["designer"]["engine"],
        "weights_sha256": record["designer"]["weights_sha256"],
        "instruct": record["instruct"],
        "seed": 101,
        "candidate": 2,
    }
    assert card["traits"] == {"gender": "f", "age": "30s", "pitch": "low-medium", "register": "dry", "roles": ["lead"]}
    assert card["embedding"] == {"model": "fake/spectrum-embedder", "file": "embedding.ecapa.npy"}
    assert card["admitted"]["by"] == "tester" and card["admitted"]["gates"] == "pass"
    assert card["gates"] == {"sim_min": 0.62, "utmos_min": 3.8}
    assert card["pace"]["band"] == [2.4, 3.4] and 2.4 <= card["pace"]["wps"] <= 3.4
    assert card["notes"] == "picked over 1 and 3"
    assert card["by"] == "tester"
    assert (voice(vault) / "reference.txt").read_text().strip() == PASSAGE
    embedding = np.load(voice(vault) / "embedding.ecapa.npy")
    assert embedding.shape == (192,)


def test_the_reference_is_24k_mono_flac_trimmed_by_the_aligner(vault: Path, env: dict[str, str]) -> None:
    # A 48 kHz designer with long silences either side: the card still gets 24 kHz, trimmed to the words.
    designer = FakeDesigner(name="qwen3", rate=48_000, lead=2.0, tail=3.0)
    audition(vault, env, "-n", "1", designer=designer)
    body, code = cast(vault, env, 1, designer=designer)
    assert code == 0, body
    info = sf.info(str(voice(vault) / "reference.flac"))
    assert info.format == "FLAC"
    assert info.samplerate == 24_000
    assert info.channels == 1
    assert 20.0 <= info.duration <= 30.0
    raw = sf.info(str(voice(vault) / "auditions" / "1.wav")).duration
    assert raw - info.duration > 4.5  # most of the 5 s of silence is gone
    card = json.loads((voice(vault) / "card.json").read_text())
    assert card["reference"]["sample_rate"] == 24_000
    assert card["reference"]["seconds"] == pytest.approx(info.duration, abs=0.01)


def test_git_status_shows_only_the_card_files_as_new(vault: Path, env: dict[str, str]) -> None:
    git(vault, "init", "-q")
    (vault / "README.md").write_text("vault\n")
    git(vault, "add", "README.md")
    git(vault, "commit", "-q", "-m", "init")

    # First use also writes the library .gitignore, which the vault then tracks.
    audition(vault, env, "-n", "2")
    assert cast(vault, env, 1)[1] == 0
    first = sorted(git(vault, "status", "--porcelain", "-uall").splitlines())
    assert first == sorted(["?? casting/.gitignore", *(f"?? casting/voices/cora/{name}" for name in CARD_FILES)])
    git(vault, "add", "casting")
    git(vault, "commit", "-q", "-m", "cora")

    audition(vault, env, "-n", "2", role="EDWIN")
    assert cast(vault, env, 2, role="EDWIN")[1] == 0
    second = sorted(git(vault, "status", "--porcelain", "-uall").splitlines())
    assert second == sorted(f"?? casting/voices/edwin/{name}" for name in CARD_FILES)


def test_cast_refuses_an_existing_card_without_recast(vault: Path, env: dict[str, str]) -> None:
    audition(vault, env, "-n", "2")
    cast(vault, env, 1)
    before = (voice(vault) / "card.json").read_bytes()
    body, code = cast(vault, env, 2)
    assert code == 2
    assert "--recast" in str(body["message"])
    assert (voice(vault) / "card.json").read_bytes() == before


def test_recast_archives_the_old_card_untracked_and_changes_the_hash(vault: Path, env: dict[str, str]) -> None:
    git(vault, "init", "-q")
    designer = FakeDesigner(name="qwen3", pitch=lambda instruct, seed: 110.0 + (seed - 100) * 40.0)
    audition(vault, env, "-n", "2", designer=designer)
    old, _ = cast(vault, env, 1, designer=designer)
    old_files = {name: (voice(vault) / name).read_bytes() for name in CARD_FILES}

    new, code = cast(vault, env, 2, "--recast", designer=designer)
    assert code == 0, new
    assert new["hash"] != old["hash"]
    assert new["previous_hash"] == old["hash"]
    archived = Path(str(new["archived"]))
    assert archived.parent == voice(vault) / "recast"
    assert {name: (archived / name).read_bytes() for name in CARD_FILES} == old_files
    # git ignores the archive (and auditions): only card files can ever be tracked.
    assert git(vault, "check-ignore", str(archived / "card.json")).strip() != ""
    untracked = git(vault, "status", "--porcelain", "-uall").splitlines()
    assert not any("recast/" in line or "auditions/" in line for line in untracked)


def test_cast_refuses_a_missing_candidate(vault: Path, env: dict[str, str]) -> None:
    audition(vault, env, "-n", "2")
    body, code = cast(vault, env, 9)
    assert code == 2
    assert "no audition candidate 9" in str(body["message"])
    assert body["missing"]


def test_there_is_no_from_wav(vault: Path, env: dict[str, str], tmp_path: Path) -> None:
    recording = tmp_path / "me.wav"
    sf.write(str(recording), np.zeros(24_000 * 25, dtype=np.float32), 24_000)
    body, code = call(["cast", "--role", "CORA", "--from-wav", str(recording), "--vault", str(vault)], env)
    assert code == 2
    assert "synthetic only" in str(body["message"])
    assert not (vault / "casting").exists()


def test_a_wav_swapped_into_auditions_cannot_become_a_card(vault: Path, env: dict[str, str]) -> None:
    audition(vault, env, "-n", "1")
    wav = voice(vault) / "auditions" / "1.wav"
    audio, rate = sf.read(str(wav))
    sf.write(str(wav), audio * 0.5, rate)  # any other audio, same name
    body, code = cast(vault, env, 1)
    assert code == 2
    assert "not the audio the designer rendered" in str(body["message"])
    assert not (voice(vault) / "card.json").exists()


@pytest.mark.parametrize(("wps", "needle"), [(4.5, "under 20"), (2.2, "over 30")])
def test_a_reference_outside_20_to_30_seconds_is_refused(vault: Path, env: dict[str, str], wps: float, needle: str) -> None:
    designer = FakeDesigner(name="qwen3", wps=wps)
    body, _ = audition(vault, env, "-n", "1", designer=designer)
    assert body["candidates"][0]["reference_ok"] is False  # type: ignore[index]
    body, code = cast(vault, env, 1, designer=designer)
    assert code == 2
    assert needle in str(body["message"])
    assert not (voice(vault) / "card.json").exists()


def test_a_card_needs_a_gender(vault: Path, env: dict[str, str]) -> None:
    call(["audition", "--role", "CORA", "--describe", DESCRIPTION, "-n", "1", "--vault", str(vault)], env)
    body, code = cast(vault, env, 1)
    assert code == 2
    assert "gender" in str(body["message"])
    body, code = cast(vault, env, 1, "--traits", '{"gender": "f"}')
    assert code == 0, body


def test_cast_receipt(vault: Path, env: dict[str, str], tmp_path: Path) -> None:
    work = tmp_path / "work"
    work.mkdir()
    audition(vault, env, "-n", "1")
    body, _ = cast(vault, env, 1, "--work", str(work))
    receipt = json.loads((work / ".pablo" / "casting" / "receipts.jsonl").read_text().splitlines()[-1])
    assert receipt["intent"] == "cast"
    assert receipt["card_hash"] == body["hash"]


# --- the card hash (AC4) ------------------------------------------------------


def test_the_card_hash_changes_when_the_reference_changes(vault: Path, env: dict[str, str]) -> None:
    audition(vault, env, "-n", "1")
    body, _ = cast(vault, env, 1)
    card = json.loads((voice(vault) / "card.json").read_text())
    assert card_hash(card) == body["hash"]
    assert card_hash(json.loads(json.dumps(card))) == body["hash"]  # stable across a re-read

    changed = json.loads(json.dumps(card))
    changed["reference"]["sha256"] = "f" * 64
    assert card_hash(changed) != body["hash"]

    reformatted = voice(vault) / "card.json"
    reformatted.write_text(json.dumps(card, indent=4, sort_keys=True))
    assert Library(vault / "casting").show("cora")["hash"] == body["hash"]  # whitespace and key order are not identity


def test_the_same_inputs_reproduce_the_same_card_bytes(tmp_path: Path, env: dict[str, str]) -> None:
    hashes = []
    for name in ("a", "b"):
        root = tmp_path / name
        root.mkdir()
        audition(root, env, "-n", "1")
        cast(root, env, 1)
        hashes.append(json.loads((voice(root) / "card.json").read_text())["reference"]["sha256"])
    assert hashes[0] == hashes[1]


# --- voices list | show | retire --------------------------------------------


def test_voices_list_and_show(vault: Path, env: dict[str, str]) -> None:
    audition(vault, env, "-n", "2")
    cast(vault, env, 1)
    audition(vault, env, "-n", "1", role="EDWIN")  # auditioned, not cast yet
    body, code = call(["voices", "list", "--vault", str(vault)], env)
    assert code == 0
    rows = {row["slug"]: row for row in body["voices"]}  # type: ignore[union-attr]
    assert rows["cora"]["cast"] is True and rows["cora"]["retired"] is False and rows["cora"]["auditions"] == 2
    assert rows["edwin"] == {"slug": "edwin", "cast": False, "auditions": 1}

    body, code = call(["voices", "show", "cora", "--vault", str(vault)], env)
    assert code == 0
    assert body["reference_intact"] is True
    assert body["hash"] == rows["cora"]["hash"]
    assert body["auditions"] == [1, 2]


def test_voices_show_notices_a_changed_reference(vault: Path, env: dict[str, str]) -> None:
    audition(vault, env, "-n", "1")
    cast(vault, env, 1)
    reference = voice(vault) / "reference.flac"
    audio, rate = sf.read(str(reference))
    sf.write(str(reference), audio * 0.5, rate, format="FLAC")
    body, _ = call(["voices", "show", "cora", "--vault", str(vault)], env)
    assert body["reference_intact"] is False


def test_voices_list_auto_admitted(vault: Path, env: dict[str, str]) -> None:
    audition(vault, env, "-n", "1")
    cast(vault, env, 1)
    audition(vault, env, "-n", "1", role="RAMON")
    cast(vault, env, 1, "--by", "auto", "--traits", '{"gender": "m"}', role="RAMON")
    body, _ = call(["voices", "list", "--auto-admitted", "--vault", str(vault)], env)
    assert [row["slug"] for row in body["voices"]] == ["ramon"]  # type: ignore[union-attr]


def test_retire_marks_a_voice_unmatchable_without_changing_its_hash(vault: Path, env: dict[str, str]) -> None:
    audition(vault, env, "-n", "1")
    cast_body, _ = cast(vault, env, 1)
    files_before = {name: (voice(vault) / name).read_bytes() for name in CARD_FILES if name != "card.json"}

    body, code = call(["voices", "retire", "cora", "--reason", "too like edwin", "--vault", str(vault)], env)
    assert code == 0, body
    assert body["changed"] is True
    assert body["hash"] == cast_body["hash"]  # a story's pin still matches
    card = json.loads((voice(vault) / "card.json").read_text())
    assert card["retired"]["reason"] == "too like edwin" and card["retired"]["by"] == "tester"
    assert {name: (voice(vault) / name).read_bytes() for name in files_before} == files_before

    listed, _ = call(["voices", "list", "--vault", str(vault)], env)
    assert listed["voices"][0]["retired"] is True  # type: ignore[index]

    again, code = call(["voices", "retire", "cora", "--vault", str(vault)], env)
    assert code == 0 and again["changed"] is False
    assert json.loads((voice(vault) / "card.json").read_text())["retired"] == card["retired"]


def test_voices_refusals(vault: Path, env: dict[str, str]) -> None:
    body, code = call(["voices", "retire", "nobody", "--vault", str(vault)], env)
    assert code == 2 and "no voice" in str(body["message"])
    body, code = call(["voices", "show", "--vault", str(vault)], env)
    assert code == 2 and body["missing"] == ["slug"]
    body, code = call(["voices", "show", "../etc", "--vault", str(vault)], env)
    assert code == 2 and "slug" in str(body["message"])
    body, code = call(["voices", "dance", "--vault", str(vault)], env)
    assert code == 1


def test_voices_list_on_an_empty_library(vault: Path, env: dict[str, str]) -> None:
    body, code = call(["voices", "list", "--vault", str(vault)], env)
    assert code == 0 and body["voices"] == []


# --- the real designers, by hand only -----------------------------------------


@pytest.mark.models
@pytest.mark.parametrize("designer", ["qwen3", "voxcpm2"])
def test_real_designer_renders_the_passage(designer: str, tmp_path: Path) -> None:
    """Loads real weights. `uv run pytest -m models` on the Studio, with the model stacks installed."""
    from pablo_casting.real import real_toolkit
    import os

    toolkit = real_toolkit(dict(os.environ), {})
    audio, rate = toolkit.designer(designer).render(DESCRIPTION, PASSAGE, 7)
    assert rate in (24_000, 48_000)
    assert 15.0 <= len(audio) / rate <= 40.0
    shutil.rmtree(tmp_path, ignore_errors=True)
