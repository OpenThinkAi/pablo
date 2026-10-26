"""A human mix rebased onto a new manifest after `fix` (AGT-2153, D-19; the rule is AGT-1772's). Model-free.

Every line, cue and voice here is invented (`test_mix`'s sine-tone takes and fake cues); nothing comes from a real work.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from test_mix import SCRIPT, ENGINE, ToneEngine, cue, cues_dir, mixed, performed, proposal, take_for, work  # noqa: F401 (fixtures)
from test_mixdoc import clip

from pablo_casting.manifest import flags_path, read_version, write_version
from pablo_casting.mixdoc import mix_versions, read_mix
from pablo_casting.takes import Direction, Line, TakeInputs, record_take


CUES = [cue("SFX", "A door creaks", 1), cue("BED", "Rain on a tin roof", 2)]


def longer_take(work: Path, i: int, text: str) -> str:
    """A fresh take of line `i` reading `text` (more words than the script's: a longer take)."""
    speaker, _ = SCRIPT[i]
    inputs = TakeInputs(engine=ENGINE, voice=f"card-{speaker.lower()}", lines=(Line(speaker, text),), seed=99, direction=Direction())
    return record_take(work, ToneEngine(), inputs, attempt=1)[0].key


def human_mix(work: Path, cues_dir: Path) -> dict[str, object]:
    """Performed, auto-mixed, then edited by hand into mix.v2 (by: human): gain, a fade, a moved clip, a muted track."""
    performed(work, cues=CUES)
    mixed(work, cues_dir)
    human = copy.deepcopy(read_mix(work, 1, 1))
    clip(human, "line-3")["gain"] = -6.0
    clip(human, "line-1")["fade_in"] = {"len": 0.3, "curve": "scurve"}
    clip(human, "line-2")["anchor"]["offset"] += 0.5  # type: ignore[index]
    human["tracks"]["music"]["mute"] = True  # type: ignore[index]
    from pablo_casting.mixdoc import write_mix

    return write_mix(work, 1, human, by="human").document


def retake(work: Path, i: int, key: str) -> dict[str, object]:
    """Manifest v2 as `fix` writes it: line `i` re-taken with `key`, nothing else touched."""
    flags_path(work).write_text(json.dumps({"flags": [{"id": "f-1", "episode": 1, "line": i, "reason": "flat"}]}))
    fixed = proposal(work, cues=CUES)
    for line in fixed["lines"]:  # type: ignore[union-attr]
        if line["i"] == i:
            line["take"] = key
    return write_version(work, 1, fixed, flags_applied=["f-1"]).manifest


def test_a_retake_keeps_every_edit_and_drops_the_new_take_into_the_same_slot(work: Path, cues_dir: Path) -> None:
    human = human_mix(work, cues_dir)
    before = read_version(work, 1, 1)
    key = longer_take(work, 1, "The fog is in and thick tonight.")  # 7 words to the script's 4: 1.2 s longer
    retake(work, 1, key)

    body = mixed(work, cues_dir)
    assert (body["mixWritten"], body["mixBy"], body["rebasedMix"], body["supersededMix"], body["review"]) == (True, "human", 2, None, [])
    assert "rebased mix.v2 onto manifest v2: line(s) 1 re-taken" in str(body["message"])
    doc = read_mix(work, 1, 3)
    assert (doc["by"], doc["parent"], doc["manifest_version"]) == ("human", 2, 2)
    assert doc["rebase"] == {"from": 2, "manifest_from": 1, "retaken": [1], "review": []}
    # every other clip, every track setting and the master are byte for byte the human's
    for track in ("dialogue", "sfx", "beds", "music"):
        for lane, body_ in doc["tracks"][track]["lanes"].items():  # type: ignore[index]
            for c in body_["clips"]:
                if c["id"] != "line-1":
                    assert c == clip(human, c["id"]), c["id"]
        assert {k: v for k, v in doc["tracks"][track].items() if k != "lanes"} == {k: v for k, v in human["tracks"][track].items() if k != "lanes"}  # type: ignore[index, union-attr]
    assert doc["master"] == human["master"]
    # the re-taken line: same slot, new take, whole, its fade and gain as they were
    was, now = clip(human, "line-1"), clip(doc, "line-1")
    assert now["source"]["key"] == key and was["source"]["key"] != key  # type: ignore[index]
    assert (now["anchor"], now["gain"], now["fade_in"], now["in"]) == (was["anchor"], was["gain"], was["fade_in"], 0.0)
    assert now["out"] == pytest.approx(was["out"] + 1.2, abs=0.01)  # type: ignore[arg-type]
    # downstream clips ride their anchors: the SFX cued after line 1 moves by the extra 1.2 s, and lines 2 and 3 by
    # that plus the 0.5 s the author moved line 2 (against the auto mix, the only render before this one)
    after = read_version(work, 1, 2)
    shifts = [round(a["start"] - b["start"], 2) for a, b in zip(after["lines"], before["lines"])]  # type: ignore[index]
    assert shifts == [0.0, 0.0, 1.7, 1.7]
    assert after["cues"][0]["start"] - before["cues"][0]["start"] == pytest.approx(1.2, abs=0.01)  # type: ignore[index]
    assert read_mix(work, 1, 2) == human  # never rewritten


def test_a_second_plain_mix_keeps_the_rebased_document(work: Path, cues_dir: Path) -> None:
    human_mix(work, cues_dir)
    retake(work, 1, take_for(work, 1, attempt=1))
    mixed(work, cues_dir)
    body = mixed(work, cues_dir)
    assert (body["mixWritten"], body["mixBy"], body["rebasedMix"]) == (False, "human", None)
    assert mix_versions(work, 1) == [1, 2, 3]


def test_a_trim_is_carried_as_seconds_cut_from_the_new_take_and_reset_when_it_does_not_fit(work: Path, cues_dir: Path) -> None:
    human = human_mix(work, cues_dir)
    trimmed = copy.deepcopy(human)
    clip(trimmed, "line-1")["in"] = 0.2
    clip(trimmed, "line-1")["out"] = clip(trimmed, "line-1")["out"] - 0.1  # type: ignore[operator]
    from pablo_casting.mixdoc import write_mix

    write_mix(work, 1, trimmed, by="human")  # mix.v3
    retake(work, 1, longer_take(work, 1, "The fog is in and thick tonight."))
    mixed(work, cues_dir)
    now = clip(read_mix(work, 1, 4), "line-1")
    assert now["in"] == pytest.approx(0.2) and now["out"] == pytest.approx(clip(trimmed, "line-1")["out"] + 1.2, abs=0.01)  # type: ignore[operator]

    # a far shorter re-take that the trim swallows whole: reset to the whole take and listed
    shorter = copy.deepcopy(read_mix(work, 1, 4))
    clip(shorter, "line-1")["in"] = clip(shorter, "line-1")["out"] - 0.05  # type: ignore[operator]
    clip(shorter, "line-1")["fade_in"] = {"len": 0.0, "curve": "linear"}
    write_mix(work, 1, shorter, by="human")  # mix.v5
    flags_path(work).write_text(json.dumps({"flags": [{"id": "f-2", "episode": 1, "line": 1, "reason": "rushed"}]}))
    short = proposal(work, cues=CUES)
    short["lines"][1]["take"] = longer_take(work, 1, "Fog.")  # type: ignore[index]
    write_version(work, 1, short, flags_applied=["f-2"])
    body = mixed(work, cues_dir)
    (item,) = body["review"]  # type: ignore[misc]
    assert item["clip"] == "line-1" and "reset to the whole take" in item["problem"] and item["was"] == clip(shorter, "line-1")
    assert (clip(read_mix(work, 1, 6), "line-1")["in"], body["rebasedMix"]) == (0.0, 5)


def test_a_clip_anchored_to_a_line_the_manifest_lost_is_pinned_where_it_sat_and_listed(work: Path, cues_dir: Path) -> None:
    human = human_mix(work, cues_dir)
    pinned = copy.deepcopy(human)
    sfx = clip(pinned, "cue-0")
    sfx["anchor"] = {"line": 3, "edge": "start", "offset": -0.2}  # the door now sounds before the last line
    pinned["tracks"]["beds"]["automation"] = [{"anchor": {"line": 3, "edge": "end", "offset": 0.0}, "db": -6.0, "curve": "linear"}]  # type: ignore[index]
    from pablo_casting.mixdoc import write_mix

    write_mix(work, 1, pinned, by="human")  # mix.v3
    before = read_version(work, 1, 1)
    # the next manifest drops line 3 altogether (the script lost it); the flag names the line that went
    flags_path(work).write_text(json.dumps({"flags": [{"id": "f-1", "episode": 1, "line": 3, "reason": "other"}]}))
    cut = proposal(work, cues=CUES)
    cut["lines"] = cut["lines"][:3]  # type: ignore[index]
    write_version(work, 1, cut, flags_applied=["f-1"])

    body = mixed(work, cues_dir)
    assert (body["mixBy"], body["rebasedMix"], body["supersededMix"]) == ("human", 3, None)
    doc = read_mix(work, 1, 4)
    fields = sorted(item["field"] for item in doc["rebase"]["review"])  # type: ignore[index]
    assert fields == ["tracks.beds.automation[0].anchor", "tracks.dialogue.lanes.MAVIS.clips[1]", "tracks.sfx.lanes.main.clips[0].anchor"]
    by_field = {item["field"]: item for item in doc["rebase"]["review"]}  # type: ignore[index]
    # the dialogue clip voicing the lost line cannot render: set aside into the list, whole
    gone = by_field["tracks.dialogue.lanes.MAVIS.clips[1]"]
    assert gone["clip"] == "line-3" and gone["was"] == clip(human, "line-3") and "set aside" in gone["problem"]
    with pytest.raises(KeyError):
        clip(doc, "line-3")
    # the SFX and the automation point are pinned where they sat (seconds), not dropped: line 3's clip began 0.1 s
    # before its first word in the auto mix and 0.5 s later in the human one (line 2 was moved), less the 0.2 s offset
    assert clip(doc, "cue-0")["anchor"] == {"at": pytest.approx(before["lines"][3]["start"] - 0.1 + 0.5 - 0.2, abs=0.02)}  # type: ignore[index]
    assert "pinned at" in by_field["tracks.sfx.lanes.main.clips[0].anchor"]["problem"]
    (point,) = doc["tracks"]["beds"]["automation"]  # type: ignore[index]
    assert "at" in point["anchor"] and point["db"] == -6.0
    assert "3 item(s) for review" in str(body["message"]) and str(body["message"]).endswith("in the mixer")
    # unchanged lines keep their edits
    assert clip(doc, "line-2") == clip(human, "line-2")


def test_a_cue_clip_whose_cue_the_manifest_lost_keeps_its_sound_without_the_index(work: Path, cues_dir: Path) -> None:
    human_mix(work, cues_dir)
    flags_path(work).write_text(json.dumps({"flags": [{"id": "f-1", "episode": 1, "line": 1, "reason": "flat"}]}))
    fixed = proposal(work, cues=[cue("SFX", "A door creaks", 1)])  # the bed cue is gone from the script
    fixed["lines"][1]["take"] = take_for(work, 1, attempt=1)  # type: ignore[index]
    write_version(work, 1, fixed, flags_applied=["f-1"])
    body = mixed(work, cues_dir)
    doc = read_mix(work, 1, 3)
    beds = doc["tracks"]["beds"]["lanes"]["main"]["clips"]  # type: ignore[index]
    assert beds and all("cue" not in c for c in beds) and all(c["source"]["kind"] == "cue" for c in beds)
    assert all("places cue 1, which manifest v2 does not have" in item["problem"] for item in body["review"])  # type: ignore[union-attr]
    assert len(body["review"]) == len(beds)  # type: ignore[arg-type]


def test_auto_still_sets_a_human_mix_aside(work: Path, cues_dir: Path) -> None:
    from pablo_casting.mix import MixRequest, mix
    from test_mix import seams

    human_mix(work, cues_dir)
    retake(work, 1, take_for(work, 1, attempt=1))
    s, _ = seams()
    body, code = mix(MixRequest(work=work, episode=1, cues_dir=cues_dir, auto=True), s)
    assert code == 0 and (body["mixBy"], body["supersededMix"], body["rebasedMix"]) == ("auto", 2, None)
