"""`audition --preview`: hear audition candidates (and library voices) on the work's own text (AGT-2298).

The fixed audition passage (`passage.py`) shows a drama voice across registers; it is the wrong test for a narrator
of an essay. A preview reads real lines of a performed output's unit (`--output narrated --unit N [--lines a-b]`),
or the neutral expository passage, in each candidate of a voice's `auditions/` and/or one library voice, cloned
through the performance engine (the one `perform` uses; Turbo by default), and writes one WAV per voice into
`<library>/voices/<slug>/auditions/previews/`, printing the paths.

A preview is a throwaway, as the Cast panel's: it writes no take, no manifest, no binding and never touches a
candidate's record or a card, so the card's provenance stays the fixed passage and casting is unchanged. Only a
`preview` receipt is written (with a work).

Lines are numbered as `perform` and the Cast panel number spoken lines (0-based, over the unit's whole script);
`--role R` keeps only that role's lines in the range, and with no `--lines` a preview reads from the start up to
`DEFAULT_WORDS` words. The default text is the unit's own lines when a unit is given, else the expository passage
for a NARRATOR, else the fixed passage.
"""

from __future__ import annotations

import json
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from pablo_casting.binding import read_episode
from pablo_casting.cast_panel import voice_ref
from pablo_casting.engines import DEFAULT_ENGINE, ENGINE_SPECS, EngineFactory, EngineUnavailable, Pass, PassLine, VoiceRef, adapt
from pablo_casting.gates import GateRefusal, load_card
from pablo_casting.lexicon import acronym_mode, load as load_lexicon
from pablo_casting.library import Library
from pablo_casting.passage import EXPOSITORY, EXPOSITORY_ID, DEFAULT_LANGUAGE, passage_by_sha, passage_for
from pablo_casting.perform import runs_between_cues
from pablo_casting.receipts import append_receipt
from pablo_casting.takes import Direction, Line, TakeInputs

SOURCES = ("work", "expository", "fixed")
DEFAULT_WORDS = 60
"""How much of a unit a preview with no `--lines` reads (about 20 s)."""
MAX_WORDS = 200
"""The most one preview reads: a take is one engine call, and a preview is for a quick listen."""
NARRATOR = "NARRATOR"


class PreviewRefusal(Exception):
    """A preview that cannot be made; a refusal (exit 2)."""

    def __init__(self, message: str, missing: list[str] | None = None) -> None:
        super().__init__(message)
        self.missing = missing or []


@dataclass(frozen=True)
class PreviewRequest:
    slug: str | None = None
    """The voice whose audition candidates are read (from `--role` or `--slug`)."""
    candidate: int | None = None
    voice: str | None = None
    """A library voice (a cast card) read as well."""
    role: str | None = None
    unit: int | None = None
    lines: str | None = None
    passage: str | None = None
    language: str = DEFAULT_LANGUAGE


@dataclass(frozen=True)
class PreviewText:
    source: str
    id: str
    speaker: str
    lines: tuple[str, ...]
    numbers: tuple[int, ...] = ()

    @property
    def words(self) -> int:
        return sum(len(line.split()) for line in self.lines)

    def tag(self) -> str:
        if self.source != "work":
            return self.id
        return f"u{self.id}-l{self.numbers[0]}-{self.numbers[-1]}"


def parse_lines(raw: str) -> tuple[int, int]:
    """`a-b` (or `a`): an inclusive range of spoken line numbers."""
    head, _, tail = raw.partition("-")
    try:
        first = int(head)
        last = int(tail) if tail else first
    except ValueError:
        raise PreviewRefusal(f'--lines must be "a-b" or "a", spoken line numbers (got {raw!r})') from None
    if first < 0 or last < first:
        raise PreviewRefusal(f"--lines {raw}: need 0 <= a <= b")
    return first, last


def resolve_text(work: Path | None, request: PreviewRequest) -> PreviewText:
    source = request.passage
    if source is None:
        source = "work" if request.unit is not None else ("expository" if (request.role or "").upper() == NARRATOR else "fixed")
    if source not in SOURCES:
        raise PreviewRefusal(f'unknown --passage "{source}": one of {", ".join(SOURCES)}')
    speaker = request.role or NARRATOR
    if source != "work":
        if request.lines is not None:
            raise PreviewRefusal(f"--lines needs the work's own text: pass --output and --unit (not --passage {source})")
        if source == "expository":
            return PreviewText("expository", EXPOSITORY_ID, speaker, (EXPOSITORY,))
        passage = passage_for(request.language)
        return PreviewText("fixed", passage.id, speaker, (passage.text,))
    if request.unit is None or work is None:
        raise PreviewRefusal("--passage work needs --project and --output <output> --unit N (the unit whose lines are read)", missing=["--unit"])
    found = read_episode(work, request.unit)
    if found is None:
        raise PreviewRefusal(f"no script for unit {request.unit} in {work}", missing=[f"unit {request.unit}"])
    _, spoken = runs_between_cues(found[1])
    numbered = [(i, line) for i, line in enumerate(spoken) if request.role is None or line.speaker == request.role]
    if request.lines is not None:
        first, last = parse_lines(request.lines)
        numbered = [(i, line) for i, line in numbered if first <= i <= last]
    if not numbered:
        what = f"role {request.role}'s " if request.role else ""
        raise PreviewRefusal(f"unit {request.unit} has none of {what}spoken lines" + (f" in {request.lines}" if request.lines else "") + f" ({len(spoken)} spoken lines, 0-{max(len(spoken) - 1, 0)})")
    if request.lines is None:
        kept: list[tuple[int, object]] = []
        words = 0
        for i, line in numbered:
            if words >= DEFAULT_WORDS:
                break
            kept.append((i, line))
            words += len(line.text.split())
        numbered = kept  # type: ignore[assignment]
    chosen = PreviewText("work", str(request.unit), speaker if request.role else numbered[0][1].speaker, tuple(line.text for _, line in numbered), tuple(i for i, _ in numbered))
    if chosen.words > MAX_WORDS:
        raise PreviewRefusal(f"those lines are {chosen.words} words; a preview reads at most {MAX_WORDS} (narrow --lines)")
    return chosen


def _candidate_voices(library: Library, slug: str, only: int | None) -> list[tuple[str, VoiceRef]]:
    numbers = library.audition_numbers(slug)
    if only is not None:
        if only not in numbers:
            raise PreviewRefusal(f"voice {slug!r} has no candidate {only} (candidates: {', '.join(map(str, numbers)) or 'none'})")
        numbers = [only]
    if not numbers:
        raise PreviewRefusal(f"voice {slug!r} has no audition candidates in {library.auditions(slug)}; run `pablo audition --role ... --describe ...` first", missing=[str(library.auditions(slug))])
    folder = library.auditions(slug)
    out: list[tuple[str, VoiceRef]] = []
    for n in numbers:
        record = json.loads((folder / f"{n}.json").read_text(encoding="utf-8"))
        passage = passage_by_sha((record.get("passage") or {}).get("sha256"))
        if passage is None:
            raise PreviewRefusal(f"candidate {n} of {slug!r} was rendered reading an unknown passage; it cannot be cloned")
        audio = record.get("audio") or {}
        out.append(
            (
                f"candidate-{n}",
                VoiceRef(card_hash=str(audio.get("sha256") or f"candidate-{slug}-{n}"), slug=f"{slug}#{n}", reference=folder / str(audio.get("file", f"{n}.wav")), transcript=passage.text, seconds=float(audio.get("seconds") or 0.0)),
            )
        )
    return out


def _library_voice(library: Library, slug: str) -> tuple[str, VoiceRef]:
    try:
        card = load_card(slug, library.root)
    except GateRefusal as refusal:
        raise PreviewRefusal(str(refusal)) from refusal
    if "retired" in card.data:
        raise PreviewRefusal(f'voice "{slug}" is retired and is never bound to a role again; preview another')
    if card.reference is None:
        raise PreviewRefusal(f"voice {slug!r} has no reference clip beside its card ({card.dir})", missing=[str(card.dir / "reference.flac")])
    return "voice", voice_ref(card, slug)


def preview(library: Library, request: PreviewRequest, work: Path | None, env: Mapping[str, str], engines: EngineFactory) -> dict[str, object]:
    if request.slug is None and request.voice is None:
        raise PreviewRefusal("audition --preview needs --role (or --slug) for a voice's candidates, and/or --voice for a library voice", missing=["--role"])
    text = resolve_text(work, request)
    targets: list[tuple[str, str, VoiceRef]] = []  # (label, folder slug, voice)
    if request.slug is not None:
        if request.candidate is not None or request.voice is None or library.audition_numbers(request.slug):
            targets += [(label, request.slug, ref) for label, ref in _candidate_voices(library, request.slug, request.candidate)]
    if request.voice is not None:
        label, ref = _library_voice(library, request.voice)
        targets.append((label, request.voice, ref))

    spec = ENGINE_SPECS[DEFAULT_ENGINE]
    take_pass = Pass(tuple(PassLine(k, text.speaker, line) for k, line in enumerate(text.lines)))
    voices: dict[str, VoiceRef] = {}
    engine = engines(spec, voices, env)
    try:
        engine.load()
    except EngineUnavailable as missing:
        raise PreviewRefusal(str(missing)) from missing
    lexicon = load_lexicon(work) if work is not None else []
    acronyms = acronym_mode(work) if work is not None else False
    results: list[dict[str, object]] = []
    for label, folder_slug, ref in targets:
        voices[text.speaker] = ref  # the engine reads its voices by speaker: one throwaway voice at a time
        params = adapt(spec, take_pass, voices, None, None, (), lexicon, acronyms)
        inputs = TakeInputs(
            engine=engine.identity,
            voice=ref.card_hash,
            lines=tuple(Line(speaker=text.speaker, text=line) for line in text.lines),
            seed=0,
            direction=Direction(emotion=None, intensity=None, pace=None),
            params=params,
        )
        started = time.monotonic()
        audio = engine.synthesize(inputs).audio
        wall = round(time.monotonic() - started, 3)
        out = library.auditions(folder_slug) / "previews" / f"{label}.{text.tag()}.wav"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(audio.to_wav())
        seconds = round(audio.duration, 3)
        if work is not None:
            append_receipt(work, {"intent": "preview", "voice": ref.slug, "text": text.tag(), "card_hash": ref.card_hash, "engine": engine.identity.id, "wall": wall, "audio_seconds": seconds})
        results.append({"voice": ref.slug, "label": label, "file": str(out), "seconds": seconds})
    return {
        "ok": True,
        "preview": True,
        "engine": spec.name,
        "text": {"source": text.source, "id": text.id, "speaker": text.speaker, "words": text.words, "lines": list(text.numbers), "preview": " ".join(text.lines)[:200]},
        "previews": results,
        "message": f"{len(results)} preview(s) reading {text.source} text ({text.words} words); the audition passage stays each card's reference, so `pablo cast` is unchanged",
    }
