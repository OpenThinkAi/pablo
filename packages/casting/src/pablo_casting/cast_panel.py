"""The mixer's Cast panel, its reads (AGT-2157, pm project `pablo-platform`, D-19): what the panel asks of the disk.

`python -m pablo_casting castpanel <op> --work W --episode N ...` answers the two things the panel needs that no
casting verb already gives. Binding, auditioning a new voice from a description, freezing a candidate and listing
the library stay the casting verbs' own (`bind`, `audition`, `cast`, `voices`, `describe`): the host calls those.

- `castpanel roles --episode N`  every role the episode's script speaks or declares, in order: its `CAST:`
  gender and description, the voice `cast.json` binds it to (slug, card hash, who bound it, and whether the pin
  still holds in the library), its spoken lines (`i` numbered as `perform` and the manifest number them, with the
  words), and, once the episode is performed, which of those lines were performed in a different voice than the
  one bound now (`stale`: the lines a rebind would re-perform).
- `castpanel preview --episode N --line I --voice SLUG`  spoken line `I` of the episode read in library voice
  `SLUG` through the performance engine (the dramatic engine for a `[DRAMA]` line), as a base64 16-bit WAV. A
  preview is a throwaway: it writes no take, no manifest and no binding, only a `preview` receipt. A retired voice
  is refused (it is never bound to a role again, so there is nothing to audition it for).
"""

from __future__ import annotations

import base64
import time
from collections.abc import Mapping
from pathlib import Path

from pablo_casting.binding import BindingRefusal, pin_state, read_cast, read_episode
from pablo_casting.engines import DEFAULT_ENGINE, DRAMA_ENGINE, ENGINE_SPECS, EngineFactory, EngineUnavailable, Pass, PassLine, VoiceRef, adapt
from pablo_casting.fix import recast_lines
from pablo_casting.gates import GateRefusal, load_card
from pablo_casting.lexicon import load as load_lexicon
from pablo_casting.library import card_hash
from pablo_casting.manifest import read_version, versions
from pablo_casting.perform import card_transcript, runs_between_cues
from pablo_casting.receipts import append_receipt
from pablo_casting.takes import Direction, Line, TakeInputs

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_REFUSED = 2

Body = dict[str, object]
Result = tuple[Body, int]

OPS = ("roles", "preview")


def _refused(message: str, **extra: object) -> Result:
    return {"ok": False, "code": EXIT_REFUSED, "message": message, **extra}, EXIT_REFUSED


def _error(message: str) -> Result:
    return {"ok": False, "code": EXIT_ERROR, "message": message}, EXIT_ERROR


def stale_lines(work: Path, episode: int, bound: Mapping[str, Mapping[str, object]]) -> dict[str, list[int]]:
    """Per role, the newest manifest's lines performed in another voice than the role's binding now: `fix`'s own rule
    (`fix.recast_lines`), so what the panel offers to re-perform is exactly what `fix` accepts. Nothing when the episode is
    unperformed or the rule cannot pin the change to whole roles (`fix` would refuse it too)."""
    found = versions(work, episode)
    if not found:
        return {}
    lines = [line for line in read_version(work, episode, found[-1]).get("lines", []) if isinstance(line, dict)]  # type: ignore[union-attr]
    pins = {role: str(entry["card_hash"]) for role, entry in bound.items() if isinstance(entry.get("card_hash"), str)}
    recast = recast_lines(work, lines, pins)
    out: dict[str, list[int]] = {}
    for line in lines:
        if recast is not None and line.get("i") in recast:
            out.setdefault(str(line.get("speaker")), []).append(int(line["i"]))
    return out


def cmd_roles(work: Path, episode: int, voices_dir: Path | None) -> Result:
    found = read_episode(work, episode)
    if found is None:
        return _refused(f"no script for episode {episode} in {work}", missing=[f"episode {episode}"])
    _, script = found
    try:
        bound = read_cast(work)
    except BindingRefusal as refusal:
        return _refused(str(refusal))
    _, spoken = runs_between_cues(script)
    stale = stale_lines(work, episode, bound)
    roles: list[dict[str, object]] = []
    for name in script.role_names():
        declared = script.roles.get(name)
        entry = bound.get(name)
        voice: dict[str, object] | None = None
        if entry is not None:
            voice = {
                "slug": entry.get("slug"),
                "cardHash": entry.get("card_hash"),
                "by": entry.get("by"),
                "at": entry.get("at"),
                "state": pin_state(voices_dir, dict(entry)) if voices_dir is not None else "unknown",
            }
        roles.append(
            {
                "role": name,
                "gender": declared.gender if declared is not None else None,
                "description": declared.description if declared is not None else None,
                "voice": voice,
                "lines": [{"i": i, "text": line.text} for i, line in enumerate(spoken) if line.speaker == name],
                "stale": stale.get(name, []),
            }
        )
    return {
        "ok": True,
        "episode": episode,
        "performed": bool(versions(work, episode)),
        "library": str(voices_dir) if voices_dir is not None else None,
        "roles": roles,
    }, EXIT_OK


def cmd_preview(env: Mapping[str, str], work: Path, episode: int, line: str | None, slug: str | None, voices_dir: Path | None, engines: EngineFactory) -> Result:
    if line is None or slug is None:
        missing = [name for name, value in (("--line", line), ("--voice", slug)) if value is None]
        return _refused(f"castpanel preview needs {' and '.join(missing)}", missing=missing)
    try:
        i = int(line)
    except ValueError:
        return _error(f"--line must be an integer, got {line!r}")
    if voices_dir is None:
        return _refused("no voice library: pass --vault or --library, or set `library` in the casting config", missing=["library"])
    found = read_episode(work, episode)
    if found is None:
        return _refused(f"no script for episode {episode} in {work}", missing=[f"episode {episode}"])
    _, spoken = runs_between_cues(found[1])
    if not 0 <= i < len(spoken):
        return _refused(f"episode {episode} has {len(spoken)} spoken lines (0-{len(spoken) - 1}); there is no line {i}")
    said = spoken[i]
    try:
        card = load_card(slug, voices_dir.parent)
    except GateRefusal as refusal:
        return _refused(str(refusal))
    if "retired" in card.data:
        return _refused(f'voice "{slug}" is retired and is never bound to a role again; audition another')
    if card.reference is None:
        return _refused(f"voice {slug!r} has no reference clip beside its card ({card.dir})", missing=[str(card.dir / "reference.flac")])
    reference = card.data.get("reference")
    seconds = reference.get("seconds") if isinstance(reference, dict) else None
    digest = card_hash(card.data)
    voice = VoiceRef(
        card_hash=digest,
        slug=slug,
        reference=card.reference,
        transcript=card_transcript(card),
        seconds=float(seconds) if isinstance(seconds, (int, float)) and not isinstance(seconds, bool) else 0.0,
    )
    spec = DRAMA_ENGINE if said.drama else ENGINE_SPECS[DEFAULT_ENGINE]
    take_pass = Pass((PassLine(0, said.speaker, said.text, said.drama),))
    voices = {said.speaker: voice}
    direction = said.direction
    engine = engines(spec, voices, env)
    try:
        engine.load()
    except EngineUnavailable as missing:
        return _refused(str(missing))
    params = adapt(spec, take_pass, voices, direction.emotion if direction else None, direction.intensity if direction else None, (), load_lexicon(work))
    inputs = TakeInputs(
        engine=engine.identity,
        voice=digest,
        lines=(Line(speaker=said.speaker, text=said.text),),
        seed=0,
        direction=Direction(emotion=direction.emotion if direction else None, intensity=direction.intensity if direction and direction.emotion else None, pace=direction.pace if direction else None),
        params=params,
    )
    started = time.monotonic()
    synthesis = engine.synthesize(inputs)
    wall = round(time.monotonic() - started, 3)
    audio = synthesis.audio
    length = round(audio.duration, 4)
    append_receipt(work, {"intent": "preview", "episode": episode, "line": i, "role": said.speaker, "voice": slug, "card_hash": digest, "engine": engine.identity.id, "wall": wall, "audio_seconds": length})
    return {
        "ok": True,
        "episode": episode,
        "line": i,
        "role": said.speaker,
        "text": said.text,
        "voice": slug,
        "cardHash": digest,
        "mime": "audio/wav",
        "sample_rate": audio.sample_rate,
        "seconds": length,
        "b64": base64.b64encode(audio.to_wav()).decode("ascii"),
    }, EXIT_OK


def cmd_castpanel(
    op: str | None,
    env: Mapping[str, str],
    work: Path,
    episode: str | None,
    line: str | None,
    voice: str | None,
    voices_dir: Path | None,
    engines: EngineFactory,
) -> Result:
    if op not in OPS:
        return _error(f'unknown castpanel subcommand "{op}": one of {", ".join(OPS)}')
    if episode is None:
        return _refused(f"castpanel {op} needs --episode N", missing=["--episode"])
    try:
        number = int(episode)
    except ValueError:
        return _error(f"--episode must be an integer, got {episode!r}")
    if number < 1:
        return _error(f"--episode must be a positive integer, got {number}")
    if op == "roles":
        return cmd_roles(work, number, voices_dir)
    return cmd_preview(env, work, number, line, voice, voices_dir, engines)


__all__ = ["cmd_castpanel", "cmd_preview", "cmd_roles", "stale_lines"]
