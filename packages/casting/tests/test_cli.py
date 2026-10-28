"""The exit-code contract (0 ok, 2 refused, 1 error) for every command, model-free."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from pablo_casting.cli import main, run

PIN = "0123456789abcdef0123456789abcdef01234567"


@pytest.fixture
def env(tmp_path: Path) -> dict[str, str]:
    """An environment whose config and HF cache are throwaway directories."""
    return {
        "HOME": str(tmp_path / "home"),
        "XDG_CONFIG_HOME": str(tmp_path / "config"),
        "HF_HUB_CACHE": str(tmp_path / "hf"),
    }


def write_config(env: dict[str, str], body: object) -> Path:
    path = Path(env["XDG_CONFIG_HOME"]) / "pablo" / "casting.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body) if not isinstance(body, str) else body, encoding="utf-8")
    return path


def test_version_is_ok(env: dict[str, str]) -> None:
    (body, code), _ = run(["version", "--json"], env)
    assert code == 0
    assert body["ok"] is True
    assert isinstance(body["version"], str)
    assert str(body["python"]).startswith("3.12")


def test_doctor_without_a_config_reports_defaults_and_downloads_nothing(env: dict[str, str]) -> None:
    def no_download(model_id: str, revision: str | None) -> str:
        raise AssertionError("doctor must never download")

    (body, code), _ = run(["doctor", "--json"], env, downloader=no_download)
    assert code == 0
    config = body["config"]
    assert isinstance(config, dict)
    assert config["exists"] is False
    assert config["weights"] == []
    assert config["path"] == str(Path(env["XDG_CONFIG_HOME"]) / "pablo" / "casting.json")
    assert body["weights"] == []


def test_doctor_reports_whether_each_configured_weight_is_cached(env: dict[str, str]) -> None:
    write_config(env, {"weights": ["org/cached", "org/missing", {"id": "org/pinned", "revision": PIN}]})
    snapshot = Path(env["HF_HUB_CACHE"]) / "models--org--cached" / "snapshots" / "abc"
    snapshot.mkdir(parents=True)
    # A pinned entry is cached only at its own revision.
    (Path(env["HF_HUB_CACHE"]) / "models--org--pinned" / "snapshots" / "abc").mkdir(parents=True)
    (body, code), _ = run(["doctor", "--json"], env)
    assert code == 0
    assert body["weights"] == [
        {"id": "org/cached", "revision": None, "cached": True},
        {"id": "org/missing", "revision": None, "cached": False},
        {"id": "org/pinned", "revision": PIN, "cached": False},
    ]
    assert body["config"]["weights"][2] == {"id": "org/pinned", "revision": PIN}


@pytest.mark.parametrize(
    "config",
    [
        "{not json",
        "[]",
        {"weights": "org/one"},
        {"weights": [{"revision": PIN}]},
        {"weights": [{"id": "org/one", "revision": 3}]},
        {"weights": [{"id": "org/one", "rev": PIN}]},
        {"engines": {"dia": 3}}, {"pace": {"default": -1}}, {"library": 4}],
)
def test_an_unusable_config_is_a_refusal_naming_the_file(env: dict[str, str], config: object) -> None:
    path = write_config(env, config)
    (body, code), _ = run(["doctor", "--json"], env)
    assert code == 2
    assert body["ok"] is False
    assert body["code"] == 2
    assert str(path) in str(body["message"])


def test_unknown_command_and_bad_flags_are_errors_not_refusals(env: dict[str, str]) -> None:
    for argv in (["nope", "--json"], ["--json"], ["doctor", "--bogus", "--json"]):
        (body, code), _ = run(argv, env)
        assert code == 1, argv
        assert body["ok"] is False
        assert body["code"] == 1


def test_a_missing_work_directory_is_a_refusal(env: dict[str, str], tmp_path: Path) -> None:
    (body, code), _ = run(["pull", "--json", "--work", str(tmp_path / "absent")], env)
    assert code == 2
    assert body["missing"] == [str(tmp_path / "absent")]


def test_audition_dry_run_loads_no_model_and_a_real_audition_needs_a_role(env: dict[str, str]) -> None:
    (body, code), _ = run(["audition", "--dry-run", "--json"], env)
    assert code == 0
    assert body["dryRun"] is True
    # AGT-1679: a real audition exists; without --role/--describe it is a refusal naming both.
    (body, code), _ = run(["audition", "--json"], env)
    assert code == 2
    assert body["missing"] == ["--role", "--describe"]


def test_pull_with_no_weights_configured_downloads_nothing(env: dict[str, str], tmp_path: Path) -> None:
    (body, code), _ = run(["pull", "--json", "--work", str(tmp_path)], env, downloader=lambda *_: pytest.fail("no download"))
    assert code == 0
    assert body["weights"] == []
    assert not (tmp_path / ".pablo").exists()


def test_pull_downloads_uncached_weights_and_leaves_a_receipt(env: dict[str, str], tmp_path: Path) -> None:
    write_config(env, {"weights": ["org/model"]})
    work = tmp_path / "work"
    work.mkdir()
    pulled: list[tuple[str, str | None]] = []

    def fake(model_id: str, revision: str | None) -> str:
        pulled.append((model_id, revision))
        return f"/cache/{model_id}"

    (body, code), _ = run(["pull", "--json", "--work", str(work)], env, downloader=fake)
    assert code == 0
    assert pulled == [("org/model", None)]
    lines = (work / ".pablo" / "casting" / "receipts.jsonl").read_text(encoding="utf-8").splitlines()
    receipt = json.loads(lines[0])
    assert receipt["intent"] == "pull"
    assert receipt["weights"] == "org/model"
    assert receipt["revision"] is None
    assert "at" in receipt and "wall" in receipt


def test_pull_passes_a_configured_revision_and_warns_only_for_unpinned_weights(
    env: dict[str, str], capsys: pytest.CaptureFixture[str]
) -> None:
    """AGT-2274: a casting.json entry's `revision` reaches the downloader; one without (or on a branch) warns."""
    write_config(env, {"weights": [{"id": "org/pinned", "revision": PIN}, "org/loose", {"id": "org/branch", "revision": "main"}]})
    pulled: list[tuple[str, str | None]] = []

    def fake(model_id: str, revision: str | None) -> str:
        pulled.append((model_id, revision))
        return f"/cache/{model_id}"

    (body, code), _ = run(["pull", "--json"], env, downloader=fake)
    assert code == 0, body
    assert pulled == [("org/pinned", PIN), ("org/loose", None), ("org/branch", "main")]
    err = capsys.readouterr().err
    warnings = [line for line in err.splitlines() if "warning:" in line]
    assert len(warnings) == 2
    assert "org/loose has no `revision`" in warnings[0] and '"revision": "<commit sha>"' in warnings[0]
    assert 'org/branch is at "main", a branch or tag that can move' in warnings[1]
    assert "org/pinned" not in "\n".join(warnings)


def test_pull_skips_a_pinned_weight_already_cached_at_its_revision(env: dict[str, str]) -> None:
    write_config(env, {"weights": [{"id": "org/pinned", "revision": PIN}]})
    (Path(env["HF_HUB_CACHE"]) / "models--org--pinned" / "snapshots" / PIN).mkdir(parents=True)
    (body, code), _ = run(["pull", "--json"], env, downloader=lambda *_: pytest.fail("no download"))
    assert code == 0
    assert body["weights"] == [{"id": "org/pinned", "revision": PIN, "cached": True}]


def test_a_failed_download_is_an_error(env: dict[str, str]) -> None:
    write_config(env, {"weights": ["org/model"]})

    def broken(model_id: str, revision: str | None) -> str:
        raise OSError("network down")

    (body, code), _ = run(["pull", "--json"], env, downloader=broken)
    assert code == 1
    assert "network down" in str(body["message"])


def test_main_prints_the_body_as_json(env: dict[str, str], capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["version", "--json"], env) == 0
    assert json.loads(capsys.readouterr().out)["ok"] is True


def test_python_dash_m_runs_from_the_venv(env: dict[str, str]) -> None:
    """The real entry point, as pablo runs it: `python -m pablo_casting <command> --json`."""
    for command, expected in (("version", 0), ("doctor", 0), ("nope", 1)):
        completed = subprocess.run(
            [sys.executable, "-m", "pablo_casting", command, "--json"],
            capture_output=True,
            text=True,
            env={**env, "PATH": "/usr/bin:/bin"},
            check=False,
        )
        assert completed.returncode == expected, completed.stderr
        assert json.loads(completed.stdout)["ok"] is (expected == 0)


@pytest.mark.models
def test_pull_downloads_a_real_model_into_the_hf_cache(tmp_path: Path) -> None:  # pragma: no cover - hand-run
    """Hand-run only (`uv run pytest -m models`): a real, tiny download through huggingface_hub."""
    from pablo_casting.cli import _default_downloader

    path = Path(_default_downloader("hf-internal-testing/tiny-random-bert", None))
    assert path.is_dir()
