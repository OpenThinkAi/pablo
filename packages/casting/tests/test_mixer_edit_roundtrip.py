"""The mixer's edits survive a save and a reload (AGT-1769, ACs 1 and 2). Model-free.

`fixtures/mix-edit-roundtrip.json` is written by the window's editing model (`packages/cli/test/mixer-edit.test.ts`):
the golden mix (`base`), the same mix after the AC1 edits made through `views/mixer-edit.ts` (`edited`: a bed
trimmed and faded out under a line, a bed split into two clips over one source with the second half pulled down,
KEEPER's line moved to overlap TOLLER's, the beds track turned down), and where the window places every edited clip
(`placement`, samples). Here that document goes through `mixer save` as the window sends it, comes back through
`mixer load`, and `mix.py` places every clip on the same samples the window did.
"""

from __future__ import annotations

import json
from pathlib import Path

from test_mixer_view_parity import compute

from pablo_casting.manifest import episode_dir
from pablo_casting.mixdoc import mix_versions, read_mix, write_mix
from pablo_casting.mixer import cmd_load, cmd_save

FIXTURE = Path(__file__).parent / "fixtures" / "mix-edit-roundtrip.json"


def episode(tmp_path: Path, base: dict[str, object]) -> Path:
    """A work whose episode 1 has the manifest the golden mix was made against, and the golden mix as v1."""
    work = tmp_path / "work"
    root = episode_dir(work, 1)
    root.mkdir(parents=True)
    lines = [{"i": i, "speaker": speaker, "text": f"line {i}", "take": "0" * 64, "stretch": 1.0, "start": None, "end": None} for i, speaker in enumerate(["KEEPER", "TOLLER", "KEEPER", "KEEPER"])]
    cues = [{"kind": kind, "desc": desc, "key": None, "after": 1} for kind, desc in (("SFX", "a gull"), ("BED", "the porch"), ("MUSIC", "the sting"))]
    (root / "v1.json").write_text(json.dumps({"version": 1, "episode": 1, "lines": lines, "cues": cues, "duration": None}))
    write_mix(work, 1, {"manifest_version": base["manifest_version"], "tracks": base["tracks"], "master": base["master"]}, by="auto")
    return work


def test_the_edited_mix_saves_and_reloads_to_the_same_document_and_placement(tmp_path: Path) -> None:
    fixture = json.loads(FIXTURE.read_text())
    work = episode(tmp_path, fixture["base"])
    sent = tmp_path / "proposal.json"
    sent.write_text(json.dumps(fixture["edited"]))

    body, code = cmd_save(work, 1, 1, str(sent))
    assert code == 0, body
    assert (body["version"], body["parent"], body["by"]) == (2, 1, "human")
    summary = body["summary"]
    assert summary["added"] == ["bed-b.2"] and summary["removed"] == []  # type: ignore[index]
    assert summary["changed"] == ["bed-a", "bed-b", "line-2"] and summary["tracks"] == ["beds"]  # type: ignore[index]

    loaded, code = cmd_load(work, 1, None)
    assert code == 0 and loaded["version"] == 2
    doc = loaded["document"]
    assert doc["tracks"] == fixture["edited"]["tracks"]  # type: ignore[index]
    assert doc["master"] == fixture["edited"]["master"]  # type: ignore[index]
    assert compute(doc)["placement"] == fixture["placement"]  # type: ignore[arg-type]
    assert read_mix(work, 1, 1)["tracks"] == fixture["base"]["tracks"]  # v1 untouched


def test_a_second_save_from_the_same_base_is_refused_as_stale(tmp_path: Path) -> None:
    fixture = json.loads(FIXTURE.read_text())
    work = episode(tmp_path, fixture["base"])
    sent = tmp_path / "proposal.json"
    sent.write_text(json.dumps(fixture["edited"]))
    assert cmd_save(work, 1, 1, str(sent))[1] == 0
    body, code = cmd_save(work, 1, 1, str(sent))
    assert code == 2 and body["stale"] is True and "is not the newest" in str(body["message"])
    assert mix_versions(work, 1) == [1, 2]
