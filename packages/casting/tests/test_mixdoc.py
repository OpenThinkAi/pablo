"""The mix document (AGT-1764): auto mix as `mix.v1`, validation naming the field, hand edits rendered. Model-free.

Every line, cue and voice here is invented (the takes and cues are sine tones
from `test_mix`'s fakes); nothing comes from a real work.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import numpy as np
import soundfile as sf
import pytest
from test_mix import FakeCues, cue, cues_dir, fake_pacer, final_audio, mixed, performed, proposal, rms, seams, take_for, tree, work  # noqa: F401 (fixtures)

from pablo_casting.cli import run
from pablo_casting.cues import CueLibrary
from pablo_casting.manifest import episode_dir, flags_path, read_version, write_version
from pablo_casting.mix import SR, MixRequest, Sources, auto_document, mix, render_document
from pablo_casting.mixdoc import MixDocError, check_against, mix_path, mix_versions, read_mix, validate, write_mix


from test_stream import Factory, go, segments_audio, setup  # noqa: E402,F401 (setup: a fixture)

from pablo_casting.mix import Timeline  # noqa: E402


def clip(doc: dict[str, object], clip_id: str) -> dict[str, object]:
    for track in doc["tracks"].values():  # type: ignore[union-attr]
        for lane in track["lanes"].values():
            for c in lane["clips"]:
                if c["id"] == clip_id:
                    return c  # type: ignore[no-any-return]
    raise KeyError(clip_id)


def write_doc(tmp_path: Path, doc: dict[str, object], name: str = "edit.json") -> Path:
    path = tmp_path / name
    path.write_text(json.dumps(doc))
    return path


def lines_of(work: Path, version: int) -> list[dict[str, object]]:
    return read_version(work, 1, version)["lines"]  # type: ignore[return-value]


# --- AC1: the auto mix is mix.v1, by auto, and renders today's timeline -------------------------------


def test_the_first_mix_writes_mix_v1_by_auto_expressing_the_rules_as_clips(work: Path, cues_dir: Path) -> None:
    performed(work, cues=[cue("MUSIC", "A brass sting", -1), cue("SFX", "A door creaks", 0), cue("BED", "Rain on a tin roof", 1), cue("BED", "off", 2)])
    body = mixed(work, cues_dir)

    assert (body["mixWritten"], body["mixBy"], body["supersededMix"]) == (True, "auto", None)
    assert mix_versions(work, 1) == [1] and body["mixDocument"] == str(mix_path(work, 1, 1))
    doc = read_mix(work, 1, 1)
    assert (doc["schema"], doc["episode"], doc["version"], doc["manifest_version"], doc["parent"], doc["by"]) == (1, 1, 1, 1, None, "auto")
    assert validate(doc) == []
    tracks = doc["tracks"]
    # one dialogue lane per role, one clip per line, each voicing its own line with the manifest's take
    assert sorted(tracks["dialogue"]["lanes"]) == ["ANNOUNCER", "MAVIS", "OTTO"]  # type: ignore[index]
    v1 = read_version(work, 1, 1)
    for line in v1["lines"]:  # type: ignore[union-attr]
        c = clip(doc, f"line-{line['i']}")
        assert c["lines"] == [line["i"]] and c["source"] == {"kind": "take", "key": line["take"], "stretch": 1.0}
    # the rules as anchors: the music opens the episode, line 0 waits for it, the SFX starts 0.4 s early over line 0's air
    music, line0, sfx, line1 = clip(doc, "cue-0"), clip(doc, "line-0"), clip(doc, "cue-1"), clip(doc, "line-1")
    assert music["anchor"] == {"at": 0.0} and music["gain"] == pytest.approx(20 * np.log10(0.9), abs=1e-5)
    assert line0["anchor"]["at"] == pytest.approx(music["out"] + 0.2, abs=1e-4)  # type: ignore[index]
    assert sfx["anchor"] == {"line": 0, "edge": "end", "offset": pytest.approx(0.35 - 0.4, abs=1e-4)}
    assert line1["anchor"] == {"line": 0, "edge": "end", "offset": pytest.approx(0.35 - 0.4 + sfx["out"] + 0.2, abs=1e-4)}  # type: ignore[operator]
    # the bed is tiled from its cue to the `off`, at 0.16 gain, faded in and out
    beds = tracks["beds"]["lanes"]["main"]["clips"]  # type: ignore[index]
    assert len(beds) >= 2 and all(b["cue"] == 2 and b["gain"] == pytest.approx(20 * np.log10(0.16), abs=1e-5) for b in beds)
    assert beds[0]["fade_in"]["len"] > 0 and beds[-1]["fade_out"]["len"] > 0 and beds[0]["fade_out"]["len"] == 0
    assert doc["master"] == {"gain": 0.0, "peak_db": -1.0, "target_lufs": None}
    assert read_version(work, 1, 1)["mix"]["document"] == "mix.v1.json"  # type: ignore[index]


def test_rendering_the_written_mix_v1_reproduces_the_episode_file(work: Path, cues_dir: Path) -> None:
    performed(work, cues=[cue("SFX", "A door creaks", 0), cue("BED", "Rain on a tin roof", 1)], stretch={1: 1.2})
    mixed(work, cues_dir)
    audio, _ = final_audio(work)
    manifest = read_version(work, 1, 1)
    again = render_document(manifest, read_mix(work, 1, 1), Sources(work, CueLibrary(cues_dir, lambda kind: FakeCues()), fake_pacer))
    # the episode file is 16-bit PCM of the same render
    assert len(again.audio) == len(audio) and float(np.abs(again.audio - audio).max()) < 2 / 32768
    assert [(l["start"], l["end"]) for l in again.lines] == [(l["start"], l["end"]) for l in manifest["lines"]]  # type: ignore[union-attr]


def test_a_remix_renders_the_newest_fitting_document_and_writes_no_new_one(work: Path, cues_dir: Path) -> None:
    performed(work, cues=[cue("SFX", "A door creaks", 0)])
    mixed(work, cues_dir)
    body = mixed(work, cues_dir)
    assert (body["version"], body["mixWritten"], body["mixBy"]) == (2, False, "auto")
    assert mix_versions(work, 1) == [1]
    assert read_version(work, 1, 2)["mix"]["document"] == "mix.v1.json"  # type: ignore[index]
    assert (body["cuesGenerated"], body["cuesReused"]) == (0, 1)


def test_a_retaken_line_gets_a_new_auto_mix_and_a_human_mix_is_named_not_dropped(work: Path, cues_dir: Path, tmp_path: Path) -> None:
    performed(work)
    mixed(work, cues_dir)
    human = copy.deepcopy(read_mix(work, 1, 1))
    clip(human, "line-3")["gain"] = -6.0
    write_mix(work, 1, human, by="human")  # mix.v2, by human
    flags_path(work).write_text(json.dumps({"flags": [{"id": "f-1", "episode": 1, "line": 1, "reason": "flat"}]}))
    retake = proposal(work)
    retake["lines"][1]["take"] = take_for(work, 1, attempt=1)  # type: ignore[index]
    write_version(work, 1, retake, flags_applied=["f-1"])

    body = mixed(work, cues_dir)
    assert (body["mixWritten"], body["mixBy"], body["supersededMix"]) == (True, "auto", 2)
    assert "mix.v2.json (by: human)" in str(body["message"])
    doc = read_mix(work, 1, 3)
    assert (doc["parent"], doc["manifest_version"], doc["by"]) == (2, 2, "auto")
    assert clip(doc, "line-1")["source"]["key"] == retake["lines"][1]["take"]  # type: ignore[index]
    assert read_mix(work, 1, 2)["by"] == "human"  # never rewritten


def test_a_valid_newest_document_anchored_to_a_line_the_manifest_lacks_gives_way_to_the_auto_mix(work: Path, cues_dir: Path) -> None:
    performed(work)
    mixed(work, cues_dir)
    stale = copy.deepcopy(read_mix(work, 1, 1))
    stale["tracks"]["sfx"]["automation"] = [{"anchor": {"line": 42, "edge": "end", "offset": 0.0}, "db": -6.0, "curve": "linear"}]  # type: ignore[index]
    write_mix(work, 1, stale, by="human")
    body = mixed(work, cues_dir)
    assert (body["mixWritten"], body["mixBy"], body["supersededMix"]) == (True, "auto", 2)
    assert mix_versions(work, 1) == [1, 2, 3]


# --- AC2: refusals name the field ------------------------------------------------------------------


@pytest.fixture
def auto_doc(work: Path, cues_dir: Path) -> dict[str, object]:
    performed(work, cues=[cue("SFX", "A door creaks", 0), cue("BED", "Rain on a tin roof", 1)])
    mixed(work, cues_dir)
    return read_mix(work, 1, 1)


def fields(doc: object) -> list[str]:
    return [p.field for p in validate(doc)]


def test_validation_names_each_bad_field(auto_doc: dict[str, object]) -> None:
    def broken(edit) -> list[str]:  # type: ignore[no-untyped-def]
        doc = copy.deepcopy(auto_doc)
        edit(doc)
        return fields(doc)

    lane = "tracks.dialogue.lanes.MAVIS.clips[0]"
    assert broken(lambda d: clip(d, "line-1")["fade_in"].update(curve="wobbly")) == [f"{lane}.fade_in.curve"]
    assert broken(lambda d: clip(d, "line-1").update(gain="loud")) == [f"{lane}.gain"]
    assert broken(lambda d: clip(d, "line-1").update(out=0.0)) == [f"{lane}.out"]
    assert broken(lambda d: clip(d, "line-1").pop("anchor")) == [f"{lane}.anchor"]
    assert broken(lambda d: clip(d, "line-1").update(anchor={"line": 0, "edge": "middle", "offset": 0})) == [f"{lane}.anchor.edge"]
    assert broken(lambda d: clip(d, "line-1").update(anchor={"at": -1.0})) == [f"{lane}.anchor.at"]
    assert broken(lambda d: clip(d, "line-1").update(id="line-0")) == [f"{lane}.id"]
    assert broken(lambda d: clip(d, "line-1").update(lines=[])) == [f"{lane}.lines"]
    assert broken(lambda d: clip(d, "line-1")["source"].update(kind="cue")) == [f"{lane}.source.kind", f"{lane}.source.stretch"]
    assert broken(lambda d: clip(d, "line-1")["source"].update(key="nope")) == [f"{lane}.source.key"]
    assert broken(lambda d: clip(d, "line-1")["fade_out"].update(len=99.0)) == [f"{lane}.fade_out"]
    assert broken(lambda d: d["tracks"].update(reverb={})) == ["tracks.reverb"]
    assert broken(lambda d: d["tracks"].pop("music")) == ["tracks.music"]
    assert broken(lambda d: d["tracks"]["sfx"].update(volume=None)) == ["tracks.sfx.volume"]
    assert broken(lambda d: d["tracks"]["beds"].update(automation=[{"anchor": {"at": 1.0}, "db": -6, "curve": "nope"}])) == ["tracks.beds.automation[0].curve"]
    assert broken(lambda d: d["master"].update(target_lufs=-16)) == ["master.target_lufs"]
    assert broken(lambda d: d.update(by="robot")) == ["by"]
    assert fields([]) == ["(document)"]


def test_a_document_that_does_not_fit_the_manifest_names_the_field(work: Path, auto_doc: dict[str, object]) -> None:
    manifest = read_version(work, 1, 1)
    doc = copy.deepcopy(auto_doc)
    clip(doc, "line-2")["anchor"] = {"line": 42, "edge": "end", "offset": 0.35}
    lanes = doc["tracks"]["dialogue"]["lanes"]  # type: ignore[index]
    lanes["MAVIS"]["clips"] = [c for c in lanes["MAVIS"]["clips"] if c["id"] != "line-3"]
    problems = {p.field: p.problem for p in check_against(doc, manifest)}
    assert set(problems) == {"tracks.dialogue.lanes.OTTO.clips[0].anchor.line", "tracks.dialogue"}
    assert "line 3 has no dialogue clip" in problems["tracks.dialogue"]


def test_a_bad_from_document_is_refused_naming_the_field_and_nothing_is_written(work: Path, cues_dir: Path, auto_doc: dict[str, object], tmp_path: Path) -> None:
    before = tree(work)
    s, _ = seams()
    doc = copy.deepcopy(auto_doc)
    clip(doc, "line-0")["fade_in"]["curve"] = "wobbly"
    argv = ["mix", "--work", str(work), "--episode", "1", "--cues", str(cues_dir), "--json", "--from", str(write_doc(tmp_path, doc))]
    (body, code), _ = run(argv, mixer=s)
    assert code == 2 and body["field"] == "tracks.dialogue.lanes.ANNOUNCER.clips[0].fade_in.curve"
    assert "fade_in.curve" in str(body["message"])
    # render-time refusals: a slice past the end of its source, a cycle, a clip before the start
    for edit, field in (
        (lambda d: clip(d, "line-0").update(out=99.0), "tracks.dialogue.lanes.ANNOUNCER.clips[0].out"),
        (lambda d: clip(d, "line-0").update(anchor={"line": 1, "edge": "start", "offset": 0.0}), "anchor"),
        (lambda d: clip(d, "line-0").update(anchor={"line": 1, "edge": "start", "offset": -500.0}) or clip(d, "line-1").update(anchor={"at": 1.0}), "tracks.dialogue.lanes.ANNOUNCER.clips[0].anchor"),
    ):
        doc = copy.deepcopy(auto_doc)
        edit(doc)
        argv[-1] = str(write_doc(tmp_path, doc))
        (body, code), _ = run(argv, mixer=s)
        assert code == 2 and str(body["field"]).endswith(field), body
    (body, code), _ = run([*argv[:-1], str(tmp_path / "missing.json")], mixer=s)
    assert code == 1
    assert tree(work) == before


def test_a_hand_edit_in_place_that_breaks_the_document_is_refused(work: Path, cues_dir: Path, auto_doc: dict[str, object]) -> None:
    clip(auto_doc, "line-1")["gain"] = "loud"
    mix_path(work, 1, 1).write_text(json.dumps(auto_doc))
    before = tree(work)
    s, _ = seams()
    body, code = mix(MixRequest(work=work, episode=1, cues_dir=cues_dir), s)
    assert code == 2 and body["field"] == "tracks.dialogue.lanes.MAVIS.clips[0].gain" and "mix.v1.json" in str(body["message"])
    assert tree(work) == before


def test_write_mix_never_rewrites_and_refuses_an_invalid_document(work: Path, auto_doc: dict[str, object]) -> None:
    bad = copy.deepcopy(auto_doc)
    bad["master"] = {"gain": 0.0, "peak_db": 3.0, "target_lufs": None}
    with pytest.raises(MixDocError, match=r"master\.peak_db"):
        write_mix(work, 1, bad, by="human")
    assert mix_versions(work, 1) == [1]
    written = write_mix(work, 1, auto_doc, by="human")
    assert (written.document["version"], written.document["parent"], written.document["by"]) == (2, 1, "human")


# --- AC3: a hand-edited document renders the edit -------------------------------------------------------


def test_a_moved_clip_a_fade_and_a_gain_render_as_edited(work: Path, cues_dir: Path, auto_doc: dict[str, object], tmp_path: Path) -> None:
    base = lines_of(work, 1)
    audio, rate = final_audio(work)
    loud = rms(audio, base[3]["start"] + 0.05, base[3]["end"] - 0.05, rate)  # type: ignore[operator]
    opening = rms(audio, base[0]["start"], base[0]["start"] + 0.4, rate)  # type: ignore[operator]

    doc = copy.deepcopy(auto_doc)
    moved = clip(doc, "line-2")
    moved["anchor"]["offset"] += 1.0  # type: ignore[index]
    clip(doc, "line-0")["fade_in"] = {"len": clip(doc, "line-0")["out"], "curve": "scurve"}
    clip(doc, "line-3")["gain"] = -12.0
    doc["tracks"]["beds"]["mute"] = True  # type: ignore[index]
    s, _ = seams()
    argv = ["mix", "--work", str(work), "--episode", "1", "--cues", str(cues_dir), "--json", "--from", str(write_doc(tmp_path, doc))]
    (body, code), _ = run(argv, mixer=s)
    assert code == 0, body
    assert (body["version"], body["mixWritten"], body["mixBy"]) == (2, True, "human")
    saved = read_mix(work, 1, 2)
    assert (saved["by"], saved["parent"], saved["manifest_version"]) == ("human", 1, 1)

    edited = lines_of(work, 2)
    # the moved line and the line anchored after it slide 1 s; the lines before stay
    assert [round(edited[k]["start"] - base[k]["start"], 3) for k in range(4)] == [0.0, 0.0, 1.0, 1.0]  # type: ignore[operator]
    after, _ = final_audio(work)
    # the gap the move opened holds only the bed (0.16 gain), not a voice
    assert rms(after, base[2]["start"] + 0.05, edited[2]["start"] - 0.1, rate) < 0.5 * loud  # type: ignore[operator]
    # -12 dB on line 3 against line 2 at 0 dB (beds muted, so only the voices are measured)
    voiced = rms(after, edited[2]["start"] + 0.05, edited[2]["end"] - 0.05, rate)  # type: ignore[operator]
    assert rms(after, edited[3]["start"] + 0.05, edited[3]["end"] - 0.05, rate) / voiced == pytest.approx(10 ** (-12 / 20), rel=0.05)  # type: ignore[operator]
    # the s-curve fade over the whole of line 0 makes its opening far quieter
    assert rms(after, edited[0]["start"], edited[0]["start"] + 0.4, rate) < 0.1 * opening  # type: ignore[operator]

    # and a plain `pablo mix` now keeps rendering the human document (it fits the takes)
    body = mixed(work, cues_dir)
    assert (body["mixWritten"], body["mixBy"], body["mixDocument"]) == (False, "human", str(mix_path(work, 1, 2)))
    assert [l["start"] for l in lines_of(work, 3)] == [l["start"] for l in edited]


def test_a_hand_edit_saved_in_place_is_what_the_next_mix_renders(work: Path, cues_dir: Path, auto_doc: dict[str, object]) -> None:
    base = lines_of(work, 1)
    clip(auto_doc, "line-1")["anchor"]["offset"] += 0.5  # type: ignore[index]
    mix_path(work, 1, 1).write_text(json.dumps(auto_doc))
    body = mixed(work, cues_dir)
    assert body["mixWritten"] is False
    assert [round(a["start"] - b["start"], 3) for a, b in zip(lines_of(work, 2), base)] == [0.0, 0.5, 0.5, 0.5]  # type: ignore[operator]


def test_overlapping_clips_on_one_lane_crossfade_at_equal_power(work: Path, cues_dir: Path) -> None:
    performed(work, cues=[cue("BED", "Rain on a tin roof", 0)])
    manifest = read_version(work, 1, 1)
    sources = Sources(work, CueLibrary(cues_dir, lambda kind: FakeCues()), fake_pacer)
    doc = auto_document(manifest, sources)
    beds = doc["tracks"]["beds"]["lanes"]["main"]["clips"]  # type: ignore[index]
    tile = dict(beds[0], id="solo-a", fade_in={"len": 0.0, "curve": "linear"}, fade_out={"len": 0.0, "curve": "linear"}, gain=0.0, anchor={"at": 0.0})
    other = dict(tile, id="solo-b", anchor={"at": 0.25})  # half a 0.5 s tile of overlap
    doc["tracks"]["beds"]["lanes"]["main"]["clips"] = [tile, other]  # type: ignore[index]
    doc["tracks"]["beds"]["solo"] = True  # type: ignore[index]
    doc["master"] = {"gain": 0.0, "peak_db": None, "target_lufs": None}
    out = render_document(manifest, doc, sources).audio
    source = sources.cue(beds[0]["source"]["key"], None)
    assert source is not None
    n = int(0.25 * SR)
    mid = int(0.125 * SR)  # halfway through the overlap: cos(pi/4) of the tail plus sin(pi/4) of the head
    expected = (source[n + mid] + source[mid]) * np.sqrt(0.5)
    assert out[n + mid] == pytest.approx(expected, abs=1e-3)
    # nothing but the soloed beds track is heard: no voice anywhere
    assert float(np.abs(out[int(0.8 * SR) :]).max()) < 1e-6


def test_muted_tracks_and_automation_shape_the_render(work: Path, cues_dir: Path) -> None:
    performed(work)
    manifest = read_version(work, 1, 1)
    sources = Sources(work, CueLibrary(cues_dir, lambda kind: FakeCues()), fake_pacer)
    doc = auto_document(manifest, sources)
    doc["master"] = {"gain": 0.0, "peak_db": None, "target_lufs": None}
    plain = render_document(manifest, doc, sources)
    doc["tracks"]["dialogue"]["automation"] = [{"anchor": {"line": 1, "edge": "start", "offset": 0.0}, "db": 0.0, "curve": "linear"}, {"anchor": {"line": 1, "edge": "start", "offset": 0.01}, "db": -20.0, "curve": "linear"}]  # type: ignore[index]
    ducked = render_document(manifest, doc, sources)
    first, second = plain.lines[0], plain.lines[1]
    assert rms(ducked.audio, first["start"], first["end"], SR) == pytest.approx(rms(plain.audio, first["start"], first["end"], SR), rel=1e-3)  # type: ignore[arg-type]
    assert rms(ducked.audio, second["start"] + 0.1, second["end"], SR) == pytest.approx(0.1 * rms(plain.audio, second["start"] + 0.1, second["end"], SR), rel=0.02)  # type: ignore[arg-type,operator]
    doc["tracks"]["dialogue"]["mute"] = True  # type: ignore[index]
    assert float(np.abs(render_document(manifest, doc, sources).audio).max()) == 0.0


# --- one render path: the streamed Timeline is the auto mix document -----------------------------------------


def test_a_streamed_episode_is_its_mix_v1_document_rendered(setup: tuple[Path, Path]) -> None:
    """`perform --stream` writes the timeline it streamed as mix.v1; rendering that document gives the streamed file."""
    work, library = setup
    body, code, _ = go(work, library, Factory())
    assert code == 0, body
    assert mix_versions(work, 1) == [1]
    doc = read_mix(work, 1, 1)
    assert (doc["by"], doc["manifest_version"]) == ("auto", 1) and validate(doc) == []
    manifest = read_version(work, 1, 1)
    assert manifest["mix"]["document"] == "mix.v1.json"  # type: ignore[index]
    final, _ = sf.read(str(episode_dir(work, 1) / str(manifest["audio"])), dtype="float32")
    again = render_document(manifest, doc, Sources(work, CueLibrary(library / "cues", lambda kind: FakeCues()), fake_pacer))
    assert len(again.audio) == len(final) and float(np.abs(again.audio - final).max()) < 2 / 32768
    assert [(l["start"], l["end"]) for l in again.lines] == [(l["start"], l["end"]) for l in manifest["lines"]]  # type: ignore[union-attr]
    joined = segments_audio(work)
    gain = float(np.dot(again.audio, joined) / np.dot(joined, joined))
    assert float(np.abs(again.audio - gain * joined).max()) < 2e-3


def test_the_timeline_streamed_piecewise_equals_the_document_render(work: Path, cues_dir: Path) -> None:
    """Mixdown in arbitrary windows behind the frontier is the document render's samples before the master."""
    performed(work, cues=[cue("MUSIC", "A brass sting", -1), cue("BED", "Rain on a tin roof", 0), cue("SFX", "A door creaks", 1), cue("SFX", "A bell", 1), cue("BED", "off", 3)])
    manifest = read_version(work, 1, 1)
    sources = Sources(work, CueLibrary(cues_dir, lambda kind: FakeCues()), fake_pacer)
    from pablo_casting.mix import _group_lines, _lines

    timeline = Timeline(work, manifest["cues"], sources.library, fake_pacer, sources=sources, manifest_version=1)  # type: ignore[arg-type]
    pieces: list[np.ndarray] = []
    emitted = 0
    for group in _group_lines(_lines(manifest)):
        timeline.add(group)
        frontier = timeline.frontier()
        if frontier > emitted:
            pieces.append(timeline.mixdown(emitted, frontier))
            emitted = frontier
    total = timeline.finish()
    pieces.append(timeline.mixdown(emitted, total))
    streamed = np.concatenate(pieces)
    rendered = render_document(manifest, timeline.document(), sources)
    assert len(streamed) == len(rendered.audio)
    gain = float(np.dot(rendered.audio, streamed) / np.dot(streamed, streamed))
    assert float(np.abs(rendered.audio - gain * streamed).max()) < 1e-5
    # two SFX in a row overlap (the second starts 0.4 s early): the auto mix puts it on a second lane, so it sums, never crossfades
    sfx = timeline.document()["tracks"]["sfx"]["lanes"]  # type: ignore[index]
    assert sorted(sfx) == ["2", "main"]
