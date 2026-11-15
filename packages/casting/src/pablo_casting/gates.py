"""The gate table: thresholds, derived measures and the pass/fail judgement.

The design's gate table (`pm project show pablo-casting`, "Quality gates and
thresholds to calibrate") is `DEFAULT_GATES` here. A card's `gates` block
overrides any of them (`{"sim_min": 0.62, "utmos_min": 3.8}`), and its
`pace.band` / `pace.wps` set the role's pace band and target. A take passes when
every hard gate passes; the emotion gate is soft (a flag, never a failure).

| gate        | measures                    | default                      | hard |
|-------------|-----------------------------|------------------------------|------|
| words       | wer, inserted_span          | wer <= 0.05, span <= 2       | yes  |
| tail        | tail_ok, clipped            | required; not clipped        | yes  |
| pronounce   | pronounce_missed            | none missed                  | yes, when scored |
| identity    | sim_card                    | >= 0.60                      | yes  |
| consistency | sim_role_centroid           | >= 0.65                      | once >= 10 approved takes |
| naturalness | utmos (and pq if pq_min)    | utmos >= 3.8                 | yes  |
| artefacts   | bak, ovrl                   | >= 3.7 / >= 2.8              | yes  |
| pace        | stretch (wps)               | stretch 0.75-1.20            | yes  |
| emotion     | emotion_top2                | top-2 holds the asked class  | no (flag) |
| duration    | seconds vs words / wps      | within 60%                   | yes  |

The pronounce gate (AGT-2307, `phonemes.py`) is judged only for a take that had
an acronym or respelling to check (the phoneme scorer then sets
`pronounce_missed`); otherwise, and when casting.json turns it off (the
thresholds carry `pronounce: False`, `PRONOUNCE_OFF`), it is skipped.

The pace gate judges the stretch a take needs (the factor that brings its
`wps` into the role's band, or to the target without a band); `wps` is held to
the band widened by what that stretch range can pace (`low / high_stretch` to
`high / low_stretch`), so the two never disagree.

**Calibration (AGT-2321).** The artefacts and pace defaults were fitted with
`gate calibrate` (the 5th percentile of approved takes; `stretch_range` is
[p5, p95]) on 244 takes the author heard and used: the latest render of every
episode of two narrated essays (90 lines) and of one radio-drama episode (154
lines). Pooled fits: `bak` p5 3.736, `ovrl` p5 2.803, `stretch` [0.769, 1.200]
(the essays alone: `ovrl` 3.31-3.41, `bak` 4.09-4.18; the drama's designed
voices pulled the pool down, and the drama is where `cast --auto --design`
runs). The old 4.0 / 3.5 refused 179 of the 244 on artefacts (`ovrl` never
went above 3.61), and the old pace gate (raw `wps` in the band, which made the
stretch range moot) refused 115. Defaults are the fits rounded down to 0.05;
the stretch floor stays 0.75 (the fit, 0.769, was stricter). Words, identity
and naturalness were not loosened.

Pure Python: the scores come from `scorers.py` (or a stored record), so this
module is what the default tests exercise.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from pablo_casting.library import Library, LibraryRefusal
from pablo_casting.words import script_word_count

DEFAULT_GATES: dict[str, object] = {
    "wer_max": 0.05,
    "inserted_span_max": 2,
    "sim_min": 0.60,
    "centroid_min": 0.65,
    "centroid_min_takes": 10,
    "utmos_min": 3.8,
    "pq_min": None,  # Audiobox PQ is a second opinion: reported, gated only when a card (or calibration) sets it
    "bak_min": 3.7,  # AGT-2321: approved takes' p5 3.736 (was 4.0)
    "ovrl_min": 2.8,  # AGT-2321: approved takes' p5 2.803 (was 3.5)
    "wps_band": [2.4, 3.4],
    "stretch_range": [0.75, 1.2],  # AGT-2321: approved takes' [p5, p95] [0.769, 1.200] (was [0.75, 1.05])
    "duration_tolerance": 0.6,
}

GATE_NAMES = ("words", "tail", "pronounce", "identity", "consistency", "naturalness", "artefacts", "pace", "emotion", "duration")
SOFT_GATES = frozenset({"emotion"})

PRONOUNCE_OFF: dict[str, object] = {"pronounce": False}
"""Merged into the thresholds when casting.json sets `pronounce.gate: false`; not a card threshold."""

_PAIRS = ("wps_band", "stretch_range")
_INTEGERS = ("inserted_span_max", "centroid_min_takes")


class GateRefusal(Exception):
    """A card or a threshold block that cannot be used; a refusal (exit 2)."""


def validate_gates(block: Mapping[str, object], where: str) -> dict[str, object]:
    """Checks a `gates` block (a card's, or a calibration's) key by key."""
    out: dict[str, object] = {}
    for key, value in block.items():
        if key not in DEFAULT_GATES:
            raise GateRefusal(f"{where}: unknown gate threshold `{key}`; known: {', '.join(DEFAULT_GATES)}")
        if value is None and key == "pq_min":
            out[key] = None
        elif key in _PAIRS:
            if (
                not isinstance(value, list)
                or len(value) != 2
                or not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in value)
                or value[0] > value[1]
            ):
                raise GateRefusal(f"{where}: `{key}` must be [low, high]")
            out[key] = [float(value[0]), float(value[1])]
        elif key in _INTEGERS:
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                raise GateRefusal(f"{where}: `{key}` must be a whole number >= 0")
            out[key] = value
        else:
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                raise GateRefusal(f"{where}: `{key}` must be a number")
            out[key] = float(value)
    return out


@dataclass(frozen=True)
class Card:
    """What the gates need from a cast card: its thresholds, pace and identity files."""

    slug: str
    dir: Path
    path: Path
    data: dict[str, object]
    gates: dict[str, object]
    target_wps: float | None
    band: list[float] | None
    embedding: Path | None
    reference: Path | None


def load_card(ref: str, root: Path | None) -> Card:
    """Reads `card.json` for `ref`: a card directory, or a voice slug in the library at `root`.

    A slug resolves through `library.py` (`<root>/voices/<slug>/card.json`), the one place that
    knows where `cast` writes a card."""
    as_dir = Path(ref)
    if (as_dir / "card.json").is_file():
        card_dir = as_dir
    else:
        if root is None:
            raise GateRefusal(
                f'card "{ref}" is not a card directory and no voice library is known (pass --library or --vault, or set `library` in casting.json)'
            )
        try:
            card_dir = Library(root).voice_dir(ref)
        except LibraryRefusal as refusal:
            raise GateRefusal(f'card "{ref}" is not a voice slug') from refusal
    path = card_dir / "card.json"
    if not path.is_file():
        raise GateRefusal(f'no card "{ref}": {path} does not exist')
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as failure:
        raise GateRefusal(f"{path} is not valid JSON: {failure}") from failure
    if not isinstance(data, dict):
        raise GateRefusal(f"{path} must hold a JSON object")

    raw_gates = data.get("gates", {})
    if not isinstance(raw_gates, dict):
        raise GateRefusal(f"{path}: `gates` must be an object")
    gates = validate_gates(raw_gates, str(path))

    pace = data.get("pace", {})
    target: float | None = None
    band: list[float] | None = None
    if isinstance(pace, dict):
        if isinstance(pace.get("wps"), (int, float)) and not isinstance(pace.get("wps"), bool) and pace["wps"] > 0:
            target = float(pace["wps"])
        if "band" in pace:
            band = validate_gates({"wps_band": pace["band"]}, f"{path}: pace.band")["wps_band"]  # type: ignore[assignment]

    def _file(section: str) -> Path | None:
        block = data.get(section)
        if isinstance(block, dict) and isinstance(block.get("file"), str):
            candidate = card_dir / block["file"]
            # A card names files beside itself; never follow one out of its directory.
            if candidate.resolve().parent == card_dir.resolve() and candidate.is_file():
                return candidate
        return None

    return Card(
        slug=str(data.get("slug") or card_dir.name),
        dir=card_dir,
        path=path,
        data=data,
        gates=gates,
        target_wps=target,
        band=band,
        embedding=_file("embedding"),
        reference=_file("reference"),
    )


def thresholds_for(card: Card | None) -> dict[str, object]:
    """Package defaults, then the card's pace band, then the card's `gates` block."""
    effective = dict(DEFAULT_GATES)
    if card is not None:
        if card.band is not None:
            effective["wps_band"] = card.band
        effective.update(card.gates)
    return effective


def target_wps(thresholds: Mapping[str, object], card: Card | None) -> float:
    """The role's pace target: the card's `pace.wps`, else the middle of its band."""
    if card is not None and card.target_wps is not None:
        return card.target_wps
    low, high = thresholds["wps_band"]  # type: ignore[misc]
    return (float(low) + float(high)) / 2


def pace_stretch(wps: float, target: float, band: Sequence[float] | None = None) -> float:
    """The tempo factor for a line read at `wps`: 1.0 inside the band, else to the nearest band edge.

    Without a band the factor brings `wps` to `target` exactly (the gate
    command's reading). Below 1 slows the take down.
    """
    if band is None:
        return round(target / wps, 3)
    low, high = float(band[0]), float(band[1])
    if low <= wps <= high:
        return 1.0
    return round((low if wps < low else high) / wps, 3)


def derive(scores: Mapping[str, object], line: str | None, seconds: float | None, target: float, band: Sequence[float] | None = None) -> dict[str, object]:
    """Pace and duration from the aligner's timings (or Whisper's last-word end), the line and the audio length.

    `wps` is script words over the spoken span (first aligned word's start to
    the last one's end; without timings, Whisper's word end, else the whole take).
    `stretch` is the tempo factor that brings `wps` to the role's target (below
    1 slows the take down); given the line's pace `band`, a `wps` inside it is
    left alone (1.0) and one outside goes to the nearest band edge. `duration_ratio` is audio seconds over the seconds
    the line should take at the target pace. A stored record's own values are
    kept when there is nothing to recompute them from.
    """
    out: dict[str, object] = {}
    words = script_word_count(line) if line else None
    timings = scores.get("timings")
    spoken: float | None = None
    if isinstance(timings, list) and timings:
        spoken = float(timings[-1]["end"]) - float(timings[0]["start"])  # type: ignore[index]
    elif isinstance(scores.get("word_end"), (int, float)) and not isinstance(scores.get("word_end"), bool):
        spoken = float(scores["word_end"])  # type: ignore[arg-type]
    elif isinstance(scores.get("cut"), (int, float)):  # a record from before AGT-1789
        spoken = float(scores["cut"])  # type: ignore[arg-type]
    elif seconds is not None:
        spoken = seconds
    if words and spoken is not None:
        wps = words / max(0.5, spoken)
        out["wps"] = round(wps, 3)
        out["stretch"] = pace_stretch(wps, target, band)
    if words and seconds is not None:
        expected = words / target
        out["seconds"] = round(seconds, 3)
        out["expected_seconds"] = round(expected, 3)
        out["duration_ratio"] = round(seconds / expected, 3)
    return out


def paceable_band(thresholds: Mapping[str, object]) -> list[float]:
    """The words/s a take may be read at: the role's band widened by what the stretch range can pace.

    A take at `wps` needs `edge / wps` to reach its band, so a stretch inside
    [lo, hi] reaches it from `band_low / hi` up to `band_high / lo`.
    """
    low, high = (float(v) for v in thresholds["wps_band"])  # type: ignore[union-attr]
    s_low, s_high = (float(v) for v in thresholds["stretch_range"])  # type: ignore[union-attr]
    return [round(low / s_high, 3) if s_high > 0 else 0.0, round(high / s_low, 3) if s_low > 0 else float("inf")]


def misses(verdict: Mapping[str, object]) -> dict[str, list[dict[str, object]]]:
    """How far each failing hard gate missed, measure by measure (AGT-2321).

    One entry per failing measure: `measure`, `value`, the `op` and `limit` it
    was held to, and `miss`, the distance to the limit (None for a yes/no
    measure, or a `reason` when the gate was not scored).
    """
    out: dict[str, list[dict[str, object]]] = {}
    gates = verdict.get("gates") if isinstance(verdict.get("gates"), dict) else {}
    for name in verdict.get("failing", []) or []:  # type: ignore[union-attr]
        gate = gates.get(name) if isinstance(gates, dict) else None
        if not isinstance(gate, dict):
            continue
        if "reason" in gate:
            out[str(name)] = [{"reason": gate["reason"]}]
            continue
        measures = gate.get("measures", {})
        entries: list[dict[str, object]] = []
        for label, limit in (gate.get("thresholds") or {}).items():
            measure, op = str(label).rsplit(" ", 1)
            value = measures.get(measure)
            miss: float | None = None
            if op == "is":
                if value is limit:
                    continue
            elif op == "in":
                low, high = limit  # type: ignore[misc]
                if low <= value <= high:  # type: ignore[operator]
                    continue
                miss = round(low - value if value < low else value - high, 3)  # type: ignore[operator]
            elif op == ">=":
                if value >= limit:  # type: ignore[operator]
                    continue
                miss = round(limit - value, 3)  # type: ignore[operator]
            elif op == "<=":
                if value <= limit:  # type: ignore[operator]
                    continue
                miss = round(value - limit, 3)  # type: ignore[operator]
            entries.append({"measure": measure, "value": value, "op": op, "limit": limit, "miss": miss})
        out[str(name)] = entries
    return out


def miss_size(entries: Sequence[Mapping[str, object]]) -> float:
    """One gate's miss as a single number to compare candidates by: the worst miss relative to its limit."""
    worst = 0.0
    for entry in entries:
        miss, limit = entry.get("miss"), entry.get("limit")
        if not isinstance(miss, (int, float)):
            return float("inf")  # a yes/no measure failed, or the gate was not scored
        if isinstance(limit, list):
            scale = max(abs(float(limit[0])), abs(float(limit[1])), 1e-9)
        else:
            scale = max(abs(float(limit)), 1e-9)  # type: ignore[arg-type]
        worst = max(worst, float(miss) / scale)
    return worst


def describe_misses(found: Mapping[str, Sequence[Mapping[str, object]]]) -> str:
    """`misses()` as one line: `artefacts: ovrl 2.71 vs >= 2.8 (short 0.09); pace: stretch 1.31 vs 0.75-1.2 (out 0.11)`."""
    parts: list[str] = []
    for name, entries in found.items():
        said: list[str] = []
        for entry in entries:
            if "reason" in entry:
                said.append(str(entry["reason"]))
                continue
            value, op, limit, miss = entry["value"], entry["op"], entry["limit"], entry["miss"]
            if op == "is":
                said.append(f"{entry['measure']} {value} (needs {limit})")
            elif op == "in":
                low, high = limit  # type: ignore[misc]
                said.append(f"{entry['measure']} {value} vs {low:g}-{high:g} (out {miss:g})")
            else:
                said.append(f"{entry['measure']} {value} vs {op} {limit:g} ({'short' if op == '>=' else 'over'} {miss:g})")
        parts.append(f"{name}: {', '.join(said)}")
    return "; ".join(parts)


def _num(scores: Mapping[str, object], key: str) -> float | None:
    value = scores.get(key)
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def evaluate(
    scores: Mapping[str, object],
    thresholds: Mapping[str, object],
    *,
    centroid_takes: int = 0,
    emotion: str | None = None,
) -> dict[str, object]:
    """Judges `scores` against `thresholds`. Returns `pass`, `failing`, `flags` and per-gate detail."""
    gates: dict[str, dict[str, object]] = {}

    def gate(name: str, hard: bool, checks: list[tuple[str, float | bool | None, str, object]]) -> None:
        # Each check is (measure, value, op, limit); a missing value fails a hard gate.
        measures = {measure: value for measure, value, _, _ in checks}
        limits = {f"{measure} {op}": limit for measure, _, op, limit in checks}
        missing = [measure for measure, value, _, _ in checks if value is None]
        if missing:
            gates[name] = {"hard": hard, "pass": False, "measures": measures, "thresholds": limits, "reason": f"not scored: {', '.join(missing)}"}
            return
        ok = True
        for _, value, op, limit in checks:
            if op == "<=":
                ok &= value <= limit  # type: ignore[operator]
            elif op == ">=":
                ok &= value >= limit  # type: ignore[operator]
            elif op == "in":
                low, high = limit  # type: ignore[misc]
                ok &= low <= value <= high  # type: ignore[operator]
            elif op == "is":
                ok &= value is limit
        gates[name] = {"hard": hard, "pass": bool(ok), "measures": measures, "thresholds": limits}

    def skip(name: str, why: str, measures: dict[str, object]) -> None:
        gates[name] = {"hard": False, "pass": None, "measures": measures, "skipped": why}

    gate("words", True, [
        ("wer", _num(scores, "wer"), "<=", thresholds["wer_max"]),
        ("inserted_span", _num(scores, "inserted_span"), "<=", thresholds["inserted_span_max"]),
    ])
    tail = scores.get("tail_ok")
    tail_checks: list[tuple[str, float | bool | None, str, object]] = [("tail_ok", tail if isinstance(tail, bool) else None, "is", True)]
    clipped = scores.get("clipped")
    if isinstance(clipped, bool):  # the clipping detector (ending.py); a record from before it is judged on tail_ok alone
        tail_checks.append(("clipped", clipped, "is", False))
    gate("tail", True, tail_checks)
    missed = scores.get("pronounce_missed")
    if thresholds.get("pronounce", True) is False:
        skip("pronounce", "off in casting.json (pronounce.gate)", {"pronounce_missed": missed})
    elif not isinstance(missed, list):
        skip("pronounce", "no acronym or respelling to check", {"pronounce_missed": None})
    else:
        gates["pronounce"] = {"hard": True, "pass": not missed, "measures": {"pronounce_missed": missed, "pronounce": scores.get("pronounce")}, "thresholds": {"pronounce_missed": []}}
    gate("identity", True, [("sim_card", _num(scores, "sim_card"), ">=", thresholds["sim_min"])])

    centroid = _num(scores, "sim_role_centroid")
    needed = int(thresholds["centroid_min_takes"])  # type: ignore[call-overload]
    if centroid is None:
        skip("consistency", "no role centroid given", {"sim_role_centroid": None})
    elif centroid_takes < needed:
        skip("consistency", f"the centroid has {centroid_takes} approved takes; hard from {needed}", {"sim_role_centroid": centroid})
    else:
        gate("consistency", True, [("sim_role_centroid", centroid, ">=", thresholds["centroid_min"])])

    naturalness: list[tuple[str, float | bool | None, str, object]] = [("utmos", _num(scores, "utmos"), ">=", thresholds["utmos_min"])]
    if thresholds.get("pq_min") is not None:
        naturalness.append(("pq", _num(scores, "pq"), ">=", thresholds["pq_min"]))
    gate("naturalness", True, naturalness)
    gate("artefacts", True, [
        ("bak", _num(scores, "bak"), ">=", thresholds["bak_min"]),
        ("ovrl", _num(scores, "ovrl"), ">=", thresholds["ovrl_min"]),
    ])
    gate("pace", True, [
        ("wps", _num(scores, "wps"), "in", paceable_band(thresholds)),
        ("stretch", _num(scores, "stretch"), "in", thresholds["stretch_range"]),
    ])

    top2 = scores.get("emotion_top2")
    if emotion is None:
        skip("emotion", "no emotion asked for", {"emotion_top2": top2})
    elif not isinstance(top2, list):
        skip("emotion", "emotion was not scored", {"emotion_top2": None})
    else:
        gates["emotion"] = {"hard": False, "pass": emotion.lower() in [str(t).lower() for t in top2], "measures": {"emotion_top2": top2}, "thresholds": {"contains": emotion}}

    ratio = _num(scores, "duration_ratio")
    tolerance = float(thresholds["duration_tolerance"])  # type: ignore[arg-type]
    gate("duration", True, [("duration_ratio", ratio, "in", [round(1 - tolerance, 3), round(1 + tolerance, 3)])])

    failing = [name for name in GATE_NAMES if gates[name]["hard"] and gates[name]["pass"] is False]
    flags = [name for name in GATE_NAMES if name in SOFT_GATES and gates[name]["pass"] is False]
    return {"pass": not failing, "failing": failing, "flags": flags, "gates": gates}
