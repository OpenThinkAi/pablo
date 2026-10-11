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
from pablo_casting.receipts import append_receipt

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_REFUSED = 2

Body = dict[str, object]
Result = tuple[Body, int]
Downloader = Callable[[str], str]

COMMANDS = ("version", "doctor", "pull", "audition")


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
    parser.add_argument("--json", action="store_true")
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


def run(argv: Sequence[str], env: Mapping[str, str] | None = None, downloader: Downloader | None = None) -> tuple[Result, bool]:
    """Parse and run one command. Returns `(result, json)`; never raises for a bad argv."""
    env = os.environ if env is None else env
    wants_json = "--json" in argv
    try:
        args = _parser().parse_args(list(argv))
    except _UsageError as usage:
        return error(f"usage: {usage}"), wants_json

    if args.command is None:
        return error(f"a command is required: one of {', '.join(COMMANDS)}"), args.json
    if args.command not in COMMANDS:
        return error(f'unknown command "{args.command}": one of {", ".join(COMMANDS)}'), args.json

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
