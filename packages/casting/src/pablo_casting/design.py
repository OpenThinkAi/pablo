"""Design on demand and gated admission to the library (AGT-1699).

`cast --auto --design --work W` (design: "Automatic casting", step 3): every
role auto-casting could not fill (`needsDesign`) gets a voice designed for it,
unattended:

1. **Describe.** The role's traits (the `CAST:` mapper's, or the harness's
   `--role-traits` for a description the mapper could not normalise) become the
   designer's instruct through `traits.describe_traits`; the retry re-phrases it.
2. **Audition.** `audition` renders `n` candidates (default 6) of the shared
   passage into `voices/<slug>/auditions/`, as `pablo audition` does by hand.
3. **Screen.** Each candidate needs naturalness (UTMOS) at the gate's
   `utmos_min`, a median pitch inside the asked band (`PITCH_HZ`, or the
   gender's whole range when no pitch is asked), a usable 20-30 s reference,
   and an ECAPA cosine at or under the distinctness cut against **every** card
   in the library (retired ones too: they still speak in the stories that pin
   them).
4. **Trial.** A candidate that passes the screen performs `TRIAL_LINES` through
   the chosen engine (`perform.py`'s `Performer`, so the same retake loop, pace
   policy and full gate stack): every line must keep a take that passes every
   hard gate. Trial takes are scored and receipted, never written to the take
   store (no episode references them).
5. **Admit.** The best passing candidate (naturalness, then distinctness) is
   frozen through `cards.cast` with `admitted.by: "auto"` and the trial's
   evidence in the `admitted` block, and the role is bound in `cast.json` with
   `by: "design"`. A later role in the same run is screened against it.
6. **Refuse.** A round with no passing candidate is retried once with the
   re-phrased instruct and fresh seeds; a second miss is a refusal (exit 2)
   naming the role, and nothing is admitted for it. The candidates stay in
   `auditions/` (untracked; nothing here deletes one).

Receipts: each candidate's `audition` receipt, every trial `load`, `take` and
`gate` receipt (tagged `stage: design-trial` with the role, voice, round and
candidate), one `design` receipt per round, and the `cast` receipt of an
admission.
"""

from __future__ import annotations

import json
import sys
import tempfile
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import TextIO

import numpy as np

from pablo_casting.audio import REFERENCE_RATE, file_sha256, write_flac
from pablo_casting.audition import AuditionRequest, audition
from pablo_casting.binding import read_cast, write_cast
from pablo_casting.cards import DEFAULT_GATES as CARD_GATES
from pablo_casting.cards import PACE_BAND, CastRequest, cast, freeze_reference
from pablo_casting.engines import ENGINE_SPECS, EngineFactory, EngineUnavailable, Pass, PassLine, VoiceRef
from pablo_casting.gates import DEFAULT_GATES, load_card
from pablo_casting.library import Library, card_hash, slugify
from pablo_casting.matching import Voice, cosine, load_voices
from pablo_casting.passage import PASSAGE
from pablo_casting.perform import MAX_ATTEMPTS, Performer
from pablo_casting.perform import Role as PerformRole
from pablo_casting.perform import choose, pace_for
from pablo_casting.receipts import append_receipt
from pablo_casting.scorers import Scorer, ScorerUnavailable
from pablo_casting.script import SpokenLine
from pablo_casting.toolkit import Toolkit
from pablo_casting.traits import INSTRUCT_VARIANTS, describe_traits, normalise, parse_traits

DEFAULT_CANDIDATES = 6
ROUNDS = 2
"""The first try and the one retry with a re-phrased instruct (never more than `INSTRUCT_VARIANTS`)."""
assert ROUNDS <= INSTRUCT_VARIANTS

TRIAL_LINES = (
    "Good evening. The last boat came in an hour ago, and the harbour is quiet now.",
    "I checked the figures twice; they still do not add up, and I would like to know why.",
    "Get down to the dock, now! The tide is turning and the ropes will not hold!",
)
"""The trial performance: a neutral, a dry and an urgent line, the same for every candidate."""

PITCH_HZ: dict[str, dict[str, tuple[float, float]]] = {
    "f": {"low": (130.0, 175.0), "low-medium": (160.0, 200.0), "medium": (185.0, 230.0), "medium-high": (215.0, 260.0), "high": (245.0, 330.0)},
    "m": {"low": (65.0, 105.0), "low-medium": (95.0, 125.0), "medium": (110.0, 150.0), "medium-high": (135.0, 175.0), "high": (160.0, 220.0)},
}
"""Median F0 bands per asked pitch, per gender; neighbouring bands overlap, as voices do."""
GENDER_HZ: dict[str, tuple[float, float]] = {"f": (130.0, 330.0), "m": (65.0, 220.0)}
ANY_HZ = (65.0, 330.0)

TRIAL_GATES = ("wer", "inserted_span", "tail_ok", "sim_card", "utmos", "pq", "bak", "ovrl", "wps", "stretch", "duration_ratio")


class DesignRefusal(Exception):
    """No voice could be designed for a role: a refusal (exit 2) naming it."""

    def __init__(self, message: str, **extra: object) -> None:
        super().__init__(message)
        self.extra = extra


@dataclass(frozen=True)
class DesignRole:
    """A role to design for: its name, gender, the writer's description and the traits to ask for."""

    role: str
    gender: str | None
    description: str | None
    traits: Mapping[str, object]
    free_text: tuple[str, ...] = ()
    traits_from: str = "mapper"  # "mapper" | "harness"


@dataclass(frozen=True)
class DesignSettings:
    designer: str
    engine: str
    seed: int
    n: int = DEFAULT_CANDIDATES
    distinct: float = 0.75


@dataclass
class Machine:
    """The seams design runs through: the designer toolkit, the performance engine and the gate's scorers."""

    toolkit: Toolkit
    engine_factory: EngineFactory
    scorer_factory: Callable[[], Sequence[Scorer]]
    engines_config: Mapping[str, Mapping[str, object]]
    env: Mapping[str, str]
    now: Callable[[], str]
    err: TextIO = field(default_factory=lambda: sys.stderr)


def pitch_band(traits: Mapping[str, object]) -> tuple[float, float]:
    """The median-pitch band (Hz) a candidate must land in: the asked pitch for the gender, else the gender's range."""
    gender = traits.get("gender")
    pitch = traits.get("pitch")
    if isinstance(gender, str) and gender in PITCH_HZ and isinstance(pitch, str) and pitch in PITCH_HZ[gender]:
        return PITCH_HZ[gender][pitch]
    if isinstance(pitch, str) and pitch in PITCH_HZ["f"]:
        # An unspecified gender: the union of both genders' bands for that pitch.
        return (min(PITCH_HZ["f"][pitch][0], PITCH_HZ["m"][pitch][0]), max(PITCH_HZ["f"][pitch][1], PITCH_HZ["m"][pitch][1]))
    return GENDER_HZ.get(str(gender), ANY_HZ)


def design_slug(library: Library, role: str) -> str:
    """The role's slug, or `<slug>-2`, `-3`, ... when a card already holds it (a design never recasts a voice)."""
    base = slugify(role) or "voice"
    slug, k = base, 1
    while library.card_path(slug).exists():
        k += 1
        slug = f"{base}-{k}"
    return slug


def role_for(row: Mapping[str, object], overrides: Mapping[str, Mapping[str, object]]) -> DesignRole:
    """A `needsDesign` row as a role to design: the mapper's traits, or the harness's when it supplied them."""
    name = str(row["role"])
    gender = row.get("gender") if isinstance(row.get("gender"), str) else None
    description = row.get("description") if isinstance(row.get("description"), str) else None
    mapped = normalise(name, gender, description)  # type: ignore[arg-type]
    override = overrides.get(name)
    if override is not None:
        traits = parse_traits(override)
        if gender in ("f", "m", "x") and traits.get("gender") not in (None, gender):
            raise DesignRefusal(f"--role-traits gives {name} gender {traits.get('gender')}, but its CAST: line says {gender}")
        source, free = "harness", ()
    else:
        traits, source, free = dict(mapped.traits), "mapper", mapped.free_text
    if "gender" not in traits and gender in ("f", "m", "x"):
        traits = {"gender": gender, **traits}
    return DesignRole(role=name, gender=gender, description=description, traits=traits, free_text=tuple(free), traits_from=source)


def _closest(embedding: np.ndarray, voices: Mapping[str, Voice]) -> tuple[str | None, float | None]:
    """The library card the candidate sounds most like (every card, retired or not) and the ECAPA cosine."""
    best: tuple[str | None, float | None] = (None, None)
    for voice in voices.values():
        if voice.embedding is None:
            continue
        similarity = cosine(embedding, voice.embedding)
        if np.isnan(similarity):
            continue
        if best[1] is None or similarity > best[1]:
            best = (voice.slug, round(similarity, 3))
    return best


def screen(record: Mapping[str, object], embedding: np.ndarray, traits: Mapping[str, object], voices: Mapping[str, Voice], distinct: float) -> dict[str, object]:
    """The cheap gates, before any trial: naturalness, pitch vs the asked band, a usable reference, distinctness.

    `voices` is the library as `matching.load_voices` reads it, loaded once per round."""
    scores = record.get("scores") if isinstance(record.get("scores"), dict) else {}
    utmos = scores.get("utmos") if isinstance(scores, dict) else None
    pitch = scores.get("pitch_hz") if isinstance(scores, dict) else None
    trim = record.get("trim") if isinstance(record.get("trim"), dict) else {}
    band = pitch_band(traits)
    closest, similarity = _closest(embedding, voices)
    utmos_min = float(DEFAULT_GATES["utmos_min"])  # type: ignore[arg-type]
    failing: list[str] = []
    if not isinstance(utmos, (int, float)) or utmos < utmos_min:
        failing.append("naturalness")
    if not isinstance(pitch, (int, float)) or not band[0] <= pitch <= band[1]:
        failing.append("pitch")
    if not (isinstance(trim, dict) and trim.get("ok") is True):
        failing.append("reference")
    if similarity is not None and similarity > distinct:
        failing.append("distinctness")
    return {
        "utmos": utmos,
        "utmos_min": utmos_min,
        "pitch_hz": pitch,
        "pitch_band": list(band),
        "reference_ok": bool(isinstance(trim, dict) and trim.get("ok") is True),
        "closest": None if closest is None else {"slug": closest, "ecapa": similarity},
        "distinct_max": distinct,
        "failing": failing,
        "pass": not failing,
    }


@dataclass(frozen=True)
class Candidate:
    number: int
    wav: Path
    record: dict[str, object]
    screen: dict[str, object]


def _provisional(scratch: Path, slug: str, candidate: Candidate, toolkit: Toolkit) -> tuple[VoiceRef, object, str]:
    """The candidate as `cast` would freeze it, as a card in a scratch directory the engine and gates can read."""
    folder = scratch / f"candidate-{candidate.number}"
    folder.mkdir(parents=True)
    frozen = freeze_reference(candidate.wav, toolkit)
    write_flac(folder / "reference.flac", frozen.reference, REFERENCE_RATE)
    (folder / "reference.txt").write_text(PASSAGE + "\n", encoding="utf-8")
    np.save(folder / "embedding.ecapa.npy", frozen.embedding)
    seconds = round(len(frozen.reference) / REFERENCE_RATE, 3)
    reference_sha = file_sha256(folder / "reference.flac")
    data = {
        "slug": slug,
        "reference": {"file": "reference.flac", "sha256": reference_sha, "seconds": seconds, "transcript": "reference.txt", "sample_rate": REFERENCE_RATE},
        "embedding": {"model": frozen.embedder.model, "file": "embedding.ecapa.npy"},
        "pace": {"wps": frozen.trim.wps, "band": list(PACE_BAND)},
        "gates": dict(CARD_GATES),
    }
    (folder / "card.json").write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    card = load_card(str(folder), None)
    assert card.reference is not None
    voice = VoiceRef(card_hash=card_hash(data), slug=slug, reference=card.reference, transcript=PASSAGE, seconds=seconds)
    return voice, card, reference_sha


def trial(
    work: Path,
    role: str,
    slug: str,
    round_no: int,
    candidates: Sequence[Candidate],
    settings: DesignSettings,
    machine: Machine,
) -> dict[int, dict[str, object]]:
    """Each candidate performs `TRIAL_LINES` through the engine, every take scored by the full gate stack."""
    if not candidates:
        return {}
    spec = ENGINE_SPECS[settings.engine]
    results: dict[int, dict[str, object]] = {}
    with tempfile.TemporaryDirectory(prefix="pablo-design-") as raw:
        scratch = Path(raw)
        speakers: dict[int, str] = {}
        voices: dict[str, VoiceRef] = {}
        cards: dict[int, object] = {}
        references: dict[int, str] = {}
        for candidate in candidates:
            speaker = f"{role}-{candidate.number}"
            voice, card, reference_sha = _provisional(scratch, slug, candidate, machine.toolkit)
            speakers[candidate.number], voices[speaker], cards[candidate.number], references[candidate.number] = speaker, voice, card, reference_sha

        tags: dict[str, object] = {"stage": "design-trial", "role": role, "voice": slug, "round": round_no, "episode": None}
        engine = machine.engine_factory(spec, voices, machine.env)
        try:
            loaded = engine.load()
        except EngineUnavailable as missing:
            raise DesignRefusal(str(missing)) from missing
        append_receipt(work, {"intent": "load", "engine": engine.identity.id, "revision": spec.revision, "weights_sha256": engine.identity.weights_sha256, **loaded, **tags})
        scorers = list(machine.scorer_factory())
        performer = Performer(
            work=work,
            episode=0,
            spec=spec,
            roles={},
            engine=engine,
            scorers=scorers,
            err=machine.err,
            out=None,
            scratch=scratch,
        )
        for candidate in candidates:
            speaker = speakers[candidate.number]
            card = cards[candidate.number]
            performer.roles = {speaker: PerformRole(name=speaker, slug=slug, card=card, voice=voices[speaker])}  # type: ignore[arg-type]
            performer.receipt_tags = {**tags, "candidate": candidate.number}
            lines: list[dict[str, object]] = []
            passed = True
            spoken = [SpokenLine(line=k + 1, speaker=speaker, text=text, direction=None, nonverbals=()) for k, text in enumerate(TRIAL_LINES)]
            for k, text in enumerate(TRIAL_LINES):
                # `PassLine.i` indexes `spoken` (0-based, as perform numbers spoken lines);
                # `SpokenLine.line` is a script file line number (1-based), used only in reports.
                take_pass = Pass((PassLine(k, speaker, text),))
                thresholds = performer.thresholds(card)  # type: ignore[arg-type]
                target, _ = pace_for(card, thresholds, None)  # type: ignore[arg-type]
                base = performer.base_inputs(take_pass, spoken)
                attempts = []
                for attempt_no in range(MAX_ATTEMPTS):
                    attempt = performer.attempt(attempt_no, base, take_pass, card, target, thresholds)  # type: ignore[arg-type]
                    attempts.append(attempt)
                    if attempt.passed:
                        break
                kept = choose(attempts, thresholds)
                lines.append(
                    {
                        "line": k,
                        "text": text,
                        "pass": kept.passed,
                        "attempts": len(attempts),
                        "attempt": kept.attempt,
                        "take": kept.key,
                        "failing": list(kept.verdict.get("failing", [])),  # type: ignore[call-overload]
                        "gates": {name: kept.scores.get(name) for name in TRIAL_GATES},
                    }
                )
                if not kept.passed:
                    passed = False
                    break  # one failed line fails the candidate; the rest are not worth the GPU
            results[candidate.number] = {
                "pass": passed,
                "engine": spec.name,
                "engine_id": engine.identity.id,
                "weights_sha256": engine.identity.weights_sha256,
                "reference_sha256": references[candidate.number],
                "lines": lines,
            }
    return results


def _rank(candidate: Candidate) -> tuple[float, float, int]:
    """Best first: naturalness, then distinctness (furthest from the closest library voice), then the lower number."""
    utmos = candidate.screen.get("utmos")
    closest = candidate.screen.get("closest")
    similarity = closest.get("ecapa") if isinstance(closest, dict) else None
    return (
        float(utmos) if isinstance(utmos, (int, float)) else 0.0,
        -(float(similarity) if isinstance(similarity, (int, float)) else -1.0),
        -candidate.number,
    )


def design_role(work: Path, library: Library, role: DesignRole, settings: DesignSettings, machine: Machine) -> dict[str, object]:
    """Designs, trials and admits one voice for `role`, retrying once; raises `DesignRefusal` on a second miss."""
    if role.gender is None and "gender" not in role.traits:
        raise DesignRefusal(
            f"no voice could be cast for {role.role}: it speaks but is not on the CAST: line, so there is no gender or description to design from",
            role=role.role,
        )
    slug = design_slug(library, role.role)
    rounds: list[dict[str, object]] = []
    for round_no in range(1, ROUNDS + 1):
        instruct = describe_traits(role.traits, role.free_text, variant=round_no - 1)
        seed = settings.seed + (round_no - 1) * settings.n
        tags = {"stage": "design", "role": role.role, "round": round_no}
        rendered = audition(
            library,
            AuditionRequest(slug=slug, role=role.role, description=instruct, designer=settings.designer, n=settings.n, seed=seed, traits=role.traits),
            machine.toolkit,
            machine.now,
            work,
            tags=tags,
        )
        folder = library.auditions(slug)
        voices = load_voices(library)  # once per round: an earlier role's admission in this run counts
        candidates: list[Candidate] = []
        for row in rendered["candidates"]:  # type: ignore[union-attr]
            number = int(row["candidate"])  # type: ignore[index]
            record = json.loads((folder / f"{number}.json").read_text(encoding="utf-8"))
            embedding = np.load(folder / f"{number}.ecapa.npy", allow_pickle=False)
            candidates.append(Candidate(number, folder / f"{number}.wav", record, screen(record, embedding, role.traits, voices, settings.distinct)))
        screened = [c for c in candidates if c.screen["pass"]]
        trials = trial(work, role.role, slug, round_no, screened, settings, machine)
        passing = sorted((c for c in screened if trials.get(c.number, {}).get("pass")), key=_rank, reverse=True)
        chosen = passing[0] if passing else None
        summary = {
            "round": round_no,
            "instruct": instruct,
            "seed": seed,
            "candidates": [
                {
                    "candidate": c.number,
                    "screen": c.screen,
                    **({"trial": trials[c.number]} if c.number in trials else {}),
                    "pass": bool(c.screen["pass"] and trials.get(c.number, {}).get("pass")),
                }
                for c in candidates
            ],
            "chosen": chosen.number if chosen else None,
        }
        rounds.append(summary)
        append_receipt(
            work,
            {
                "intent": "design",
                "role": role.role,
                "voice": slug,
                "round": round_no,
                "designer": rendered["designer"],
                "instruct": instruct,
                "seed": seed,
                "candidates": len(candidates),
                "screened": [c.number for c in screened],
                "passed": [c.number for c in passing],
                "chosen": summary["chosen"],
            },
        )
        if chosen is None:
            continue

        admission = {
            "gates": "pass",
            "round": round_no,
            "candidate": chosen.number,
            "instruct": instruct,
            "traits_from": role.traits_from,
            "screen": chosen.screen,
            "trial": trials[chosen.number],
        }
        written = cast(
            library,
            CastRequest(
                slug=slug,
                candidate=chosen.number,
                recast=False,
                by="auto",
                traits=role.traits,
                notes=f"designed on demand for {role.role}: round {round_no}, candidate {chosen.number} of {len(candidates)}",
                admission=admission,
            ),
            machine.toolkit,
            machine.engines_config,
            machine.now,
            work,
        )
        return {
            "role": role.role,
            "slug": slug,
            "hash": written["hash"],
            "card": written["card"],
            "round": round_no,
            "candidate": chosen.number,
            "instruct": instruct,
            "traitsFrom": role.traits_from,
            "rounds": rounds,
        }

    tried = sum(len(r["candidates"]) for r in rounds)  # type: ignore[arg-type]
    raise DesignRefusal(
        f"no voice could be cast for {role.role}: {tried} candidates over {len(rounds)} rounds (the second re-phrased), none passed every gate",
        role=role.role,
        slug=slug,
        rounds=rounds,
    )


def design_needed(
    work: Path,
    library: Library,
    auto_body: Mapping[str, object],
    overrides: Mapping[str, Mapping[str, object]],
    settings: DesignSettings,
    machine: Machine,
) -> tuple[dict[str, object], int]:
    """Designs a voice for every `needsDesign` role of an auto-cast, binds each with `by: design`, and reports.

    Every role is attempted; any role with no passing voice makes the whole call a
    refusal (exit 2) naming it, while the roles that were designed stay admitted
    and bound.
    """
    needs = [row for row in auto_body.get("needsDesign", []) if isinstance(row, dict)]  # type: ignore[union-attr]
    unknown = sorted(set(overrides) - {str(row["role"]) for row in needs})
    if unknown:
        raise DesignRefusal(f"--role-traits names {', '.join(unknown)}, which {'is' if len(unknown) == 1 else 'are'} not waiting for a designed voice")
    designed: list[dict[str, object]] = []
    refused: list[dict[str, object]] = []
    for row in needs:
        try:
            role = role_for(row, overrides)
            result = design_role(work, library, role, settings, machine)
        except DesignRefusal as refusal:
            refused.append({"role": row["role"], "message": str(refusal), **{k: v for k, v in refusal.extra.items() if k != "role"}})
            continue
        except ScorerUnavailable as missing:
            raise DesignRefusal(
                f"{missing}; pablo installs it with `cast --auto --design`, or run `uv sync --extra {missing.info.extra}` in packages/casting",
                missing=[missing.info.package],
            ) from missing
        roles = read_cast(work)
        roles[role.role] = {
            "slug": result["slug"],
            "card_hash": result["hash"],
            "by": "design",
            "at": machine.now(),
            "round": result["round"],
            "candidate": result["candidate"],
        }
        write_cast(work, roles)
        designed.append(result)

    bindings = [dict(b) for b in auto_body.get("bindings", []) if isinstance(b, dict)]  # type: ignore[union-attr]
    for result in designed:
        bindings.append(
            {
                "role": result["role"],
                "slug": result["slug"],
                "cardHash": result["hash"],
                "by": "design",
                "score": None,
                "runnerUp": None,
                "review": False,
                "new": True,
            }
        )
    still = [row for row in needs if row["role"] in {r["role"] for r in refused}]
    parts = [str(auto_body.get("message", ""))] if not needs else []
    if designed:
        admitted = ", ".join(f"{d['role']} -> {d['slug']}" for d in designed)
        parts.append(f"designed and admitted {admitted}")
    if refused:
        parts.append("; ".join(str(r["message"]) for r in refused))
    body: dict[str, object] = {
        **dict(auto_body),
        "bindings": bindings,
        "needsDesign": still,
        "designed": designed,
        "refused": refused,
        "complete": not still,
        "message": "; ".join(p for p in parts if p) or "nothing needed a designed voice",
    }
    if refused:
        return {**body, "ok": False, "code": 2}, 2
    return body, 0
