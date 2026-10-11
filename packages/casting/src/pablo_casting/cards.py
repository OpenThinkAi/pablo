"""`cast`: freeze one audition candidate into a cast card.

The pick becomes the voice's identity: `reference.flac` (the candidate trimmed
by the aligner, 24 kHz mono, 20-30 s), `reference.txt` (the passage it reads),
`embedding.ecapa.npy` (from the reference) and `card.json` in the design's
shape, with the designer's provenance and the `traits` block. The card hash is
returned so the caller can print and pin it.

Synthetic voices only: the only input is a candidate `audition` wrote, checked
by the sha256 its `.json` recorded, so there is no path from an arbitrary wav
to a card (and no `--from-wav`). An existing card is never overwritten:
without `recast` it is a refusal; with it, the old card files move to
`recast/<timestamp>/` (untracked) first.
"""

from __future__ import annotations

import json
import os
import shutil
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from pablo_casting.audio import REFERENCE_RATE, file_sha256, read_audio, resample, write_flac
from pablo_casting.audition import Trim, trim_for
from pablo_casting.library import CARD_FILES, Library, LibraryRefusal, card_hash
from pablo_casting.passage import PASSAGE, PASSAGE_SHA256
from pablo_casting.receipts import append_receipt
from pablo_casting.toolkit import Aligner, Embedder, Toolkit
from pablo_casting.traits import parse_traits, require_gender

PACE_BAND = (2.4, 3.4)
"""The default words/s band for a role (design: quality gates, pace)."""

DEFAULT_GATES = {"sim_min": 0.62, "utmos_min": 3.8}

STAGING = ".cast-staging"


@dataclass(frozen=True)
class CastRequest:
    slug: str
    candidate: int
    recast: bool
    by: str
    traits: Mapping[str, object] | None
    notes: str | None
    admission: Mapping[str, object] | None = None
    """Extra fields for the card's `admitted` block: design on demand's trial evidence (AGT-1699)."""


def _stamp(at: str) -> str:
    """`2026-10-12T09:30:00.000Z` -> `20261012T093000Z`, a directory name."""
    return at.replace("-", "").replace(":", "").split(".")[0].rstrip("Z") + "Z"


def _candidate(library: Library, request: CastRequest) -> tuple[dict[str, object], Path]:
    folder = library.auditions(request.slug)
    record_path = folder / f"{request.candidate}.json"
    if not record_path.exists():
        raise LibraryRefusal(
            f'"{request.slug}" has no audition candidate {request.candidate}; run `pablo audition` first'
            + (f" (candidates: {', '.join(map(str, library.audition_numbers(request.slug)))})" if library.audition_numbers(request.slug) else ""),
            missing=[str(record_path)],
        )
    record = json.loads(record_path.read_text(encoding="utf-8"))
    audio = record.get("audio") if isinstance(record, dict) else None
    designer = record.get("designer") if isinstance(record, dict) else None
    if not isinstance(audio, dict) or not isinstance(designer, dict):
        raise LibraryRefusal(f"{record_path} is not an audition record (no designer or audio block)")
    wav = folder / str(audio.get("file", ""))
    if not wav.is_file():
        raise LibraryRefusal(f"candidate {request.candidate}'s audio is missing", missing=[str(wav)])
    if file_sha256(wav) != audio.get("sha256"):
        raise LibraryRefusal(
            f"{wav} is not the audio the designer rendered (its sha256 changed since the audition); "
            "a card's reference can only come from a designer, so audition again"
        )
    passage = record.get("passage")
    if not isinstance(passage, dict) or passage.get("sha256") != PASSAGE_SHA256:
        raise LibraryRefusal(f"candidate {request.candidate} read a different audition passage than this version's; audition again")
    return record, wav


def _discard_staging(staging: Path) -> None:
    """Removes the card's own staging directory (`.cast-staging/`): only files `cast` itself wrote."""
    shutil.rmtree(staging)


def _move(source: Path, target: Path) -> None:
    """Moves one card file: a staged file into place, or an old card file into `recast/` (never a delete)."""
    os.replace(source, target)


def _performance(engines: Mapping[str, Mapping[str, object]]) -> dict[str, object]:
    configured = engines.get("performance")
    if isinstance(configured, Mapping) and isinstance(configured.get("engine"), str):
        defaults = configured.get("defaults")
        return {"engine": configured["engine"], "defaults": dict(defaults) if isinstance(defaults, Mapping) else {}}
    # The performance engine is the bake-off's decision (C5); until the config names it, the card says so.
    return {"engine": None, "defaults": {}}


@dataclass(frozen=True)
class Frozen:
    """A candidate as a card would hold it: the aligner's trim, the 24 kHz reference and its embedding."""

    trim: Trim
    reference: np.ndarray
    embedding: np.ndarray
    aligner: Aligner
    embedder: Embedder


def freeze_reference(wav: Path, toolkit: Toolkit) -> Frozen:
    """The reference `cast` freezes from a candidate's audio; design on demand's trial clones the same one."""
    audio, rate = read_audio(wav)
    aligner = toolkit.aligner()
    trim = trim_for(aligner, audio, rate, PASSAGE)
    reference = resample(audio[int(trim.start * rate) : int(trim.end * rate)], rate, REFERENCE_RATE)
    embedder = toolkit.embedder()
    embedding = np.asarray(embedder.embed(reference, REFERENCE_RATE), dtype=np.float32)
    return Frozen(trim=trim, reference=reference, embedding=embedding, aligner=aligner, embedder=embedder)


def cast(
    library: Library,
    request: CastRequest,
    toolkit: Toolkit,
    engines: Mapping[str, Mapping[str, object]],
    now: Callable[[], str],
    work: Path | None = None,
) -> dict[str, object]:
    voice = library.voice_dir(request.slug)
    card_path = library.card_path(request.slug)
    previous: dict[str, object] | None = None
    if card_path.exists():
        previous = library.read_card(request.slug)
        if not request.recast:
            raise LibraryRefusal(
                f'"{request.slug}" already has a card ({card_hash(previous)[:12]}); '
                "pass --recast to archive it under recast/ and cast again"
            )

    record, wav = _candidate(library, request)
    traits = parse_traits(request.traits) if request.traits is not None else parse_traits(record.get("traits") or {})  # type: ignore[arg-type]
    require_gender(traits)

    frozen = freeze_reference(wav, toolkit)
    if frozen.trim.problem is not None:
        raise LibraryRefusal(f"candidate {request.candidate} cannot be a reference: {frozen.trim.problem}")
    trim, reference, embedding, aligner, embedder = frozen.trim, frozen.reference, frozen.embedding, frozen.aligner, frozen.embedder

    library.ensure_gitignore()
    at = now()
    staging = voice / STAGING
    if staging.exists():
        _discard_staging(staging)
    staging.mkdir(parents=True)
    write_flac(staging / "reference.flac", reference, REFERENCE_RATE)
    (staging / "reference.txt").write_text(PASSAGE + "\n", encoding="utf-8")
    np.save(staging / "embedding.ecapa.npy", embedding)

    designer = record["designer"]
    scores = record.get("scores") if isinstance(record.get("scores"), dict) else {}
    utmos = scores.get("utmos") if isinstance(scores, dict) else None
    gates = dict(DEFAULT_GATES)
    card: dict[str, object] = {
        "slug": request.slug,
        "description": record.get("description"),
        "designed": {
            "engine": designer["engine"],  # type: ignore[index]
            "weights_sha256": designer["weights_sha256"],  # type: ignore[index]
            "instruct": record.get("instruct"),
            "seed": record.get("seed"),
            "candidate": request.candidate,
        },
        "reference": {
            "file": "reference.flac",
            "sha256": file_sha256(staging / "reference.flac"),
            "seconds": round(len(reference) / REFERENCE_RATE, 3),
            "transcript": "reference.txt",
            "sample_rate": REFERENCE_RATE,
        },
        "embedding": {"model": embedder.model, "file": "embedding.ecapa.npy"},
        "traits": traits,
        "pace": {"wps": trim.wps, "band": list(PACE_BAND)},
        "admitted": {
            "by": request.by,
            "at": at,
            "gates": "pass" if isinstance(utmos, (int, float)) and utmos >= gates["utmos_min"] else "fail",
            "approved_takes": 0,
            **dict(request.admission or {}),
        },
        "performance": _performance(engines),
        "gates": gates,
        "created": at,
        "by": request.by,
        "notes": request.notes or "",
    }
    (staging / "card.json").write_text(json.dumps(card, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    archived: Path | None = None
    if previous is not None:
        archived = voice / "recast" / _stamp(at)
        suffix = 1
        while archived.exists():
            suffix += 1
            archived = voice / "recast" / f"{_stamp(at)}-{suffix}"
        archived.mkdir(parents=True)
        for name in CARD_FILES:
            if (voice / name).exists():
                _move(voice / name, archived / name)
    for name in CARD_FILES:
        _move(staging / name, voice / name)
    _discard_staging(staging)

    digest = card_hash(card)
    if work is not None:
        append_receipt(
            work,
            {
                "intent": "cast",
                "voice": request.slug,
                "candidate": request.candidate,
                "card_hash": digest,
                "engine": card["designed"]["engine"],  # type: ignore[index]
                "weights_sha256": card["designed"]["weights_sha256"],  # type: ignore[index]
                "seed": record.get("seed"),
                "embedder": embedder.model,
                "aligner": aligner.model,
                "audio_seconds": card["reference"]["seconds"],  # type: ignore[index]
            },
        )
    return {
        "ok": True,
        "slug": request.slug,
        "hash": digest,
        "card": str(card_path),
        "files": [str(voice / name) for name in CARD_FILES],
        **({"archived": str(archived), "previous_hash": card_hash(previous)} if previous is not None and archived is not None else {}),
        "message": f"cast {request.slug} from candidate {request.candidate}: card {digest}",
    }
