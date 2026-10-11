"""The command table behind `python -m pablo_casting <command> [--json] [--work DIR]`.

Every command returns `(body, exit_code)`: `body` is exactly what `--json`
prints, success or not, and the exit code is pablo's contract (0 ok, 2 refused,
1 error). A refusal is `{"ok": false, "code": 2, "message": ...}`; an error is
the same shape with code 1. Nothing here is a user-facing binary: the pablo CLI
runs it and returns its body as its own.

Commands today:

- `version`  the package and Python versions.
- `doctor`   the config, the Python side and which configured weights are in the
             Hugging Face cache. Never downloads anything.
- `pull`     download the configured weights into the HF cache (progress on
             stderr), with a receipt when `--work` is given.
- `audition --dry-run`  a no-model command: proves the side is provisioned and
             runnable. A real audition lands with the cast-card ticket.
- `takes show <key> --work W`  one take's inputs, scores, timings and receipt id
             (a unique key prefix of 4+ hex characters is enough).
- `takes gc --work W [--yes [--key K ...]]`  lists the takes no manifest
             version references; with `--yes` moves them (or only the named
             `--key`s) into `archive/takes/<stamp>/`. Nothing is deleted.
- `manifest write --work W --episode N --from FILE [--flag ID ...] [--audio F]`
             writes `renders/epNN/v<k+1>.json` through the "only flagged lines
             change" invariant; a violation is exit 1 naming the offending
             line ids, and nothing is written. `pablo fix` (C13) is its caller.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

from pablo_casting import __version__
from pablo_casting.config import ConfigRefusal, load_config
from pablo_casting.hfcache import hub_cache, is_cached
from pablo_casting.manifest import ManifestError, referenced_takes, write_version
from pablo_casting.receipts import append_receipt
from pablo_casting.takes import (
    KEY_RE,
    AmbiguousKey,
    TakeInputError,
    archive_takes,
    list_take_keys,
    read_take,
    resolve_key,
    take_bytes,
    take_path,
    takes_dir,
)

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_REFUSED = 2

Body = dict[str, object]
Result = tuple[Body, int]
Downloader = Callable[[str], str]

COMMANDS = ("version", "doctor", "pull", "audition", "takes", "manifest")


def refused(message: str, **extra: object) -> Result:
    return {"ok": False, "code": EXIT_REFUSED, "message": message, **extra}, EXIT_REFUSED


def error(message: str) -> Result:
    return {"ok": False, "code": EXIT_ERROR, "message": message}, EXIT_ERROR


class _UsageError(Exception):
    pass


class _Parser(argparse.ArgumentParser):
    """argparse exits 2 on a usage error, which would read as a refusal; raise instead (an error, exit 1)."""

    def error(self, message: str) -> None:  # type: ignore[override]
        raise _UsageError(message)


def _parser() -> _Parser:
    parser = _Parser(prog="python -m pablo_casting", add_help=False)
    parser.add_argument("command", nargs="?")
    parser.add_argument("rest", nargs="*")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--yes", action="store_true")
    parser.add_argument("--key", action="append", default=[])
    parser.add_argument("--episode")
    parser.add_argument("--from", dest="from_file")
    parser.add_argument("--flag", action="append", default=[])
    parser.add_argument("--audio")
    parser.add_argument("--work", help="the work directory receipts go under (<work>/.pablo/casting/)")
    parser.add_argument("--dry-run", action="store_true", dest="dry_run")
    return parser


def _default_downloader(model_id: str) -> str:
    # Imported here, not at module load: only `pull` needs it, and `doctor`
    # must stay cheap and offline.
    from huggingface_hub import snapshot_download

    return snapshot_download(repo_id=model_id)


def cmd_version(env: Mapping[str, str]) -> Result:
    return {"ok": True, "version": __version__, "python": platform.python_version()}, EXIT_OK


def cmd_doctor(env: Mapping[str, str]) -> Result:
    try:
        config = load_config(env)
    except ConfigRefusal as refusal:
        return refused(str(refusal))
    return {
        "ok": True,
        "version": __version__,
        "python": platform.python_version(),
        "executable": sys.executable,
        "config": config.as_body(),
        "hfCache": str(hub_cache(env)),
        "weights": [{"id": model_id, "cached": is_cached(model_id, env)} for model_id in config.weights],
    }, EXIT_OK


def cmd_pull(env: Mapping[str, str], work: Path | None, downloader: Downloader) -> Result:
    try:
        config = load_config(env)
    except ConfigRefusal as refusal:
        return refused(str(refusal))
    pulled: list[dict[str, object]] = []
    for model_id in config.weights:
        if is_cached(model_id, env):
            pulled.append({"id": model_id, "cached": True})
            continue
        print(f"pablo casting: pulling {model_id} into {hub_cache(env)}", file=sys.stderr, flush=True)
        started = time.monotonic()
        try:
            path = downloader(model_id)
        except Exception as failure:  # a network or hub failure is an error, not a refusal
            return error(f"pulling {model_id} failed: {failure}")
        wall = round(time.monotonic() - started, 3)
        pulled.append({"id": model_id, "cached": False, "path": path, "wall": wall})
        if work is not None:
            append_receipt(work, {"intent": "pull", "weights": model_id, "path": path, "wall": wall})
    return {"ok": True, "weights": pulled}, EXIT_OK


def cmd_audition(env: Mapping[str, str], dry_run: bool) -> Result:
    if not dry_run:
        return error("audition is not implemented yet; `audition --dry-run` checks the casting side without a model")
    return {
        "ok": True,
        "dryRun": True,
        "version": __version__,
        "message": "the casting side is provisioned and runnable; no model was loaded",
    }, EXIT_OK


def cmd_takes_show(work: Path, key: str | None) -> Result:
    if not key:
        return error("usage: takes show <key> --work DIR")
    try:
        full = resolve_key(work, key)
    except TakeInputError as bad:
        return error(str(bad))
    except AmbiguousKey as ambiguous:
        return refused(f"take key prefix {key} is ambiguous; give more of it", matches=ambiguous.matches)
    take = read_take(work, full) if full else None
    if take is None:
        return refused(f"no take {key} under {takes_dir(work)}", missing=[key])
    record = take.record
    return {
        "ok": True,
        "key": take.key,
        "path": str(take.path),
        "inputs": record.get("inputs"),
        "seed": record.get("seed"),
        "attempt": record.get("attempt"),
        "status": record.get("status"),
        "scores": record.get("scores"),
        "timings": record.get("timings"),
        "audio": record.get("audio"),
        "receipt": record.get("receipt"),
        "created": record.get("created"),
    }, EXIT_OK


def cmd_takes_gc(work: Path, yes: bool, only: Sequence[str]) -> Result:
    try:
        referenced = referenced_takes(work)
    except (OSError, ValueError) as unreadable:
        # Without every manifest we cannot know what is referenced: touch nothing.
        return error(f"a manifest could not be read, so nothing was collected: {unreadable}")
    unreferenced = [key for key in list_take_keys(work) if key not in referenced]
    listed: list[dict[str, object]] = []
    for key in unreferenced:
        take = read_take(work, key)
        listed.append({"key": key, "bytes": take_bytes(take_path(work, key)), "created": take.record.get("created") if take else None})
    body: Body = {"ok": True, "referenced": len(referenced), "unreferenced": listed, "archived": []}
    if not yes:
        return body, EXIT_OK
    bad = [key for key in only if not KEY_RE.match(key)]
    if bad:
        return error(f"--key must be a full take key: {', '.join(bad)}")
    chosen = [key for key in unreferenced if not only or key in only]
    skipped = [key for key in only if key not in unreferenced]
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    archived = archive_takes(work, chosen, stamp)
    if archived:
        append_receipt(work, {"intent": "takes-gc", "archived": [entry["key"] for entry in archived], "stamp": stamp})
    return {**body, "archived": archived, "skipped": skipped}, EXIT_OK


def cmd_manifest_write(work: Path, episode: str | None, from_file: str | None, flags: Sequence[str], audio: str | None) -> Result:
    if episode is None or from_file is None:
        return error("usage: manifest write --work DIR --episode N --from FILE [--flag ID ...] [--audio FILE]")
    try:
        number = int(episode)
    except ValueError:
        return error(f"--episode must be an integer, got {episode!r}")
    try:
        proposal = json.loads(Path(from_file).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as unreadable:
        return error(f"--from {from_file}: {unreadable}")
    if not isinstance(proposal, dict):
        return error(f"--from {from_file} must hold a JSON object")
    try:
        written = write_version(work, number, proposal, flags_applied=list(flags), audio=Path(audio) if audio else None)
    except ManifestError as refusal:
        return {"ok": False, "code": EXIT_ERROR, "message": str(refusal), **refusal.extra}, EXIT_ERROR
    return {
        "ok": True,
        "path": str(written.path),
        "version": written.manifest["version"],
        "parent": written.manifest["parent"],
        "changed_lines": written.manifest["changed_lines"],
        "audio": str(written.audio) if written.audio else None,
        "link": str(written.link) if written.link else None,
    }, EXIT_OK


def run(argv: Sequence[str], env: Mapping[str, str] | None = None, downloader: Downloader | None = None) -> tuple[Result, bool]:
    """Parse and run one command. Returns `(result, json)`; never raises for a bad argv."""
    env = os.environ if env is None else env
    wants_json = "--json" in argv
    try:
        args = _parser().parse_intermixed_args(list(argv))
    except _UsageError as usage:
        return error(f"usage: {usage}"), wants_json

    if args.command is None:
        return error(f"a command is required: one of {', '.join(COMMANDS)}"), args.json
    if args.command not in COMMANDS:
        return error(f'unknown command "{args.command}": one of {", ".join(COMMANDS)}'), args.json
    if args.rest and args.command not in ("takes", "manifest"):
        return error(f"usage: unexpected argument(s) for {args.command}: {' '.join(args.rest)}"), args.json

    work: Path | None = None
    if args.work is not None:
        work = Path(args.work)
        if not work.is_dir():
            return refused(f"--work {args.work} is not a directory", missing=[str(work)]), args.json

    if args.command == "version":
        return cmd_version(env), args.json
    if args.command == "doctor":
        return cmd_doctor(env), args.json
    if args.command == "pull":
        return cmd_pull(env, work, downloader or _default_downloader), args.json
    if args.command in ("takes", "manifest"):
        sub = args.rest[0] if args.rest else None
        if work is None:
            return error(f"{args.command} needs --work DIR (the work whose outputs/radio/casting/ holds the takes)"), args.json
        if args.command == "takes" and sub == "show":
            return cmd_takes_show(work, args.rest[1] if len(args.rest) > 1 else None), args.json
        if args.command == "takes" and sub == "gc":
            return cmd_takes_gc(work, args.yes, args.key), args.json
        if args.command == "manifest" and sub == "write":
            return cmd_manifest_write(work, args.episode, args.from_file, args.flag, args.audio), args.json
        subs = "show, gc" if args.command == "takes" else "write"
        return error(f'unknown {args.command} subcommand "{sub}": one of {subs}'), args.json
    return cmd_audition(env, args.dry_run), args.json


def main(argv: Sequence[str], env: Mapping[str, str] | None = None, downloader: Downloader | None = None) -> int:
    (body, code), wants_json = run(argv, env, downloader)
    if wants_json:
        print(json.dumps(body))
    elif body.get("ok"):
        print(body.get("message") or json.dumps(body, indent=2))
    else:
        print(f"pablo casting: {body['message']}", file=sys.stderr)
    return code
