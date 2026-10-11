"""Auto-casting (AGT-1698): match a script's described roles to library voices.

Design (pm project `pablo-casting`, "Automatic casting", step 2):

- A role's `CAST:` description is normalised into the cards' `traits`
  vocabulary (`traits.py`); the matcher scores every **non-retired** card in
  the shared library against it.
- **Gender is a hard filter.** The rest is weighted trait agreement: age band
  and pitch weigh 2; energy, warmth, register and era weigh 1; role kind 0.5.
  Only the fields the role asks for count, so the score is the agreement over
  the maximum the role could get, in [0, 1]. Age and pitch are ordered bands:
  a neighbouring band earns half its weight. A role that asks for nothing
  beyond its gender scores 1.0 against every card of that gender.
- **Distinctness.** A voice already bound in this story is skipped, and so is
  one whose ECAPA cosine to an already-bound voice exceeds the cut (0.75): two
  roles in one story must not sound alike. A card with no readable embedding
  cannot be shown distinct, so it is skipped once anything is bound.
- **Bands.** Bind when the best score is >= 0.8; between 0.6 and 0.8 bind and
  mark the role `review`; below 0.6, or when distinctness leaves no candidate,
  the role `needs_design` (C21 designs a voice for it).
- Roles are cast in script order (the `CAST:` line's order, episode by
  episode), greedily: each binding is "already bound" for the roles after it.

`cast.json` records `by: match`, the score, the runner-up and `review` for
each binding the matcher made. Roles already bound (by hand, a design or an
earlier auto-cast) are kept as they are and count as bound voices; a pinned
voice that has since been retired stays pinned (its card hash is unchanged),
so the story still performs.

Thresholds and weights are the casting config's `matching` block, defaulting
to the design's starting values (C23 calibrates them by ear).
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from pablo_casting.binding import BindingRefusal, cast_path, episode_files, pin_state, read_cast, write_cast
from pablo_casting.config import ConfigRefusal
from pablo_casting.library import Library, card_hash
from pablo_casting.script import Role, parse_script
from pablo_casting.traits import AGE_BANDS

DEFAULT_BIND = 0.8
DEFAULT_REVIEW = 0.6
DEFAULT_DISTINCT = 0.75
DEFAULT_WEIGHTS: dict[str, float] = {
    "age": 2.0,
    "pitch": 2.0,
    "energy": 1.0,
    "warmth": 1.0,
    "register": 1.0,
    "era": 1.0,
    "roles": 0.5,
}

PITCH_BANDS = ("low", "low-medium", "medium", "medium-high", "high")
_ORDERED: dict[str, tuple[str, ...]] = {"age": AGE_BANDS, "pitch": PITCH_BANDS}
_EPSILON = 1e-9


@dataclass(frozen=True)
class Thresholds:
    bind: float = DEFAULT_BIND
    review: float = DEFAULT_REVIEW
    distinct: float = DEFAULT_DISTINCT
    weights: Mapping[str, float] = field(default_factory=lambda: dict(DEFAULT_WEIGHTS))

    def as_body(self) -> dict[str, object]:
        return {"bind": self.bind, "review": self.review, "distinct": self.distinct, "weights": dict(self.weights)}


def _number(raw: object) -> bool:
    return isinstance(raw, (int, float)) and not isinstance(raw, bool) and math.isfinite(raw)


def thresholds_from(matching: Mapping[str, object] | None) -> Thresholds:
    """The config's `matching` block over the design's defaults. A bad value is a refusal naming it."""
    raw = dict(matching or {})
    unknown = sorted(set(raw) - {"bind", "review", "distinct", "weights"})
    if unknown:
        raise ConfigRefusal(f"casting config `matching`: unknown key {', '.join(unknown)} (bind, review, distinct, weights)")
    values: dict[str, float] = {}
    for key, default in (("bind", DEFAULT_BIND), ("review", DEFAULT_REVIEW), ("distinct", DEFAULT_DISTINCT)):
        given = raw.get(key, default)
        if not _number(given) or not 0 <= float(given) <= 1:  # type: ignore[arg-type]
            raise ConfigRefusal(f"casting config `matching.{key}` must be a number between 0 and 1 (got {given!r})")
        values[key] = float(given)  # type: ignore[arg-type]
    if values["review"] > values["bind"]:
        raise ConfigRefusal("casting config `matching.review` must not exceed `matching.bind`")
    weights = dict(DEFAULT_WEIGHTS)
    given_weights = raw.get("weights", {})
    if not isinstance(given_weights, Mapping):
        raise ConfigRefusal("casting config `matching.weights` must map trait fields to weights")
    for name, weight in given_weights.items():
        if name not in DEFAULT_WEIGHTS:
            raise ConfigRefusal(f"casting config `matching.weights`: unknown trait {name} ({', '.join(DEFAULT_WEIGHTS)})")
        if not _number(weight) or float(weight) < 0:
            raise ConfigRefusal(f"casting config `matching.weights.{name}` must be a non-negative number (got {weight!r})")
        weights[name] = float(weight)
    return Thresholds(bind=values["bind"], review=values["review"], distinct=values["distinct"], weights=weights)


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------


def _agreement(name: str, wanted: object, have: object) -> float:
    """1 for agreement, 0.5 for a neighbouring age or pitch band, else 0."""
    if have is None:
        return 0.0
    if name == "roles":
        wanted_kinds = set(wanted) if isinstance(wanted, list) else set()
        have_kinds = set(have) if isinstance(have, list) else set()
        return 1.0 if wanted_kinds & have_kinds else 0.0
    if wanted == have:
        return 1.0
    order = _ORDERED.get(name)
    if order is not None and wanted in order and have in order and abs(order.index(wanted) - order.index(have)) == 1:  # type: ignore[arg-type]
        return 0.5
    return 0.0


def score(role_traits: Mapping[str, object], card_traits: Mapping[str, object], weights: Mapping[str, float]) -> float:
    """Weighted trait agreement over what the role asks for, in [0, 1]. Gender is not scored: it filters."""
    asked = [name for name, weight in weights.items() if weight > 0 and role_traits.get(name) not in (None, [], "")]
    maximum = sum(weights[name] for name in asked)
    if maximum <= 0:
        return 1.0
    got = sum(weights[name] * _agreement(name, role_traits[name], card_traits.get(name)) for name in asked)
    return got / maximum


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    a = np.asarray(a, dtype=np.float64).ravel()
    b = np.asarray(b, dtype=np.float64).ravel()
    if a.shape != b.shape:
        return float("nan")
    denominator = float(np.linalg.norm(a) * np.linalg.norm(b))
    return float(a @ b / denominator) if denominator > 0 else float("nan")


# ---------------------------------------------------------------------------
# The library, as the matcher sees it
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Voice:
    slug: str
    hash: str
    traits: Mapping[str, object]
    retired: bool
    embedding: np.ndarray | None


def _embedding(library: Library, slug: str, card: Mapping[str, object]) -> np.ndarray | None:
    meta = card.get("embedding")
    name = meta.get("file") if isinstance(meta, Mapping) and isinstance(meta.get("file"), str) else "embedding.ecapa.npy"
    path = library.voice_dir(slug) / str(name)
    if path.parent != library.voice_dir(slug) or not path.is_file():
        return None
    try:
        vector = np.load(path, allow_pickle=False)
    except (OSError, ValueError):
        return None
    return np.asarray(vector, dtype=np.float64).ravel() if vector.size else None


def load_voices(library: Library) -> dict[str, Voice]:
    """Every cast voice in the library (retired ones too: they can still be bound voices in a story)."""
    voices: dict[str, Voice] = {}
    for slug in library.slugs():
        if not library.card_path(slug).is_file():
            continue  # auditions only, no card yet
        card = library.read_card(slug)
        traits = card.get("traits") if isinstance(card.get("traits"), Mapping) else {}
        voices[slug] = Voice(
            slug=slug,
            hash=card_hash(card),
            traits=dict(traits),  # type: ignore[arg-type]
            retired="retired" in card,
            embedding=_embedding(library, slug, card),
        )
    return voices


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Request:
    """One role to cast: its name and what the script says about it (None when undeclared)."""

    name: str
    role: Role | None


@dataclass(frozen=True)
class Outcome:
    role: str
    status: str  # "bound" | "needs_design"
    slug: str | None = None
    hash: str | None = None
    score: float | None = None
    review: bool = False
    runner_up: tuple[str, float] | None = None
    best: tuple[str, float] | None = None  # needs_design: the best (too weak) candidate, if any
    reason: str | None = None
    alike: tuple[str, ...] = ()  # candidates skipped for sounding like a bound voice


def _rounded(value: float) -> float:
    return round(value, 3)


def match(
    requests: Sequence[Request],
    voices: Mapping[str, Voice],
    bound: Mapping[str, str],
    thresholds: Thresholds,
) -> list[Outcome]:
    """Greedy, in request order. `bound` is role -> slug for the voices already in the story."""
    taken: list[str] = list(dict.fromkeys(bound.values()))
    outcomes: list[Outcome] = []
    for request in requests:
        role = request.role
        if role is None:
            outcomes.append(
                Outcome(request.name, "needs_design", reason=f"{request.name} speaks but is not on the CAST: line, so there is no gender or description to match")
            )
            continue
        gender = role.traits.get("gender")
        if gender is None and role.gender in ("f", "m", "x"):
            gender = role.gender

        alike: list[str] = []
        ranked: list[tuple[float, str]] = []
        for voice in voices.values():
            if voice.retired or voice.slug in taken:
                continue
            if gender is not None and voice.traits.get("gender") != gender:
                continue
            if not _distinct(voice, taken, voices, thresholds.distinct):
                alike.append(voice.slug)
                continue
            ranked.append((score(role.traits, voice.traits, thresholds.weights), voice.slug))
        ranked.sort(key=lambda pair: (-pair[0], pair[1]))

        if not ranked:
            why = "no library voice of that gender is left" if not alike else f"every candidate sounds like a voice already in the story ({', '.join(sorted(alike))})"
            outcomes.append(Outcome(request.name, "needs_design", reason=f"no distinct candidate: {why}", alike=tuple(sorted(alike))))
            continue
        best_score, best_slug = ranked[0]
        runner = (ranked[1][1], _rounded(ranked[1][0])) if len(ranked) > 1 else None
        if best_score + _EPSILON < thresholds.review:
            outcomes.append(
                Outcome(
                    request.name,
                    "needs_design",
                    best=(best_slug, _rounded(best_score)),
                    runner_up=runner,
                    reason=f"the best match, {best_slug}, scored {_rounded(best_score)}, below {thresholds.review}",
                    alike=tuple(sorted(alike)),
                )
            )
            continue
        taken.append(best_slug)
        outcomes.append(
            Outcome(
                request.name,
                "bound",
                slug=best_slug,
                hash=voices[best_slug].hash,
                score=_rounded(best_score),
                review=best_score + _EPSILON < thresholds.bind,
                runner_up=runner,
                alike=tuple(sorted(alike)),
            )
        )
    return outcomes


def _distinct(voice: Voice, taken: Sequence[str], voices: Mapping[str, Voice], cut: float) -> bool:
    """Whether `voice` is not too like any voice already bound (ECAPA cosine at or under the cut)."""
    for slug in taken:
        other = voices.get(slug)
        if other is None or other.embedding is None:
            continue  # a bound voice we cannot hear is not held against the candidates
        if voice.embedding is None:
            return False  # cannot show it is distinct
        similarity = cosine(voice.embedding, other.embedding)
        if math.isnan(similarity) or similarity > cut:
            return False
    return True


# ---------------------------------------------------------------------------
# `cast --auto`
# ---------------------------------------------------------------------------


def requests_for(work: Path, episode: int | None) -> tuple[list[int], list[Request]]:
    """The roles to cast, in script order, from one episode or every episode with a `CAST:` line."""
    files = episode_files(work)
    if not files:
        raise BindingRefusal(f"no radio scripts (an NN-*.md with a CAST: line) in {work}")
    if episode is not None:
        files = [(n, path) for n, path in files if n == episode]
        if not files:
            raise BindingRefusal(f"no script for episode {episode} in {work}")
    seen: dict[str, Request] = {}
    for _, path in files:
        script = parse_script(path.read_text(encoding="utf-8"))
        for name in script.role_names():
            known = seen.get(name)
            role = script.roles.get(name)
            # The first described declaration of a role wins; a later one fills an undeclared first sighting.
            if known is None or (known.role is None and role is not None):
                seen[name] = Request(name, role)
    return [n for n, _ in files], list(seen.values())


def _runner_body(runner: tuple[str, float] | None) -> dict[str, object] | None:
    return None if runner is None else {"slug": runner[0], "score": runner[1]}


def auto_cast(work: Path, library: Library, episode: int | None, thresholds: Thresholds, now: Callable[[], str]) -> dict[str, object]:
    """Match every unbound role, write the bindings to `cast.json`, and report every role in scope."""
    episodes, requests = requests_for(work, episode)
    existing = read_cast(work)
    voices = load_voices(library)
    bound = {role: str(entry.get("slug")) for role, entry in existing.items() if isinstance(entry.get("slug"), str)}
    outcomes = match([r for r in requests if r.name not in existing], voices, bound, thresholds)

    at = now()
    roles = dict(existing)
    for outcome in outcomes:
        if outcome.status != "bound":
            continue
        roles[outcome.role] = {
            "slug": outcome.slug,
            "card_hash": outcome.hash,
            "by": "match",
            "at": at,
            "score": outcome.score,
            "runner_up": _runner_body(outcome.runner_up),
            "review": outcome.review,
        }
    if any(o.status == "bound" for o in outcomes):
        write_cast(work, roles)

    by_role = {o.role: o for o in outcomes}
    bindings: list[dict[str, object]] = []
    needs_design: list[dict[str, object]] = []
    for request in requests:
        outcome = by_role.get(request.name)
        if outcome is not None and outcome.status == "needs_design":
            needs_design.append(
                {
                    "role": request.name,
                    "gender": request.role.gender if request.role else None,
                    "description": request.role.description if request.role else None,
                    "traits": dict(request.role.traits) if request.role else {},
                    "reason": outcome.reason,
                    "best": _runner_body(outcome.best),
                    "runnerUp": _runner_body(outcome.runner_up),
                    "alike": list(outcome.alike),
                }
            )
            continue
        entry = roles[request.name]
        row: dict[str, object] = {
            "role": request.name,
            "slug": entry.get("slug"),
            "cardHash": entry.get("card_hash"),
            "by": entry.get("by"),
            "score": entry.get("score"),
            "runnerUp": entry.get("runner_up"),
            "review": bool(entry.get("review", False)),
            "new": outcome is not None,
        }
        if outcome is None:
            # Kept as it was: say whether the pin still holds (a retired voice still performs).
            row["pin"] = pin_state(library.voices, entry)
        bindings.append(row)

    new = sum(1 for row in bindings if row["new"])
    review = [str(row["role"]) for row in bindings if row["new"] and row["review"]]
    parts = [f"auto-cast {new} role{'s' if new != 1 else ''}"]
    if review:
        parts.append(f"{', '.join(review)} marked review")
    if needs_design:
        parts.append(f"{', '.join(str(r['role']) for r in needs_design)} need{'s' if len(needs_design) == 1 else ''} a designed voice")
    return {
        "ok": True,
        "castFile": str(cast_path(work)),
        "episodes": episodes,
        "thresholds": thresholds.as_body(),
        "bindings": bindings,
        "needsDesign": needs_design,
        "complete": not needs_design,
        "message": "; ".join(parts),
    }
