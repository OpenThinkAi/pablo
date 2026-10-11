"""`gate` and `gate calibrate`: the commands over `scorers`, `gates` and `calibrate`.

    gate <take.wav> --line "<script line>" --card <slug|dir> [--centroid <file.json>] [--emotion <class>]
    gate --scores <record.json> --card <slug|dir> [--line "..."] [--centroid ...] [--emotion ...]
    gate calibrate --approved <dir> [--others <dir>] [--card <slug|dir>] [--apply]

`gate` scores a take with the full stack and judges it against the card's
thresholds (package defaults where the card sets none). A failing take is an
answer, not a refusal: exit 0 with `pass: false` and the failing gate names.
`--scores` re-judges a stored record (a previous `gate --json` body or a
`take.json`) without loading any model, e.g. after a calibration.

`gate calibrate` fits thresholds from score records (see `calibrate.py`),
prints the proposed `gates` block, and writes nothing unless `--apply` is
given, when it merges the block into the card's `card.json` (which changes
the card hash, so a `cast.json` pin on it will need rebinding).

A role centroid file is `{"embedding": [floats], "takes": <approved takes it averages>}`.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
import wave
from collections.abc import Mapping, Sequence
from pathlib import Path

from pablo_casting.calibrate import CalibrationRefusal, calibrate, read_records, scores_of
from pablo_casting.config import ConfigRefusal, load_config
from pablo_casting.gates import Card, GateRefusal, derive, evaluate, load_card, target_wps, thresholds_for, validate_gates
from pablo_casting.library import LibraryRefusal, resolve_root
from pablo_casting.receipts import append_receipt
from pablo_casting.scorers import Scorer, ScorerFactory, ScorerUnavailable, Take


EXIT_OK = 0
EXIT_ERROR = 1
EXIT_REFUSED = 2


Body = dict[str, object]
Result = tuple[Body, int]


def _refused(message: str, **extra: object) -> Result:
    return {"ok": False, "code": EXIT_REFUSED, "message": message, **extra}, EXIT_REFUSED


def _error(message: str) -> Result:
    return {"ok": False, "code": EXIT_ERROR, "message": message}, EXIT_ERROR


def audio_seconds(path: Path) -> float:
    """The take's length: the stdlib reads WAV; anything else needs soundfile (the `scorers` extra)."""
    try:
        with wave.open(str(path), "rb") as handle:
            return handle.getnframes() / float(handle.getframerate())
    except (wave.Error, EOFError):
        pass
    try:
        import soundfile
    except ImportError as missing:
        raise GateRefusal(f"{path} is not a WAV file, and reading other formats needs the `scorers` extra") from missing
    info = soundfile.info(str(path))
    return float(info.frames) / float(info.samplerate)


def _load_centroid(path: str | None) -> tuple[list[float] | None, int]:
    if path is None:
        return None, 0
    file = Path(path)
    try:
        raw = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as failure:
        raise GateRefusal(f"--centroid {path} is not readable JSON: {failure}") from failure
    embedding = raw.get("embedding") if isinstance(raw, dict) else None
    takes = raw.get("takes") if isinstance(raw, dict) else None
    if (
        not isinstance(embedding, list)
        or not embedding
        or not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in embedding)
        or not isinstance(takes, int)
        or isinstance(takes, bool)
        or takes < 0
    ):
        raise GateRefusal(f'--centroid {path} must be {{"embedding": [numbers], "takes": <approved takes>}}')
    return [float(v) for v in embedding], takes


def _card(ref: str | None, env: Mapping[str, str], library: str | None = None, vault: str | None = None) -> Card:
    """The card for `--card`: a directory, or a slug in the library (`--library`, else the config's, else `<vault>/casting`)."""
    if ref is None:
        raise GateRefusal("--card <slug|dir> is required: the gates judge a take against a cast card")
    try:
        config = load_config(env)
    except ConfigRefusal as refusal:
        raise GateRefusal(str(refusal)) from refusal
    try:
        root: Path | None = resolve_root(library or config.library, vault)
    except LibraryRefusal:
        root = None
    return load_card(ref, root)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_scorers(take: Take, scorers: Sequence[Scorer]) -> tuple[dict[str, object], list[dict[str, object]]]:
    """Runs the stack in order. A soft scorer whose extra is missing is skipped; a hard one raises `ScorerUnavailable`."""
    scores: dict[str, object] = {}
    ran: list[dict[str, object]] = []
    for scorer in scorers:
        info = scorer.info
        started = time.monotonic()
        try:
            answer = scorer.score(take)
        except ScorerUnavailable:
            if not info.soft:
                raise
            ran.append({"name": info.name, "skipped": f"the `{info.extra}` extra is not installed"})
            continue
        scores.update(answer)
        take.context.update(answer)
        ran.append({"name": info.name, "weights": info.weights, "version": info.version(), "wall": round(time.monotonic() - started, 3)})
    return scores, ran


def cmd_gate(
    rest: Sequence[str],
    *,
    line: str | None,
    card_ref: str | None,
    centroid_path: str | None,
    emotion: str | None,
    scores_path: str | None,
    env: Mapping[str, str],
    work: Path | None,
    scorer_factory: ScorerFactory,
    library: str | None = None,
    vault: str | None = None,
) -> Result:
    if len(rest) > 1:
        return _error(f"gate takes one take, got {len(rest)}: {' '.join(rest)}")
    if scores_path is None and not rest:
        return _error("gate needs a take (`gate <take.wav> --line ...`) or `--scores <record.json>`")
    if scores_path is not None and rest:
        return _error("give either a take or --scores, not both")
    if scores_path is None and not line:
        return _error('gate <take.wav> needs --line "<the script line>"')
    try:
        card = _card(card_ref, env, library, vault)
        centroid, centroid_takes = _load_centroid(centroid_path)
    except GateRefusal as refusal:
        return _refused(str(refusal))

    thresholds = thresholds_for(card)
    target = target_wps(thresholds, card)
    started = time.monotonic()

    if scores_path is not None:
        record_file = Path(scores_path)
        try:
            raw = json.loads(record_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as failure:
            return _refused(f"--scores {scores_path} is not readable JSON: {failure}", missing=[scores_path])
        record = scores_of(raw)
        if record is None:
            return _refused(f"--scores {scores_path} holds no score record")
        scores = dict(record)
        seconds_value = scores.get("seconds")
        seconds = float(seconds_value) if isinstance(seconds_value, (int, float)) and not isinstance(seconds_value, bool) else None
        scores.update(derive(scores, line, seconds, target))
        ran: list[dict[str, object]] = []
        audio: Path | None = None
    else:
        audio = Path(rest[0])
        if not audio.is_file():
            return _refused(f"no take at {audio}", missing=[str(audio)])
        try:
            seconds = audio_seconds(audio)
        except GateRefusal as refusal:
            return _refused(str(refusal))
        except Exception as failure:  # an unreadable audio file
            return _refused(f"{audio} is not readable audio: {failure}")
        take = Take(
            audio=audio,
            line=line or "",
            seconds=seconds,
            card_embedding=card.embedding,
            card_reference=card.reference,
            centroid=centroid,
        )
        try:
            scores, ran = run_scorers(take, scorer_factory())
        except ScorerUnavailable as missing:
            return _refused(
                f"{missing}; pablo installs it on the first `pablo gate`, or run `uv sync --extra {missing.info.extra}` in packages/casting",
                missing=[missing.info.package],
            )
        except Exception as failure:  # a scorer crashed: an error, with the scorer named when we know it
            return _error(f"scoring {audio} failed: {type(failure).__name__}: {failure}")
        scores.update(derive(scores, line, seconds, target))

    verdict = evaluate(scores, thresholds, centroid_takes=centroid_takes, emotion=emotion)
    wall = round(time.monotonic() - started, 3)
    timings = scores.pop("timings", None)
    body: Body = {
        "ok": True,
        "take": str(audio) if audio is not None else None,
        "scoresFrom": scores_path,
        "card": card.slug,
        "line": line,
        "pass": verdict["pass"],
        "failing": verdict["failing"],
        "flags": verdict["flags"],
        "scores": scores,
        "gates": verdict["gates"],
        "thresholds": thresholds,
        "scorers": ran,
        "wall": wall,
    }
    if timings is not None:
        body["timings"] = timings
    if work is not None and audio is not None:
        append_receipt(
            work,
            {
                "intent": "gate",
                "take": str(audio),
                "take_sha256": _sha256(audio),
                "card": card.slug,
                "scorers": ran,
                "wall": wall,
                "audio_seconds": scores.get("seconds"),
                "pass": verdict["pass"],
                "failing": verdict["failing"],
            },
        )
    return body, EXIT_OK


def _write_json_atomically(path: Path, data: object) -> None:
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    handle, temp = tempfile.mkstemp(prefix=".card-", suffix=".json", dir=str(path.parent))
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            out.write(text)
        os.replace(temp, path)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise


def cmd_calibrate(
    *,
    approved_dir: str | None,
    others_dir: str | None,
    card_ref: str | None,
    apply: bool,
    env: Mapping[str, str],
    library: str | None = None,
    vault: str | None = None,
) -> Result:
    if approved_dir is None:
        return _error("gate calibrate needs --approved <dir> (score records of approved takes)")
    if apply and card_ref is None:
        return _refused("--apply writes the proposed gates into a card: name it with --card <slug|dir>")
    try:
        card = _card(card_ref, env, library, vault) if card_ref is not None else None
        approved = read_records(Path(approved_dir))
        others = read_records(Path(others_dir)) if others_dir is not None else []
    except (GateRefusal, CalibrationRefusal) as refusal:
        return _refused(str(refusal))
    if not approved:
        return _refused(f"no score records under {approved_dir} (JSON gate bodies, take.json files or CSV rows)")

    fits = calibrate(approved, others)
    if not fits:
        return _refused(f"the records under {approved_dir} carry none of the calibrated scores")
    proposed = {key: fit.value for key, fit in fits.items()}
    warnings = [f"{key}: {fit.note}" for key, fit in fits.items() if fit.note]
    body: Body = {
        "ok": True,
        "approved": len(approved),
        "others": len(others),
        "proposed": {"gates": proposed},
        "fits": {key: fit.as_body() for key, fit in fits.items()},
        "card": None if card is None else card.slug,
        "current": None if card is None else card.gates,
        "applied": False,
        "warnings": warnings,
    }
    if not apply:
        body["message"] = "proposed gates printed; nothing written (add --apply --card <slug> to write them into the card)"
        return body, EXIT_OK

    assert card is not None
    current = card.data.get("gates")
    merged = {**(current if isinstance(current, dict) else {}), **proposed}
    try:
        validate_gates(merged, str(card.path))
        _write_json_atomically(card.path, {**card.data, "gates": merged})
    except GateRefusal as refusal:
        return _refused(str(refusal))
    except OSError as failure:
        return _error(f"writing {card.path} failed: {failure}")
    body["applied"] = True
    body["wrote"] = [str(card.path)]
    body["message"] = f"wrote the calibrated gates into {card.path}; the card hash changed, so rebind any cast.json that pins it"
    return body, EXIT_OK
