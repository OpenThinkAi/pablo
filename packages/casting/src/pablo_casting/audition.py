"""`audition`: render N candidate voices for a role from a description.

Each candidate is the designer reading the shared audition passage with the
role's description as its instruct and its own seed. It lands in the library
as `voices/<slug>/auditions/<n>.wav` with `<n>.json` (designer, weights hash,
instruct, seed, scores, near duplicates) and `<n>.ecapa.npy`, all untracked.
Numbers continue from the voice's existing auditions, so a second round never
overwrites the first: nothing here deletes a candidate.

Scores per candidate: UTMOS (naturalness), median pitch, words/s and the trim
the aligner gives (whether the spoken span fits a 20-30 s reference), plus
pairwise ECAPA cosine to every other candidate of the round. A pair at or
above `NEAR_DUPLICATE` is marked on both sides, so a round of six that is
really three voices reads as such.
"""

from __future__ import annotations

import json
import os
import resource
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from pablo_casting.audio import REFERENCE_MAX_SECONDS, REFERENCE_MIN_SECONDS, cosine, estimate_pitch, file_sha256, write_wav
from pablo_casting.library import Library
from pablo_casting.passage import PASSAGE, PASSAGE_ID, PASSAGE_SHA256
from pablo_casting.receipts import append_receipt
from pablo_casting.toolkit import Aligner, Toolkit, Word

NEAR_DUPLICATE = 0.75
"""ECAPA cosine at or above which two candidates are "the same voice" (the design's distinctness cut)."""

LEAD_PAD = 0.10
"""Seconds kept before the first word."""
TAIL_PAD = 0.18
"""Seconds kept after the last word (the design's take trim: last word + 180 ms)."""

MAX_CANDIDATES = 24


@dataclass(frozen=True)
class Trim:
    start: float
    end: float
    words: int
    wps: float | None

    @property
    def seconds(self) -> float:
        return round(self.end - self.start, 3)

    @property
    def problem(self) -> str | None:
        if self.words == 0:
            return "the aligner found no words"
        if self.seconds < REFERENCE_MIN_SECONDS:
            return f"the spoken span is {self.seconds:.1f} s, under {REFERENCE_MIN_SECONDS:.0f} s"
        if self.seconds > REFERENCE_MAX_SECONDS:
            return f"the spoken span is {self.seconds:.1f} s, over {REFERENCE_MAX_SECONDS:.0f} s"
        return None


def trim_for(aligner: Aligner, audio: np.ndarray, rate: int, text: str) -> Trim:
    """The reference window the aligner gives: first word minus `LEAD_PAD` to last word plus `TAIL_PAD`."""
    words: list[Word] = [w for w in aligner.align(audio, rate, text) if w.end > w.start]
    total = len(audio) / float(rate)
    if not words:
        return Trim(0.0, round(total, 3), 0, None)
    first, last = words[0].start, words[-1].end
    spoken = last - first
    wps = round(len(words) / spoken, 2) if spoken > 0 else None
    return Trim(round(max(0.0, first - LEAD_PAD), 3), round(min(total, last + TAIL_PAD), 3), len(words), wps)


def _peak_rss_mb() -> float:
    # ru_maxrss is bytes on macOS, kilobytes on Linux.
    raw = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(raw / (1024 * 1024) if os.uname().sysname == "Darwin" else raw / 1024, 1)


@dataclass(frozen=True)
class AuditionRequest:
    slug: str
    role: str
    description: str
    designer: str
    n: int
    seed: int
    traits: Mapping[str, object]


def audition(
    library: Library,
    request: AuditionRequest,
    toolkit: Toolkit,
    now: Callable[[], str],
    work: Path | None = None,
    tags: Mapping[str, object] | None = None,
) -> dict[str, object]:
    """`tags` are merged into each candidate's receipt (design on demand names its role and round, AGT-1699)."""
    library.ensure_gitignore()
    folder = library.auditions(request.slug)
    folder.mkdir(parents=True, exist_ok=True)
    existing = library.audition_numbers(request.slug)
    first = (existing[-1] + 1) if existing else 1

    designer = toolkit.designer(request.designer)
    embedder = toolkit.embedder()
    mos = toolkit.mos()
    aligner = toolkit.aligner()
    weights = designer.weights_sha256()

    records: list[dict[str, object]] = []
    embeddings: list[np.ndarray] = []
    for index in range(request.n):
        number = first + index
        seed = request.seed + index
        started = time.monotonic()
        audio, rate = designer.render(request.description, PASSAGE, seed)
        wall = round(time.monotonic() - started, 3)
        wav = folder / f"{number}.wav"
        write_wav(wav, audio, rate)
        audio_seconds = round(len(audio) / float(rate), 3)

        trim = trim_for(aligner, audio, rate, PASSAGE)
        spoken = audio[int(trim.start * rate) : int(trim.end * rate)]
        embedding = embedder.embed(spoken if len(spoken) else audio, rate)
        np.save(folder / f"{number}.ecapa.npy", np.asarray(embedding, dtype=np.float32))
        embeddings.append(embedding)

        if work is not None:
            append_receipt(
                work,
                {
                    "intent": "audition",
                    "engine": designer.engine,
                    "weights_sha256": weights,
                    "inputs_sha256": _inputs_hash(request.description, seed),
                    "seed": seed,
                    "voice": request.slug,
                    "candidate": number,
                    "wall": wall,
                    "audio_seconds": audio_seconds,
                    "rtf": round(wall / audio_seconds, 4) if audio_seconds else None,
                    "peak_rss_mb": _peak_rss_mb(),
                    **(tags or {}),
                },
            )

        records.append(
            {
                "candidate": number,
                "slug": request.slug,
                "role": request.role,
                "description": request.description,
                "designer": {"name": designer.name, "engine": designer.engine, "weights_sha256": weights},
                "instruct": request.description,
                "seed": seed,
                "passage": {"id": PASSAGE_ID, "sha256": PASSAGE_SHA256},
                "audio": {"file": wav.name, "sha256": file_sha256(wav), "sample_rate": rate, "seconds": audio_seconds},
                "trim": {
                    "start": trim.start,
                    "end": trim.end,
                    "seconds": trim.seconds,
                    "ok": trim.problem is None,
                    **({"problem": trim.problem} if trim.problem else {}),
                },
                "scores": {
                    "utmos": round(float(mos.score(audio, rate)), 3),
                    "pitch_hz": estimate_pitch(spoken if len(spoken) else audio, rate),
                    "wps": trim.wps,
                    "ecapa": {},
                },
                "near_duplicates": [],
                "embedding": {"model": embedder.model, "file": f"{number}.ecapa.npy"},
                "scorers": {"mos": mos.model, "aligner": aligner.model},
                "traits": dict(request.traits),
                "toolkit": toolkit.kind,
                "wall": wall,
                "created": now(),
            }
        )

    for i, record in enumerate(records):
        pairs: dict[str, float] = {}
        near: list[int] = []
        for j, other in enumerate(records):
            if i == j:
                continue
            similarity = cosine(embeddings[i], embeddings[j])
            pairs[str(other["candidate"])] = similarity
            if similarity >= NEAR_DUPLICATE:
                near.append(int(other["candidate"]))  # type: ignore[arg-type]
        record["scores"]["ecapa"] = pairs  # type: ignore[index]
        record["near_duplicates"] = near
        (folder / f"{record['candidate']}.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")

    return {
        "ok": True,
        "slug": request.slug,
        "role": request.role,
        "library": str(library.root),
        "auditions": str(folder),
        "designer": {"name": designer.name, "engine": designer.engine, "weights_sha256": weights},
        "toolkit": toolkit.kind,
        "candidates": [
            {
                "candidate": r["candidate"],
                "seed": r["seed"],
                "file": str(folder / str(r["audio"]["file"])),  # type: ignore[index]
                "seconds": r["trim"]["seconds"],  # type: ignore[index]
                "reference_ok": r["trim"]["ok"],  # type: ignore[index]
                "scores": r["scores"],
                "near_duplicates": r["near_duplicates"],
            }
            for r in records
        ],
        "message": (
            f"{len(records)} candidates for {request.role} in {folder}; listen, then "
            f"`pablo cast --role {request.role} --candidate <n>`"
        ),
    }


def _inputs_hash(description: str, seed: int) -> str:
    import hashlib

    return hashlib.sha256(f"{PASSAGE_SHA256}\0{description}\0{seed}".encode()).hexdigest()
