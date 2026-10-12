"""`fix --work W --episode N` (AGT-1685): flags to a new version that re-records only flagged lines.

Reads the episode's open flags from `flags.json` (the player's, and `perform`'s
automatic ones for `best_of_failed` takes), re-performs exactly the flagged
lines, writes `v<k+1>` through `manifest.write_version`, remixes it, and moves
the flags to `flags-done.json` with the version they landed in.

**Only flagged lines change.** The new manifest starts from `v<k>`'s lines; the
flagged ones are replaced by freshly performed takes and nothing else is
touched. `write_version` then checks the take diff against the applied flags
and refuses (nothing written) if any other line moved, so the guarantee does not
rest on this module being right. The new takes are *new*: a retake's attempt
numbers start past the attempts the line already used, and a flag's reason can
bump the engine's parameters (`engines.RETAKE_TEMPERATURE`, `rushed` slowing the
pace), so a key never repeats the old take's.

A flagged line is always re-recorded alone, one line to a take, whatever the
engine's usual grouping: a Dia pass voicing three lines would otherwise drag two
unflagged lines along.

**Reasons** (`clipped`, `wrong voice`, `flat`, `rushed`, `other`, or an
automatic flag's free text) are recorded in the manifest's `flags_applied`
(`{id, line, reason, by}`) and on the line (`fix`). Several flags on one line
are one retake, with all their reasons.

**Moving the flags**: `flags-done.json` gains each applied flag with
`fixed_in` (the version) and `fixed_at`, then `flags.json` loses them (both
atomic, the copy first, so a crash duplicates a flag and never loses one). A
retake that still fails the gates is flagged again automatically, in
`flags.json`, like `perform` does. The player's flags for other episodes are
left alone.

Refusals (exit 2, nothing written): the episode has no manifest, **no open
flags** (it names the episode), a flag with no id or pointing at a line the
version does not have, no script, an unbound or changed role, a role cast
differently from `v<k>` (rebinding a role changes every one of its lines, which
is a new performance, not a fix), or an unflagged line whose speaker or words no
longer match the script. If the remix fails after the version was written, the
result says so and names `pablo mix`; the flags are already moved.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TextIO

from pablo_casting.binding import read_episode
from pablo_casting.config import ConfigRefusal, load_config
from pablo_casting.engines import DEFAULT_ENGINE, ENGINE_SPECS, EngineFactory, EngineUnavailable, Pass, PassLine, normalise_reasons
from pablo_casting.manifest import ManifestError, flags_path, read_version, versions, write_version
from pablo_casting.perform import (
    EXIT_ERROR,
    EXIT_OK,
    EXIT_REFUSED,
    PACE_MULTIPLIER,
    PACE_RANGE,
    Performer,
    PerformRefusal,
    Result,
    Totals,
    _emit,
    _error,
    _line_entry,
    _refused,
    _sha256_text,
    _write_auto_flags,
    cue_positions,
    resolve_roles,
    runs_between_cues,
)
from pablo_casting.receipts import append_receipt, now
from pablo_casting.scorers import Scorer, ScorerUnavailable
from pablo_casting.takes import take_path

Mixer = Callable[[int], Result]


@dataclass(frozen=True)
class FixRequest:
    work: Path
    episode: int
    voices_dir: Path
    json_lines: bool = False


def flags_done_path(work: Path) -> Path:
    return flags_path(work).with_name("flags-done.json")


class FlagsRefusal(Exception):
    pass


def _read_flags(path: Path) -> dict[str, object]:
    try:
        raw: object = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"flags": []}
    except json.JSONDecodeError as failure:
        raise FlagsRefusal(f"{path} is not valid JSON: {failure}") from failure
    if not isinstance(raw, dict) or not isinstance(raw.get("flags", []), list):
        raise FlagsRefusal(f'{path} must hold {{"flags": [...]}}')
    return raw


def _write_atomic(path: Path, body: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}")
    temporary.write_text(json.dumps(body, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def move_flags_done(work: Path, episode: int, applied: Sequence[Mapping[str, object]], version: int) -> None:
    """Appends the applied flags to `flags-done.json` (with `fixed_in`), then drops them from `flags.json`."""
    ids = {str(flag["id"]) for flag in applied}
    stamp = now()
    done_raw = _read_flags(flags_done_path(work))
    done = list(done_raw.get("flags", []))  # type: ignore[call-overload]
    done.extend({**flag, "fixed_in": version, "fixed_at": stamp} for flag in applied)
    _write_atomic(flags_done_path(work), {**done_raw, "flags": done})
    open_raw = _read_flags(flags_path(work))
    kept = [flag for flag in open_raw.get("flags", []) if not (isinstance(flag, dict) and flag.get("episode") == episode and flag.get("id") in ids)]  # type: ignore[union-attr]
    _write_atomic(flags_path(work), {**open_raw, "flags": kept})


def fix(
    request: FixRequest,
    *,
    env: Mapping[str, str],
    engine_factory: EngineFactory,
    scorer_factory: Callable[[], Sequence[Scorer]],
    mixer: Mixer | None,
    err: TextIO | None = None,
    out: TextIO | None = None,
) -> Result:
    import sys

    err = err if err is not None else sys.stderr
    stream_out = (out if out is not None else sys.stdout) if request.json_lines else None
    work, episode = request.work, request.episode

    found = versions(work, episode)
    if not found:
        return _refused(f"episode {episode} has no manifest to fix: run `pablo perform --episode {episode}` first", episode=episode)
    parent_version = found[-1]
    parent = read_version(work, episode, parent_version)
    parent_lines = [line for line in parent.get("lines", []) if isinstance(line, dict)]  # type: ignore[union-attr]

    try:
        raw = _read_flags(flags_path(work))
    except FlagsRefusal as refusal:
        return _refused(str(refusal))
    open_flags = [flag for flag in raw.get("flags", []) if isinstance(flag, dict) and flag.get("episode") == episode]  # type: ignore[union-attr]
    if not open_flags:
        return _refused(
            f"episode {episode} has no open flags in {flags_path(work)}; flag the lines to re-record in the player first (nothing to fix)",
            episode=episode,
            version=parent_version,
        )
    count = len(parent_lines)
    malformed = [str(flag.get("id")) for flag in open_flags if not isinstance(flag.get("id"), str) or not flag.get("id")]
    if malformed:
        return _refused(f"episode {episode} has a flag with no id in {flags_path(work)}; every flag needs an id")
    bad = [f"{flag['id']} (line {flag.get('line')!r})" for flag in open_flags if not isinstance(flag.get("line"), int) or isinstance(flag.get("line"), bool) or not 0 <= flag["line"] < count]
    if bad:
        return _refused(f"episode {episode} v{parent_version} has {count} lines (0-{count - 1}); flag(s) point elsewhere: {', '.join(bad)}", flags=bad)

    by_line: dict[int, list[dict[str, object]]] = {}
    for flag in open_flags:
        by_line.setdefault(int(flag["line"]), []).append(flag)  # type: ignore[call-overload]
    flagged = sorted(by_line)

    located = read_episode(work, episode)
    if located is None:
        return _refused(f"no script for episode {episode} in {work}", missing=[f"episode {episode}"])
    script_path, script = located
    try:
        roles = resolve_roles(work, script, request.voices_dir)
    except PerformRefusal as refusal:
        return _refused(str(refusal), **refusal.extra)
    runs, spoken = runs_between_cues(script)
    if len(spoken) != count:
        return _refused(
            f"episode {episode}'s script now has {len(spoken)} spoken lines and v{parent_version} has {count}; a fix re-records flagged lines of the same script, so the changes are a new performance",
            lines=len(spoken),
            manifestLines=count,
        )
    drifted = [
        int(line["i"])  # type: ignore[call-overload]
        for line in parent_lines
        if int(line["i"]) not in by_line  # type: ignore[call-overload]
        and (spoken[int(line["i"])].speaker != line.get("speaker") or spoken[int(line["i"])].text != line.get("text"))  # type: ignore[call-overload]
    ]
    if drifted:
        return _refused(
            f"unflagged line(s) {', '.join(map(str, drifted))} no longer match the script they were performed from; flag them too, or perform anew",
            lines=drifted,
        )
    cast_pins = {name: role.voice.card_hash for name, role in sorted(roles.items())}
    cast_hash = _sha256_text(json.dumps(cast_pins, sort_keys=True, separators=(",", ":")))
    if parent.get("cast_hash") != cast_hash:
        return _refused(
            f"the cast changed since v{parent_version} (a role is bound to a different voice or card); rebinding changes every line of that role, which is a new performance, not a fix"
        )
    engine_block = parent.get("engine")
    engine_name = engine_block.get("name") if isinstance(engine_block, dict) else None
    spec = ENGINE_SPECS.get(str(engine_name)) or ENGINE_SPECS[DEFAULT_ENGINE]
    try:
        air = load_config(env).air
    except ConfigRefusal as refusal:
        return _refused(str(refusal))

    started = time.monotonic()
    engine = engine_factory(spec, {name: role.voice for name, role in roles.items()}, env)
    try:
        loaded = engine.load()
    except EngineUnavailable as missing:
        return _refused(str(missing))
    append_receipt(work, {"intent": "load", "engine": engine.identity.id, "revision": spec.revision, "weights_sha256": engine.identity.weights_sha256, **loaded})
    scorers = list(scorer_factory())

    _emit({"event": "start", "episode": episode, "engine": spec.name, "fix": True, "from": parent_version, "lines": len(flagged)}, err, stream_out)
    redone: dict[int, dict[str, object]] = {}
    with tempfile.TemporaryDirectory(prefix="pablo-fix-") as scratch:
        performer = Performer(work=work, episode=episode, spec=spec, roles=roles, engine=engine, scorers=scorers, err=err, out=stream_out, scratch=Path(scratch), totals=Totals(), air=air)
        try:
            for i in flagged:
                before = parent_lines[i]
                flags = by_line[i]
                reasons = normalise_reasons([flag.get("reason") for flag in flags])
                made = before.get("attempts")
                used = int(made) if isinstance(made, int) and not isinstance(made, bool) else int(before.get("attempt", 0)) + 1  # type: ignore[call-overload]
                take_pass = Pass((PassLine(i, spoken[i].speaker, spoken[i].text),))
                kept, attempts, target, band, _ = performer.perform_pass(take_pass, spoken, first_attempt=used, reasons=reasons)
                entry = _line_entry(spoken[i], i, kept, attempts, target, band, None)
                entry["attempts"] = used + len(attempts)
                entry["fix"] = {
                    "from_version": parent_version,
                    "flags": [flag["id"] for flag in flags],
                    "reasons": list(reasons),
                    "replaced_take": before.get("take"),
                    "temperature": kept.inputs.params.get("temperature"),
                    "pace": kept.inputs.direction.pace,
                }
                redone[i] = entry
                _emit(
                    {
                        "event": "line",
                        "episode": episode,
                        "i": i,
                        "of": count,
                        "speaker": entry["speaker"],
                        "take": entry["take"],
                        "path": str(take_path(work, kept.key) / "take.wav"),
                        "status": entry["status"],
                        "attempts": len(attempts),
                        "stretch": entry["stretch"],
                    },
                    err,
                    stream_out,
                )
        except ScorerUnavailable as missing:
            return _refused(
                f"{missing}; pablo installs it with the fix verb, or run `uv sync --extra {missing.info.extra}` in packages/casting",
                missing=[missing.info.package],
            )
        except EngineUnavailable as missing:
            return _refused(str(missing))
        except Exception as failure:  # takes already decided stay in the store; a rerun resumes
            return _error(f"fixing episode {episode} failed after {len(redone)} of {len(flagged)} lines: {type(failure).__name__}: {failure}; run it again to resume")

    totals = performer.totals
    new_lines = [redone.get(int(line["i"]), line) for line in parent_lines]  # type: ignore[call-overload]
    redelivered = sum(float(entry["seconds"]) / float(entry["stretch"]) for entry in redone.values())  # type: ignore[arg-type]
    delivered, seen = 0.0, set()
    for line in new_lines:
        if line["take"] in seen:
            continue
        seen.add(line["take"])
        delivered += float(line["seconds"]) / float(line["stretch"])  # type: ignore[arg-type]
    compute = totals.engine_wall + totals.score_wall
    wall = round(time.monotonic() - started, 3)
    rtf_total = round(compute / redelivered, 4) if redelivered else None
    render = {
        "fix": True,
        "from_version": parent_version,
        "lines": flagged,
        "wall": wall,
        "engine_wall": round(totals.engine_wall, 3),
        "score_wall": round(totals.score_wall, 3),
        "audio_seconds": round(redelivered, 3),
        "rtf_total": rtf_total,
        "takes_rendered": totals.rendered,
        "takes_reused": totals.reused,
        "peak_memory_gb": round(totals.peak_memory_gb, 3),
        "load": loaded,
    }
    applied = [
        {"id": flag["id"], "line": flag["line"], "reason": flag.get("reason"), "by": flag.get("by", "player")}
        for i in flagged
        for flag in by_line[i]
    ]
    try:
        written = write_version(
            work,
            episode,
            {
                "script_sha256": hashlib.sha256(script_path.read_bytes()).hexdigest(),
                "cast_hash": cast_hash,
                "engine": {"id": engine.identity.id, "weights_sha256": engine.identity.weights_sha256, "mlx_audio": engine.identity.mlx_audio, "mlx": engine.identity.mlx, **spec.as_body()},
                "pace_policy": parent.get("pace_policy") or {"stretch_range": list(PACE_RANGE), "pace_multiplier": PACE_MULTIPLIER, "tool": "sox tempo -s (WSOLA), applied by the mix"},
                "cues": cue_positions(script),
                "duration": round(delivered, 3),
                "rtf_total": rtf_total,
                "render": render,
                "lines": new_lines,
            },
            flags_applied=applied,
        )
    except ManifestError as failure:
        # The invariant's refusal (or a store fault): nothing was written, the flags stay open.
        return _error(f"writing episode {episode}'s fixed manifest failed: {failure}")
    version = int(written.manifest["version"])  # type: ignore[call-overload]

    try:
        move_flags_done(work, episode, [{k: v for k, v in flag.items()} for flag in open_flags], version)
        refreshed = _write_auto_flags(work, episode, list(redone.values()))
    except (FlagsRefusal, ManifestError, json.JSONDecodeError, OSError) as failure:
        return _error(f"episode {episode} v{version} was written but moving its flags failed: {failure}")

    statuses = [str(entry["status"]) for entry in redone.values()]
    summary = {
        "intent": "fix",
        "episode": episode,
        "engine": spec.name,
        "version": version,
        "from_version": parent_version,
        "changed_lines": written.manifest["changed_lines"],
        "flags": [flag["id"] for flag in applied],
        "pass": statuses.count("pass"),
        "best_of_failed": statuses.count("best_of_failed"),
        **{k: v for k, v in render.items() if k != "load"},
    }
    append_receipt(work, summary)
    _emit({"event": "done", "episode": episode, "manifest": str(written.path), "changed_lines": summary["changed_lines"]}, err, stream_out)

    body: dict[str, object] = {
        "ok": True,
        "episode": episode,
        "engine": spec.name,
        "version": version,
        "fromVersion": parent_version,
        "manifest": str(written.path),
        "changedLines": written.manifest["changed_lines"],
        "flagsApplied": applied,
        "flagsDone": str(flags_done_path(work)),
        "pass": summary["pass"],
        "bestOfFailed": summary["best_of_failed"],
        "flags": refreshed,
        "takesRendered": totals.rendered,
        "takesReused": totals.reused,
        "wall": wall,
        "mixed": False,
        "audio": None,
        "link": None,
    }
    message = f"episode {episode} v{version}: re-recorded line(s) {', '.join(map(str, flagged))} from v{parent_version} ({len(applied)} flag(s) applied, {totals.rendered} takes rendered"
    if refreshed:
        message += f", {len(refreshed)} flagged again"
    message += ")"
    if mixer is None:
        body["message"] = message
        return body, EXIT_OK
    mixed, code = mixer(version)
    if code != EXIT_OK or not mixed.get("ok"):
        return {
            **mixed,
            "ok": False,
            "version": version,
            "manifest": str(written.path),
            "changedLines": written.manifest["changed_lines"],
            "message": f"{message}; the remix failed, so v{version} has no audio yet and its flags are already moved: {mixed.get('message')} -- finish with `pablo mix --episode {episode}`",
        }, (code if code in (EXIT_REFUSED, EXIT_ERROR) else EXIT_ERROR)
    body.update({"mixed": True, "audio": mixed.get("audio"), "link": mixed.get("link"), "linkMoved": mixed.get("linkMoved"), "duration": mixed.get("duration"), "cuesGenerated": mixed.get("cuesGenerated")})
    body["message"] = f"{message}; remixed -> {Path(str(mixed.get('audio'))).name}"
    return body, EXIT_OK


def cmd_fix(
    env: Mapping[str, str],
    work: Path | None,
    episode: str | None,
    vault: str | None,
    library: str | None,
    configured_library: str | None,
    json_lines: bool,
    engine_factory: EngineFactory,
    scorer_factory: Callable[[], Sequence[Scorer]],
    mixer: Callable[[int], Result] | None,
) -> Result:
    from pablo_casting.binding import library_dir

    if work is None:
        return _refused("fix needs --work <dir> (the work whose episode to fix)", missing=["--work"])
    if episode is None:
        return _refused("fix needs --episode N", missing=["--episode"])
    try:
        number = int(episode)
    except ValueError:
        return _error(f"--episode must be an integer, got {episode!r}")
    if number < 1:
        return _error(f"--episode must be a positive integer, got {number}")
    voices_dir = library_dir(Path(vault) if vault else None, configured_library, Path(library) if library else None)
    if voices_dir is None:
        return _refused("no voice library: pass --vault or --library, or set `library` in the casting config", missing=["library"])
    return fix(
        FixRequest(work=work, episode=number, voices_dir=voices_dir, json_lines=json_lines),
        env=env,
        engine_factory=engine_factory,
        scorer_factory=scorer_factory,
        mixer=mixer,
    )


__all__ = ["FixRequest", "cmd_fix", "fix", "flags_done_path", "move_flags_done"]
