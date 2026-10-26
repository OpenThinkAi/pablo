"""`perform --work W --episode N [--engine chatterbox-turbo|dia] [--json-lines]` (AGT-1683).

Renders every spoken line of an episode script through the decided engine
(`engines.py`), scores each take with the gate stack (`scorers.py`, judged by
`gates.py`), runs the retake loop, writes the takes (`takes.py`) and the
episode's `v1.json` (`manifest.py`), and streams each line's take as it lands.

**Dramatic scenes** (AGT-1888): the lines of a `[DRAMA]` scene (`script.py`)
render through `engines.DRAMA_ENGINE`, the original Chatterbox, and every other
line through the episode's engine, in one run. The second engine is loaded
only when the episode has a scene. Runs break at a scene's edges, so a pass is
all dramatic or all not, and a dramatic pass is one line. The gate stack, the
retake loop and the pace policy are the same for both. A dramatic line's
manifest entry carries `drama: true` and its own `engine` block; a line without
one was voiced by the manifest's `engine`. An episode without a scene performs
exactly as before, with the same take keys.

**Retake loop** (design, "Quality gates"): up to `MAX_ATTEMPTS` (4) attempts
per pass with derived seeds (`takes.derive_seed`: `sha1(key_without_seed +
attempt)`); the first take that passes every hard gate is kept. If none pass,
the best is kept with `status: best_of_failed` and the line is flagged
automatically in `flags.json` (`by: auto`) with the failing gates as the
reason, so it shows in the player and `pablo fix` can retake it. "Best" prefers
a take whose stretch is inside the pace range, then the design's composite
`wer_ok + sim_card + utmos/5`.

**Pace policy**: the role's pace is the card's `pace.wps` (else the middle of
its band), times 0.85 for a `slow` line and 1.15 for a `quick` one, and the
line's pace band is the card's band scaled the same way. Neither engine has a
native pace control, so the take is rendered at the voice's own pace and the
stretch that brings it into the band (a sox WSOLA `tempo -s` factor; the mix
applies it, C12) is measured from the aligner's timings. A line already inside
the band is not stretched (1.0); an out-of-band one goes to the nearest band
edge, not the exact target (`target_wps` is kept in the manifest for
reference). A reused take is re-measured under this policy. The stretch must sit
inside `PACE_RANGE` [0.75, 1.05]: the pace gate's `stretch_range` is held to it,
so a take that would need more is a failed take and the line is retaken. A
best-of take that still needs more is stretched only to the range's edge and
says so (`stretch_needed`, and its auto flag). Takes themselves are never
paced: `take.wav` is the engine's audio, finished by `ending.py` (AGT-1789):
cut at the end of its voice (never before the last word's end) plus the air
(`casting.json` `ending.air`, 0.18 s by default), faded inside the air, and
filled with room tone where the engine hard-gated to digital zero. The take's
ending measures (`clipped`, `end_db`, `fall_ms`, `hard_gate`, `voice_end`,
`cut`, `room_tone`) join its scores, and `clipped` is part of the tail gate.

**Takes and resume**: a pass's attempts are written to the take store when the
pass is decided: the kept take with `pass` or `best_of_failed`, the others
`fail`. A take whose key is already in the store is never rendered again, so a
run that stopped part way resumes where it stopped and re-renders nothing.

**Receipts** (`<work>/.pablo/casting/receipts.jsonl`): one `load` entry, one
`take` entry per engine pass (wall, audio seconds, RTF, peak memory, the line
ids, the attempt), one `gate` entry per scored take, and one `perform` entry.
The manifest's `rtf_total` is (engine wall + scoring wall, over every attempt)
over the delivered audio's seconds (the kept takes after their stretch).

**Progress stream**: one JSON object per line on stderr, always
(`{"event": "line", "i", "take", "path", "status", "stretch", ...}`), plus a
`start` and a `done` event; with `--json-lines` the same objects also go to
stdout, before the final body. A caller can start mixing a line as soon as its
event arrives (C19).

**Streaming** (`--stream`, AGT-1697, `stream.py`): each decided pass also goes
onto the mix's timeline, every final 6 s segment is cut into the listening
directory as it exists (`segment` events, one `playable` event once 30 s of the
episode have passed), and when the last line has passed the same timeline is
mixed into the episode file (`chapter` event). The manifest is written exactly
as without it (same takes, same `changed_lines`), plus `ttfa`.

Refusals (exit 2, nothing rendered): no script for the episode, a role with
no voice in `cast.json`, a pin whose card has changed or gone, a card without
its reference, an engine that cannot load, and an episode that already has a
manifest (changing a rendered episode is `pablo fix`'s job, through the "only
flagged lines change" invariant).
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import TextIO

import numpy as np

from pablo_casting.binding import BindingRefusal, library_dir, pin_state, read_cast, read_episode
from pablo_casting.directions import Direction as ScriptDirection
from pablo_casting.lexicon import PARAM as LEXICON_PARAM, Entry, load as load_lexicon, respelt_words
from pablo_casting.engines import (
    DRAMA_ENGINE,
    ENGINE_SPECS,
    EngineFactory,
    EngineSpec,
    EngineUnavailable,
    Pass,
    PassLine,
    PerformEngine,
    VoiceRef,
    adapt,
    from_audio,
    group_dia,
    group_lines,
    retake_pace,
    to_audio,
)
from pablo_casting.gate_command import run_scorers
from pablo_casting.gates import Card, GateRefusal, derive, evaluate, load_card, pace_stretch, target_wps, thresholds_for
from pablo_casting.library import card_hash
from pablo_casting.config import ConfigRefusal, load_config
from pablo_casting.cues import CueUnavailable
from pablo_casting.ending import DEFAULT_AIR, finish, last_word_end, measure_ending
from pablo_casting.manifest import ManifestError, episode_dir, flags_path, versions, write_version
from pablo_casting.mix import SR, MixRefusal, MixRequest, Seams, Timeline, sox_pacer
from pablo_casting.mix import mix as mix_episode
from pablo_casting.organ import SoxUnavailable, require_sox
from pablo_casting.receipts import append_receipt, now
from pablo_casting.stream import EpisodeStream
from pablo_casting.scorers import Scorer, ScorerUnavailable
from pablo_casting.scorers import Take as ScoredTake
from pablo_casting.script import Cue, Script, SpokenLine
from pablo_casting.takes import (
    Direction,
    Line,
    Synthesis,
    TakeInputs,
    WordTiming,
    derive_seed,
    read_take,
    take_key,
    take_path,
    write_take,
)

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_REFUSED = 2

MAX_ATTEMPTS = 4
PACE_RANGE = (0.75, 1.05)
PACE_MULTIPLIER = {"slow": 0.85, "quick": 1.15}

Body = dict[str, object]
Result = tuple[Body, int]


class PerformRefusal(Exception):
    def __init__(self, message: str, **extra: object) -> None:
        super().__init__(message)
        self.extra = extra


@dataclass(frozen=True)
class Role:
    name: str
    slug: str
    card: Card
    voice: VoiceRef


@dataclass
class Attempt:
    """One attempt at a pass: its inputs, key, scores and verdict, and its audio until written."""

    attempt: int
    inputs: TakeInputs
    key: str
    scores: dict[str, object]
    verdict: dict[str, object]
    synthesis: Synthesis | None  # None when the take was already in the store
    seconds: float
    timings: dict[str, object] = field(default_factory=dict)
    words: tuple[WordTiming, ...] = ()
    stored_status: str | None = None

    @property
    def passed(self) -> bool:
        return bool(self.verdict.get("pass"))


@dataclass
class Totals:
    engine_wall: float = 0.0
    score_wall: float = 0.0
    rendered: int = 0
    reused: int = 0
    peak_memory_gb: float = 0.0


def _refused(message: str, **extra: object) -> Result:
    return {"ok": False, "code": EXIT_REFUSED, "message": message, **extra}, EXIT_REFUSED


def _error(message: str, **extra: object) -> Result:
    return {"ok": False, "code": EXIT_ERROR, "message": message, **extra}, EXIT_ERROR


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def card_transcript(card: Card) -> str:
    reference = card.data.get("reference")
    name = reference.get("transcript") if isinstance(reference, dict) else None
    if isinstance(name, str):
        candidate = card.dir / name
        if candidate.resolve().parent == card.dir.resolve() and candidate.is_file():
            return candidate.read_text(encoding="utf-8").strip()
        return name  # an inline transcript
    fallback = card.dir / "reference.txt"
    return fallback.read_text(encoding="utf-8").strip() if fallback.is_file() else ""


def resolve_roles(work: Path, script: Script, voices_dir: Path) -> dict[str, Role]:
    """Every role the episode speaks, bound, pinned to an unchanged card, with its reference on disk."""
    try:
        bound = read_cast(work)
    except BindingRefusal as refusal:
        raise PerformRefusal(str(refusal)) from refusal
    speaking = list(dict.fromkeys(line.speaker for line in script.lines))
    unbound = [role for role in speaking if role not in bound]
    if unbound:
        raise PerformRefusal(
            f"episode has role(s) with no voice: {', '.join(unbound)}; bind them first (pablo bind --role R --voice <slug>, or pablo cast --auto)",
            missing=[f"role {role}" for role in unbound],
            unbound=unbound,
        )
    roles: dict[str, Role] = {}
    for name in speaking:
        entry = bound[name]
        state = pin_state(voices_dir, entry)
        slug = str(entry.get("slug"))
        if state != "ok":
            raise PerformRefusal(
                f"role {name} is pinned to voice {slug!r}, whose card is {state} in the library ({voices_dir}); rebind it (pablo bind) before performing",
                missing=[str(voices_dir / slug / "card.json")] if state == "missing" else [],
            )
        try:
            card = load_card(str(voices_dir / slug), None)
        except GateRefusal as refusal:
            raise PerformRefusal(str(refusal)) from refusal
        if card.reference is None:
            raise PerformRefusal(f"voice {slug!r} has no reference clip beside its card ({card.dir})", missing=[str(card.dir / "reference.flac")])
        reference = card.data.get("reference")
        seconds = reference.get("seconds") if isinstance(reference, dict) else None
        voice = VoiceRef(
            card_hash=card_hash(card.data),
            slug=slug,
            reference=card.reference,
            transcript=card_transcript(card),
            seconds=float(seconds) if isinstance(seconds, (int, float)) and not isinstance(seconds, bool) else 0.0,
        )
        roles[name] = Role(name=name, slug=slug, card=card, voice=voice)
    return roles


def runs_between_cues(script: Script) -> tuple[list[list[PassLine]], list[SpokenLine]]:
    """The spoken lines, numbered 0..n-1, in runs broken by cues and by a `[DRAMA]` scene's edges (a pass never spans either)."""
    runs: list[list[PassLine]] = [[]]
    spoken: list[SpokenLine] = []
    for item in script.items:
        if isinstance(item, Cue):
            if runs[-1]:
                runs.append([])
            continue
        if runs[-1] and runs[-1][-1].drama != item.drama:
            runs.append([])
        runs[-1].append(PassLine(len(spoken), item.speaker, item.text, item.drama))
        spoken.append(item)
    return [run for run in runs if run], spoken


def group_passes(runs: Sequence[Sequence[PassLine]], spec: EngineSpec) -> list[Pass]:
    """The episode engine's grouping, run by run; a `[DRAMA]` run is one line per pass, the dramatic engine's grouping."""
    passes: list[Pass] = []
    for run in runs:
        passes.extend(group_dia([run]) if spec.grouping == "dia" and not run[0].drama else group_lines([run]))
    return passes


def cue_positions(script: Script) -> list[dict[str, object]]:
    """Each cue with the index of the spoken line it follows (-1: before the first line)."""
    out: list[dict[str, object]] = []
    seen = -1
    for item in script.items:
        if isinstance(item, Cue):
            out.append({"kind": item.kind, "desc": item.text, "after": seen, "line": item.line})
        else:
            seen += 1
    return out


def _direction(line: SpokenLine) -> ScriptDirection | None:
    return line.direction


def pace_for(card: Card, thresholds: Mapping[str, object], direction: ScriptDirection | None, reasons: Sequence[str] = ()) -> tuple[float, list[float]]:
    """The line's target words/s and its pace band (the role's, scaled by `slow` / `quick`).

    `reasons` are a retake's flag reasons: `rushed` asks for one step slower (AGT-1685).
    """
    pace = retake_pace(direction.pace if direction is not None else None, reasons)
    multiplier = PACE_MULTIPLIER.get(pace or "", 1.0)
    low, high = thresholds["wps_band"]  # type: ignore[misc]
    return round(target_wps(thresholds, card) * multiplier, 3), [round(float(low) * multiplier, 3), round(float(high) * multiplier, 3)]


def _composite(scores: Mapping[str, object], thresholds: Mapping[str, object]) -> float:
    def num(key: str) -> float:
        value = scores.get(key)
        return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0.0

    wer = scores.get("wer")
    wer_ok = 1.0 if isinstance(wer, (int, float)) and wer <= float(thresholds["wer_max"]) else 0.0  # type: ignore[arg-type]
    return wer_ok + num("sim_card") + num("utmos") / 5.0


def _stretch_ok(scores: Mapping[str, object]) -> bool:
    stretch = scores.get("stretch")
    return isinstance(stretch, (int, float)) and PACE_RANGE[0] <= stretch <= PACE_RANGE[1]


def choose(attempts: Sequence[Attempt], thresholds: Mapping[str, object]) -> Attempt:
    """The first passing attempt; else the best: stretch inside the pace range first, then the composite."""
    for attempt in attempts:
        if attempt.passed:
            return attempt
    return max(attempts, key=lambda a: (_stretch_ok(a.scores), _composite(a.scores, thresholds), -a.attempt))


def _emit(event: Mapping[str, object], err: TextIO, out: TextIO | None) -> None:
    line = json.dumps(event, ensure_ascii=False)
    print(line, file=err, flush=True)
    if out is not None:
        print(line, file=out, flush=True)


def finish_take(samples: np.ndarray, rate: int, scores: Mapping[str, object], air: float = DEFAULT_AIR) -> tuple[np.ndarray, dict[str, object]]:
    """The take as stored (`ending.finish`) and its ending measures, which join the take's scores.

    The clipping detector judges the engine's own audio up to the cut (before
    room tone and fade), anchored on the last word, so it sees what the engine
    and the cut did, never pablo's padding.
    """
    word_end = last_word_end(scores)
    finished, info = finish(samples, rate, word_end, air)
    measured = measure_ending(info.pop("measured"), rate, anchor=word_end)  # type: ignore[arg-type]
    return finished, {
        "word_end": word_end,
        "voice_end": info["voice_end"],
        "cut": info["cut"],
        "room_tone": info["room_tone"],
        **measured,
    }


@dataclass
class Performer:
    work: Path
    episode: int
    spec: EngineSpec
    roles: dict[str, Role]
    engine: PerformEngine
    scorers: Sequence[Scorer]
    err: TextIO
    out: TextIO | None
    scratch: Path
    totals: Totals = field(default_factory=Totals)
    lexicon: list[Entry] | None = None
    """The work's pronunciation lexicon; loaded from `outputs/radio/pronounce.md` when not given (AGT-1798)."""
    receipt_tags: dict[str, object] = field(default_factory=dict)
    """Merged into every `take` and `gate` receipt (design on demand tags its trial passes, AGT-1699)."""
    air: float = DEFAULT_AIR
    """Seconds of air a take keeps after its voice ends (`casting.json` `ending.air`); a non-default value is in the take key."""
    drama: PerformEngine | None = None
    """The dramatic engine (`engines.DRAMA_ENGINE`), loaded only when the episode has a `[DRAMA]` scene (AGT-1888)."""

    def __post_init__(self) -> None:
        if self.lexicon is None:
            self.lexicon = load_lexicon(self.work)

    def route(self, take_pass: Pass) -> tuple[EngineSpec, PerformEngine]:
        """The engine a pass renders through: the dramatic one for a `[DRAMA]` line, else the episode's."""
        if not take_pass.lines[0].drama:
            return self.spec, self.engine
        if self.drama is None:
            raise RuntimeError(f"line {take_pass.lines[0].i} is in a [DRAMA] scene but no dramatic engine was loaded")
        return self.drama.spec, self.drama

    def thresholds(self, card: Card) -> dict[str, object]:
        # The pace policy holds the stretch the gate allows to [0.75, 1.05], whatever a card calibrated.
        return {**thresholds_for(card), "stretch_range": [PACE_RANGE[0], PACE_RANGE[1]]}

    def base_inputs(self, take_pass: Pass, spoken: Sequence[SpokenLine], reasons: Sequence[str] = ()) -> TakeInputs:
        first = spoken[take_pass.lines[0].i]
        direction = _direction(first)
        voices = {line.speaker: self.roles[line.speaker].voice for line in take_pass.lines}
        spec, engine = self.route(take_pass)
        params = adapt(spec, take_pass, voices, direction.emotion if direction else None, direction.intensity if direction else None, reasons, self.lexicon or ())
        if self.air != DEFAULT_AIR:
            params["air"] = self.air  # the stored take's ending depends on it, so its key does too
        return TakeInputs(
            engine=engine.identity,
            voice="+".join(dict.fromkeys(self.roles[line.speaker].voice.card_hash for line in take_pass.lines)),
            lines=tuple(Line(speaker=line.speaker, text=line.text) for line in take_pass.lines),
            seed=0,
            direction=Direction(
                emotion=direction.emotion if direction else None,
                intensity=direction.intensity if direction and direction.emotion else None,
                pace=retake_pace(direction.pace if direction else None, reasons),
            ),
            params=params,
        )

    def _score(self, attempt_no: int, inputs: TakeInputs, synthesis: Synthesis, card: Card, target: float, band: Sequence[float]) -> tuple[dict[str, object], float]:
        # The gate judges against the script's own words (numerals and respellings are the engine's input only).
        text = " ".join(line.text for line in inputs.lines)
        path = self.scratch / f"attempt-{uuid.uuid4().hex[:8]}.wav"
        path.write_bytes(synthesis.audio.to_wav())
        started = time.monotonic()
        # The scratch copy goes when the run's temporary directory does.
        scores, ran = run_scorers(
            ScoredTake(audio=path, line=text, seconds=synthesis.audio.duration, card_embedding=card.embedding, card_reference=card.reference, respelt=respelt_words(inputs.params.get(LEXICON_PARAM))),
            self.scorers,
        )
        wall = round(time.monotonic() - started, 6)
        scores.update(derive(scores, text, synthesis.audio.duration, target, band))
        append_receipt(
            self.work,
            {"intent": "gate", "episode": self.episode, "attempt": attempt_no, "card": card.slug, "scorers": ran, "wall": wall, "audio_seconds": round(synthesis.audio.duration, 6), **self.receipt_tags},
        )
        return scores, wall

    def attempt(self, attempt_no: int, base: TakeInputs, take_pass: Pass, card: Card, target: float, band: Sequence[float], thresholds: Mapping[str, object]) -> Attempt:
        inputs = replace(base, seed=derive_seed(base, attempt_no))
        key = take_key(inputs)
        stored = read_take(self.work, key)
        if stored is not None:
            self.totals.reused += 1
            record = stored.record
            scores = dict(record.get("scores") or {})  # type: ignore[call-overload]
            gate_scores = {k: v for k, v in scores.items() if k != "verdict"}
            # The stored stretch was measured under whatever pace policy rendered it: re-measure from its wps.
            stored_wps = gate_scores.get("wps")
            if isinstance(stored_wps, (int, float)) and not isinstance(stored_wps, bool) and stored_wps > 0:
                gate_scores["stretch"] = pace_stretch(float(stored_wps), target, band)
            verdict = evaluate(gate_scores, thresholds)
            audio = record.get("audio") if isinstance(record.get("audio"), dict) else {}
            return Attempt(
                attempt=attempt_no,
                inputs=inputs,
                key=key,
                scores=gate_scores,
                verdict=verdict,
                synthesis=None,
                seconds=float(audio.get("duration", 0.0)),  # type: ignore[union-attr]
                timings=dict(record.get("timings") or {}),  # type: ignore[call-overload]
                stored_status=str(record.get("status")),
            )

        started = time.monotonic()
        synthesis = self.route(take_pass)[1].synthesize(inputs)
        wall = round(time.monotonic() - started, 6)
        seconds = synthesis.audio.duration
        self.totals.engine_wall += wall
        self.totals.rendered += 1
        if synthesis.peak_memory_gb is not None:
            self.totals.peak_memory_gb = max(self.totals.peak_memory_gb, synthesis.peak_memory_gb)
        receipt = f"r-{uuid.uuid4().hex}"
        append_receipt(
            self.work,
            {
                "id": receipt,
                "intent": "take",
                "episode": self.episode,
                "lines": [line.i for line in take_pass.lines],
                "attempt": attempt_no,
                "engine": inputs.engine.id,
                "weights_sha256": inputs.engine.weights_sha256,
                "inputs": key,
                "seed": inputs.seed,
                "wall": wall,
                "audio_seconds": round(seconds, 6),
                "rtf": round(wall / seconds, 6) if seconds else None,
                "peak_memory_gb": synthesis.peak_memory_gb,
                "ttfa": synthesis.ttfa,
                **self.receipt_tags,
            },
        )
        scores, score_wall = self._score(attempt_no, inputs, synthesis, card, target, band)
        self.totals.score_wall += score_wall
        samples, ending = finish_take(from_audio(synthesis.audio), synthesis.audio.sample_rate, scores, self.air)
        scores.update(ending)
        timings_words = scores.pop("timings", None)
        words = tuple(
            WordTiming(word=str(w["word"]), start=float(w["start"]), end=float(w["end"]))
            for w in (timings_words if isinstance(timings_words, list) else [])
            if isinstance(w, dict)
        )
        verdict = evaluate(scores, thresholds)
        kept = replace(synthesis, audio=to_audio(samples, synthesis.audio.sample_rate), words=words)
        return Attempt(
            attempt=attempt_no,
            inputs=inputs,
            key=key,
            scores=scores,
            verdict=verdict,
            synthesis=kept,
            seconds=kept.audio.duration,
            timings={"wall": wall, "score_wall": score_wall, "audio_seconds_raw": round(seconds, 6), "rtf": round(wall / seconds, 6) if seconds else None, "peak_memory_gb": synthesis.peak_memory_gb, "receipt": receipt},
            words=words,
        )

    def write(self, attempts: Sequence[Attempt], kept: Attempt) -> None:
        """Writes every new attempt once the pass is decided: the kept one as pass/best_of_failed, the rest as fail."""
        for attempt in attempts:
            if attempt.synthesis is None:
                continue
            status = ("pass" if attempt.passed else "best_of_failed") if attempt is kept else "fail"
            receipt = str(attempt.timings.get("receipt", ""))
            timings = {k: v for k, v in attempt.timings.items() if k != "receipt"}
            write_take(
                self.work,
                attempt.inputs,
                attempt.synthesis,
                attempt=attempt.attempt,
                scores={**attempt.scores, "verdict": {"pass": attempt.verdict["pass"], "failing": attempt.verdict["failing"], "flags": attempt.verdict["flags"]}},
                status=status,
                receipt=receipt,
                timings=timings,
            )

    def perform_pass(
        self,
        take_pass: Pass,
        spoken: Sequence[SpokenLine],
        *,
        first_attempt: int = 0,
        reasons: Sequence[str] = (),
    ) -> tuple[Attempt, list[Attempt], float, list[float], dict[str, object]]:
        """Up to `MAX_ATTEMPTS` attempts numbered from `first_attempt` (a fix starts past the attempts already made)."""
        first = take_pass.lines[0]
        card = self.roles[first.speaker].card
        thresholds = self.thresholds(card)
        direction = _direction(spoken[first.i])
        target, band = pace_for(card, thresholds, direction, reasons)
        base = self.base_inputs(take_pass, spoken, reasons)
        attempts: list[Attempt] = []
        for attempt_no in range(first_attempt, first_attempt + MAX_ATTEMPTS):
            attempt = self.attempt(attempt_no, base, take_pass, card, target, band, thresholds)
            attempts.append(attempt)
            if attempt.passed:
                break
        kept = choose(attempts, thresholds)
        self.write(attempts, kept)
        return kept, attempts, target, band, thresholds


def load_engine(work: Path, spec: EngineSpec, roles: Mapping[str, Role], env: Mapping[str, str], engine_factory: EngineFactory) -> tuple[PerformEngine, dict[str, object]]:
    """Makes and loads one engine, with its `load` receipt. Raises `EngineUnavailable`."""
    engine = engine_factory(spec, {name: role.voice for name, role in roles.items()}, env)
    loaded = engine.load()
    append_receipt(work, {"intent": "load", "engine": engine.identity.id, "revision": spec.revision, "weights_sha256": engine.identity.weights_sha256, **loaded})
    return engine, loaded


def _line_entry(
    line: SpokenLine,
    i: int,
    kept: Attempt,
    attempts: Sequence[Attempt],
    target: float,
    band: Sequence[float],
    segment: tuple[int, int] | None,
) -> dict[str, object]:
    scores = kept.scores
    needed = scores.get("stretch")
    needed_value = float(needed) if isinstance(needed, (int, float)) and not isinstance(needed, bool) else 1.0
    applied = round(min(PACE_RANGE[1], max(PACE_RANGE[0], needed_value)), 3)
    wps = scores.get("wps")
    status = "pass" if kept.passed else "best_of_failed"
    entry: dict[str, object] = {
        "i": i,
        "line": line.line,
        "speaker": line.speaker,
        "text": line.text,
        "direction": None if line.direction is None else {"emotion": line.direction.emotion, "intensity": line.direction.intensity, "pace": line.direction.pace},
        "take": kept.key,
        "status": status,
        "attempt": kept.attempt,
        "attempts": len(attempts),
        "stretch": applied,
        "pace": {
            "target_wps": target,
            "band": list(band),
            "wps": wps,
            "paced_wps": round(float(wps) * applied, 3) if isinstance(wps, (int, float)) and not isinstance(wps, bool) else None,
        },
        "seconds": round(kept.seconds, 3),
        "gates": {key: scores.get(key) for key in ("wer", "inserted_span", "tail_ok", "clipped", "end_db", "sim_card", "utmos", "pq", "bak", "ovrl", "wps", "stretch", "duration_ratio")},
        "failing": list(kept.verdict.get("failing", [])),  # type: ignore[call-overload]
    }
    if line.drama:
        # A dramatic take's engine is not the manifest's: the line names its own (a line without one is the manifest's engine's).
        identity = kept.inputs.engine
        entry["drama"] = True
        entry["engine"] = {"id": identity.id, "weights_sha256": identity.weights_sha256, "mlx_audio": identity.mlx_audio, "mlx": identity.mlx, **DRAMA_ENGINE.as_body()}
    if abs(applied - needed_value) > 1e-9:
        entry["stretch_needed"] = round(needed_value, 3)
    if segment is not None:
        entry["segment"] = {"index": segment[0], "of": segment[1]}
    if status == "best_of_failed":
        reason = f"best of {len(attempts)} failed: {', '.join(entry['failing']) or 'no gate'}"  # type: ignore[arg-type]
        if "stretch_needed" in entry:
            reason += f"; needed stretch {entry['stretch_needed']} outside {PACE_RANGE[0]}-{PACE_RANGE[1]}"
        entry["flag"] = reason
    return entry


def _write_auto_flags(work: Path, episode: int, lines: Sequence[Mapping[str, object]]) -> list[str]:
    """Appends one `by: auto` flag per best-of line to `flags.json` (atomically); returns their ids."""
    flagged = [line for line in lines if line.get("status") == "best_of_failed"]
    if not flagged:
        return []
    path = flags_path(work)
    raw: object = {"flags": []}
    if path.exists():
        raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or not isinstance(raw.get("flags", []), list):
        raise ManifestError(f"{path} must hold {{\"flags\": [...]}}")
    flags = list(raw.get("flags", []))
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    ids: list[str] = []
    for line in flagged:
        flag_id = f"f-auto-{stamp}-ep{episode:02d}-{line['i']}"
        ids.append(flag_id)
        flags.append({"id": flag_id, "episode": episode, "line": line["i"], "reason": line.get("flag"), "by": "auto", "take": line.get("take"), "at": now()})
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}")
    temporary.write_text(json.dumps({**raw, "flags": flags}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)
    return ids


@dataclass(frozen=True)
class PerformRequest:
    work: Path
    episode: int
    engine: str
    voices_dir: Path
    json_lines: bool = False
    stream: bool = False
    """AGT-1697: mix as the lines pass, cut segments into the listening directory, and mix the episode file at the end."""
    cues_dir: Path | None = None
    """The cue library `--stream` mixes from (`mix.cues_dir_for`)."""


def perform(
    request: PerformRequest,
    *,
    env: Mapping[str, str],
    engine_factory: EngineFactory,
    scorer_factory: Callable[[], Sequence[Scorer]],
    err: TextIO | None = None,
    out: TextIO | None = None,
    mixer: Seams | None = None,
) -> Result:
    err = err if err is not None else sys.stderr
    stream_out = (out if out is not None else sys.stdout) if request.json_lines else None
    work, episode = request.work, request.episode
    if request.stream and (mixer is None or request.cues_dir is None):
        return _error("perform --stream needs the mix's seams and a cue library")

    spec = ENGINE_SPECS.get(request.engine)
    if spec is None:
        return _refused(f'unknown engine "{request.engine}": one of {", ".join(ENGINE_SPECS)}')
    try:
        air = load_config(env).air
    except ConfigRefusal as refusal:
        return _refused(str(refusal))
    found = versions(work, episode)
    if found:
        return _refused(
            f"episode {episode} is already rendered (v{found[-1]} in {episode_dir(work, episode)}); change it with `pablo fix`, which re-records only flagged lines",
            versions=found,
        )
    located = read_episode(work, episode)
    if located is None:
        return _refused(f"no script for episode {episode} in {work}", missing=[f"episode {episode}"])
    script_path, script = located
    if not script.lines:
        return _refused(f"episode {episode}'s script ({script_path.name}) has no spoken lines")
    try:
        roles = resolve_roles(work, script, request.voices_dir)
    except PerformRefusal as refusal:
        return _refused(str(refusal), **refusal.extra)

    runs, spoken = runs_between_cues(script)
    passes = group_passes(runs, spec)
    if request.stream and mixer is not None and mixer.pacer is sox_pacer:
        try:
            require_sox()
        except SoxUnavailable as missing:
            return _refused(str(missing))

    started = time.monotonic()
    started_at = now()
    try:
        engine, loaded = load_engine(work, spec, roles, env, engine_factory)
        drama = load_engine(work, DRAMA_ENGINE, roles, env, engine_factory)[0] if any(line.drama for line in spoken) else None
    except EngineUnavailable as missing:
        return _refused(str(missing))
    scorers = list(scorer_factory())

    _emit(
        {"event": "start", "episode": episode, "engine": spec.name, **({"drama_engine": DRAMA_ENGINE.name} if drama is not None else {}), "lines": len(spoken), "passes": len(passes), "stream": request.stream},
        err,
        stream_out,
    )
    lines: list[dict[str, object]] = [{} for _ in spoken]
    live: EpisodeStream | None = None
    if request.stream and mixer is not None and request.cues_dir is not None:
        timeline = Timeline(work, cue_positions(script), mixer.cue_library(request.cues_dir), mixer.pacer, log=mixer.log)
        live = EpisodeStream(work, episode, timeline, lines_total=len(spoken), started=started, started_at=started_at)
    with tempfile.TemporaryDirectory(prefix="pablo-perform-") as scratch:
        performer = Performer(work=work, episode=episode, spec=spec, roles=roles, engine=engine, scorers=scorers, err=err, out=stream_out, scratch=Path(scratch), air=air, drama=drama)
        try:
            for take_pass in passes:
                kept, attempts, target, band, _ = performer.perform_pass(take_pass, spoken)
                count = len(take_pass.lines)
                for index, pass_line in enumerate(take_pass.lines):
                    entry = _line_entry(spoken[pass_line.i], pass_line.i, kept, attempts, target, band, (index, count) if count > 1 else None)
                    lines[pass_line.i] = entry
                    _emit(
                        {
                            "event": "line",
                            "episode": episode,
                            "i": pass_line.i,
                            "of": len(spoken),
                            "speaker": entry["speaker"],
                            "take": entry["take"],
                            "path": str(take_path(work, kept.key) / "take.wav"),
                            "status": entry["status"],
                            "attempts": entry["attempts"],
                            "stretch": entry["stretch"],
                            **({"segment": entry["segment"]} if "segment" in entry else {}),
                        },
                        err,
                        stream_out,
                    )
                if live is not None:
                    for event in live.add([lines[pass_line.i] for pass_line in take_pass.lines]):
                        _emit(event, err, stream_out)
            if live is not None:
                for event in live.finish():
                    _emit(event, err, stream_out)
        except ScorerUnavailable as missing:
            _stream_failed(live)
            return _refused(
                f"{missing}; pablo installs it with the perform verb, or run `uv sync --extra {missing.info.extra}` in packages/casting",
                missing=[missing.info.package],
            )
        except (EngineUnavailable, CueUnavailable, SoxUnavailable) as missing:
            _stream_failed(live)
            return _refused(str(missing))
        except MixRefusal as refusal:
            _stream_failed(live)
            return _refused(str(refusal), **refusal.extra)
        except Exception as failure:  # an engine or scorer crash: takes already decided stay in the store; a rerun resumes
            _stream_failed(live)
            done = sum(1 for line in lines if line)
            return _error(f"performing episode {episode} failed after {done} of {len(spoken)} lines: {type(failure).__name__}: {failure}; run it again to resume")

    totals = performer.totals
    # Delivered audio: each kept take once (a Dia pass voices several lines), at its applied stretch.
    delivered = 0.0
    seen: set[str] = set()
    for line in lines:
        key = str(line["take"])
        if key in seen:
            continue
        seen.add(key)
        delivered += float(line["seconds"]) / float(line["stretch"])  # type: ignore[arg-type]
    compute = totals.engine_wall + totals.score_wall
    wall = round(time.monotonic() - started, 3)
    rtf_total = round(compute / delivered, 4) if delivered else None
    render = {
        "wall": wall,
        "engine_wall": round(totals.engine_wall, 3),
        "score_wall": round(totals.score_wall, 3),
        "audio_seconds": round(delivered, 3),
        "rtf_engine": round(totals.engine_wall / delivered, 4) if delivered else None,
        "rtf_total": rtf_total,
        "passes": len(passes),
        "takes_rendered": totals.rendered,
        "takes_reused": totals.reused,
        "peak_memory_gb": round(totals.peak_memory_gb, 3),
        "load": loaded,
    }
    cast_pins = {name: role.voice.card_hash for name, role in sorted(roles.items())}
    try:
        flag_ids = _write_auto_flags(work, episode, lines)
        written = write_version(
            work,
            episode,
            {
                "script_sha256": hashlib.sha256(script_path.read_bytes()).hexdigest(),
                "cast_hash": _sha256_text(json.dumps(cast_pins, sort_keys=True, separators=(",", ":"))),
                "engine": {"id": engine.identity.id, "weights_sha256": engine.identity.weights_sha256, "mlx_audio": engine.identity.mlx_audio, "mlx": engine.identity.mlx, **spec.as_body()},
                "pace_policy": {"stretch_range": list(PACE_RANGE), "pace_multiplier": PACE_MULTIPLIER, "tool": "sox tempo -s (WSOLA), applied by the mix"},
                "cues": cue_positions(script),
                "duration": round(delivered, 3),
                "rtf_total": rtf_total,
                "render": render,
                **({"ttfa": dict(live.ttfa)} if live is not None else {}),
                "lines": lines,
            },
        )
    except (ManifestError, json.JSONDecodeError) as failure:
        _stream_failed(live)
        return _error(f"writing episode {episode}'s manifest failed: {failure}")

    statuses = [str(line["status"]) for line in lines]
    summary = {
        "intent": "perform",
        "episode": episode,
        "engine": spec.name,
        "version": written.manifest["version"],
        "lines": len(lines),
        "pass": statuses.count("pass"),
        "best_of_failed": statuses.count("best_of_failed"),
        **render,
        **({"stream": True, "ttfa": dict(live.ttfa)} if live is not None else {}),
    }
    append_receipt(work, {k: v for k, v in summary.items() if k != "load"})
    _emit({"event": "done", "episode": episode, "manifest": str(written.path), "rtf_total": rtf_total, "pass": summary["pass"], "best_of_failed": summary["best_of_failed"]}, err, stream_out)
    streamed: dict[str, object] = {}
    if live is not None and mixer is not None and request.cues_dir is not None:
        streamed = _mix_streamed(live, written.manifest, request.cues_dir, mixer, err, stream_out)
        if not streamed.get("ok"):
            # The takes and v1 stand; `pablo mix` completes the episode file from them.
            return {**streamed, "manifest": str(written.path), "version": written.manifest["version"]}, int(streamed.get("code", EXIT_ERROR))  # type: ignore[call-overload]
    return {
        "ok": True,
        "episode": episode,
        "engine": spec.name,
        "version": written.manifest["version"],
        "manifest": str(written.path),
        "lines": len(lines),
        "passes": len(passes),
        "pass": summary["pass"],
        "bestOfFailed": summary["best_of_failed"],
        "flags": flag_ids,
        "takesRendered": totals.rendered,
        "takesReused": totals.reused,
        "rtfTotal": rtf_total,
        "rtfEngine": render["rtf_engine"],
        "audioSeconds": render["audio_seconds"],
        "wall": wall,
        **({"stream": streamed["stream"], "audio": streamed["audio"], "ttfa": streamed["ttfa"], "segments": streamed["segments"], **{k: streamed[k] for k in ("mixBy", "rebasedMix", "supersededMix", "review") if k in streamed}} if streamed else {}),
        "message": (
            f"episode {episode} v{written.manifest['version']}: {len(lines)} lines, {summary['pass']} pass, "
            f"{summary['best_of_failed']} best-of (flagged), {totals.rendered} takes rendered, rtf_total {rtf_total}"
            + (f"; streamed, first audio after {streamed['ttfa']['first_audio']} s, mixed to {Path(str(streamed['audio'])).name}" if streamed else "")  # type: ignore[index]
            + (f"; your mix.v{streamed['rebasedMix']} was carried over" + (" (some items need a look in the mixer)" if streamed.get("review") else "") if streamed and streamed.get("rebasedMix") else "")
        ),
    }, EXIT_OK


def _stream_failed(live: EpisodeStream | None) -> None:
    if live is not None:
        try:
            live.failed()
        except OSError:
            pass  # the stream's index is a convenience; the refusal or error is what the caller needs


def _mix_streamed(
    live: EpisodeStream,
    manifest: Mapping[str, object],
    cues_dir: Path,
    mixer: Seams,
    err: TextIO,
    out: TextIO | None,
) -> Body:
    """Completes the just-written version with the streamed timeline: normalised, encoded, the link moved (the mix's own path)."""
    version = int(manifest["version"])  # type: ignore[call-overload]
    extra = {"stream": {"segments": len(live.segments), "segment_seconds": live.segment_seconds, "gain": "segments are this mix before its normalising gain"}}
    body, code = mix_episode(MixRequest(work=live.work, episode=live.episode, cues_dir=cues_dir, version=version), mixer, timeline=live.timeline, extra=extra)
    if code != EXIT_OK:
        _stream_failed(live)
        return {**body, "message": f"episode {live.episode} v{version} performed and streamed, but its episode file was not made: {body.get('message')}; run `pablo mix` to make it"}
    event = live.mixed(version, str(body.get("audio")))
    _emit(event, err, out)
    append_receipt(
        live.work,
        {"intent": "stream", "episode": live.episode, "version": version, "segments": len(live.segments), "seconds": round(live.emitted / SR, 3), "ttfa": dict(live.ttfa)},
    )
    return {"ok": True, "stream": str(live.dir), "audio": body.get("audio"), "ttfa": dict(live.ttfa), "segments": len(live.segments), **{k: body[k] for k in ("mixBy", "rebasedMix", "supersededMix", "review") if k in body}}


def cmd_perform(
    env: Mapping[str, str],
    work: Path | None,
    episode: str | None,
    engine: str | None,
    vault: str | None,
    library: str | None,
    configured_library: str | None,
    json_lines: bool,
    engine_factory: EngineFactory,
    scorer_factory: Callable[[], Sequence[Scorer]],
    *,
    stream: bool = False,
    cues: str | None = None,
    mixer: Seams | None = None,
) -> Result:
    if work is None:
        return _refused("perform needs --work <dir> (the work whose script and cast to perform)", missing=["--work"])
    if episode is None:
        return _refused("perform needs --episode N", missing=["--episode"])
    try:
        number = int(episode)
    except ValueError:
        return _error(f"--episode must be an integer, got {episode!r}")
    if number < 1:
        return _error(f"--episode must be a positive integer, got {number}")
    voices_dir = library_dir(Path(vault) if vault else None, configured_library, Path(library) if library else None)
    if voices_dir is None:
        return _refused("no voice library: pass --vault or --library, or set `library` in the casting config", missing=["library"])
    from pablo_casting.engines import DEFAULT_ENGINE
    from pablo_casting.mix import cues_dir_for

    cues_dir = cues_dir_for(work, cues, library or configured_library, vault) if stream else None
    return perform(
        PerformRequest(work=work, episode=number, engine=engine or DEFAULT_ENGINE, voices_dir=voices_dir, json_lines=json_lines, stream=stream, cues_dir=cues_dir),
        env=env,
        engine_factory=engine_factory,
        scorer_factory=scorer_factory,
        mixer=mixer,
    )


__all__ = ["MAX_ATTEMPTS", "PACE_RANGE", "PerformRequest", "choose", "cmd_perform", "pace_for", "perform"]
