"""The command table behind `python -m pablo_casting <command> [--json] [--work DIR]`.

Every command returns `(body, exit_code)`: `body` is exactly what `--json`
prints, success or not, and the exit code is pablo's contract (0 ok, 2 refused,
1 error). A refusal is `{"ok": false, "code": 2, "message": ...}`; an error is
the same shape with code 1. Nothing here is a user-facing binary: the pablo CLI
runs it and returns its body as its own.

Commands:

- `version`  the package and Python versions.
- `doctor`   the config, the Python side and which configured weights are in the
             Hugging Face cache. Never downloads anything.
- `pull`     download the configured weights into the HF cache (progress on
             stderr), with a receipt when `--work` is given.
- `audition --dry-run`  a no-model command: proves the side is provisioned and
             runnable.
- `audition --role R --describe "..." [--designer qwen3|voxcpm2] [-n 6]
             [--seed S] [--traits JSON] [--slug S]`  render N candidates of the
             shared audition passage into the library's `auditions/` (AGT-1679).
- `cast --role R --candidate N [--recast] [--traits JSON] [--notes T] [--by B]`
             freeze a candidate into the voice's card; prints the card hash.
             There is no `--from-wav`: a card's reference only comes from a
             designer.
- `cast --auto --work W [--episode N | --all]`  auto-casting (AGT-1698,
             `matching.py`): bind every unbound described role to the best
             distinct non-retired library voice, `review` in the middle band;
             the rest come back as `needsDesign`. No model is loaded.
- `voices list [--auto-admitted]`, `voices show <slug>`, `voices retire <slug>
             [--reason T]`  read the library; retire marks a voice unmatchable
             without changing its card hash.
- `takes show <key> --work W`  one take's inputs, scores, timings and receipt id
             (a unique key prefix of 4+ hex characters is enough).
- `takes gc --work W [--yes [--key K ...]]`  lists the takes no manifest
             version references; with `--yes` moves them (or only the named
             `--key`s) into `archive/takes/<stamp>/`. Nothing is deleted.
- `manifest write --work W --episode N --from FILE [--flag ID ...] [--audio F]`
             writes `renders/epNN/v<k+1>.json` through the "only flagged lines
             change" invariant; a violation is exit 1 naming the offending
             line ids, and nothing is written. `pablo fix` (C13) is its caller.
- `script --work W --episode N`  the parsed script: lines, cues, roles with traits, issues.
- `check --work W [--episode N]`  unknown directions (with line numbers) and unbound roles.
- `status --work W --episode N`   ready, or exit 2 with the unbound roles in `missing`.
- `bind --work W --role R --voice SLUG [--vault V | --library DIR]`  pin a role to a library voice.
- `gate`     score a take with the scorer stack and judge it against a card's
             thresholds; `gate calibrate` fits thresholds from approved takes
             (see `gate_command.py`). Writes nothing but a receipt unless
             `gate calibrate --apply`.

The library root is `--library`, else the config's `library`, else
`<vault>/casting` (`--vault`); its voices are under `voices/`.
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
from pablo_casting.binding import BindingRefusal, bind, episode_files, library_dir, read_cast, read_episode
from pablo_casting.config import CastingConfig, ConfigRefusal, load_config
from pablo_casting.gate_command import cmd_calibrate, cmd_gate
from pablo_casting.hfcache import hub_cache, is_cached
from pablo_casting.library import Library, LibraryRefusal, card_hash, check_slug, resolve_root, slugify
from pablo_casting.manifest import ManifestError, referenced_takes, write_version
from pablo_casting.receipts import append_receipt, now
from pablo_casting.scorers import ScorerFactory, describe, real_scorers
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
from pablo_casting.script import Script
from pablo_casting.toolkit import DEFAULT_DESIGNER, DESIGNER_NAMES, Toolkit, ToolkitUnavailable, select_toolkit
from pablo_casting.traits import TraitsError, parse_traits

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_REFUSED = 2

Body = dict[str, object]
Result = tuple[Body, int]
Downloader = Callable[[str], str]
ToolkitFactory = Callable[[Mapping[str, str], CastingConfig], Toolkit]

COMMANDS = ("version", "doctor", "pull", "audition", "cast", "voices", "takes", "manifest", "script", "check", "status", "bind", "gate")
VOICES_SUBCOMMANDS = ("list", "show", "retire")
DEFAULT_CANDIDATES = 6


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
    parser.add_argument("--vault", help="the vault; the library defaults to <vault>/casting")
    parser.add_argument("--library", help="the voice library root (overrides the config and --vault)")
    parser.add_argument("--role")
    parser.add_argument("--voice")
    parser.add_argument("--slug")
    parser.add_argument("--describe")
    parser.add_argument("--designer")
    parser.add_argument("-n", "--n", type=int, dest="n")
    parser.add_argument("--seed", type=int)
    parser.add_argument("--traits")
    parser.add_argument("--candidate", type=int)
    parser.add_argument("--recast", action="store_true")
    parser.add_argument("--auto", action="store_true")
    parser.add_argument("--all", action="store_true", dest="all_episodes")
    parser.add_argument("--notes")
    parser.add_argument("--by")
    parser.add_argument("--reason")
    parser.add_argument("--auto-admitted", action="store_true", dest="auto_admitted")
    # Parsed only to refuse it by name: a card's reference comes from a designer, never a file.
    parser.add_argument("--from-wav", dest="from_wav")
    # gate / gate calibrate
    parser.add_argument("--line")
    parser.add_argument("--card")
    parser.add_argument("--centroid")
    parser.add_argument("--emotion")
    parser.add_argument("--scores")
    parser.add_argument("--approved")
    parser.add_argument("--others")
    parser.add_argument("--apply", action="store_true")
    return parser


def _default_downloader(model_id: str) -> str:
    # Imported here, not at module load: only `pull` needs it, and `doctor`
    # must stay cheap and offline.
    from huggingface_hub import snapshot_download

    return snapshot_download(repo_id=model_id)


def _default_toolkit(env: Mapping[str, str], config: CastingConfig) -> Toolkit:
    return select_toolkit(env, config.engines)


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
        "scorers": _scorers_body(env),
    }, EXIT_OK


def _scorers_body(env: Mapping[str, str]) -> list[dict[str, object]]:
    """The gate's scorer stack: weights, licenses, installed versions, and whether Hub weights are cached."""
    out = describe()
    for scorer in out:
        weights = str(scorer["weights"])
        # Hub ids look like `org/name`; UTMOS (torch.hub) and DNSMOS (an ONNX file) live in their own caches.
        scorer["cached"] = is_cached(weights, env) if weights.count("/") == 1 and " " not in weights else None
    return out


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


def _library(config: CastingConfig, args: argparse.Namespace) -> Library:
    """The library root: `--library`, else the config's `library`, else `<vault>/casting` (the rule `bind` shares)."""
    return Library(Path(args.library) if args.library else resolve_root(config.library, args.vault))


def _slug_for(args: argparse.Namespace) -> str:
    if args.slug:
        return check_slug(args.slug)
    slug = slugify(args.role or "")
    if not slug:
        raise LibraryRefusal(f'--role "{args.role}" has no letters or digits to name a voice; pass --slug')
    return check_slug(slug)


def _author(env: Mapping[str, str], given: str | None) -> str:
    return given or env.get("PABLO_AUTHOR") or env.get("USER") or "author"


def cmd_audition(env: Mapping[str, str], args: argparse.Namespace, work: Path | None, toolkits: ToolkitFactory) -> Result:
    if args.dry_run:
        return {
            "ok": True,
            "dryRun": True,
            "version": __version__,
            "message": "the casting side is provisioned and runnable; no model was loaded",
        }, EXIT_OK
    from pablo_casting.audition import MAX_CANDIDATES, AuditionRequest, audition

    if not args.role or not args.describe or not args.describe.strip():
        missing = [flag for flag, value in (("--role", args.role), ("--describe", (args.describe or "").strip())) if not value]
        return refused(f"audition needs {' and '.join(missing)} (or --dry-run to check the casting side)", missing=missing)
    designer = args.designer or DEFAULT_DESIGNER
    if designer not in DESIGNER_NAMES:
        return refused(f'unknown designer "{designer}": one of {", ".join(DESIGNER_NAMES)}')
    n = DEFAULT_CANDIDATES if args.n is None else args.n
    if not 1 <= n <= MAX_CANDIDATES:
        return refused(f"-n must be between 1 and {MAX_CANDIDATES} (got {n})")
    if args.seed is not None and args.seed < 0:
        return refused(f"--seed must be a non-negative integer (got {args.seed})")
    config = load_config(env)
    library = _library(config, args)
    request = AuditionRequest(
        slug=_slug_for(args),
        role=args.role,
        description=args.describe.strip(),
        designer=designer,
        n=n,
        seed=args.seed if args.seed is not None else int.from_bytes(os.urandom(3), "big"),
        traits=parse_traits(args.traits),
    )
    return audition(library, request, toolkits(env, config), now, work), EXIT_OK


def cmd_cast(env: Mapping[str, str], args: argparse.Namespace, work: Path | None, toolkits: ToolkitFactory) -> Result:
    from pablo_casting.cards import CastRequest, cast

    if args.from_wav is not None:
        return refused(
            "pablo cast has no --from-wav: voices are synthetic only, and a card's reference comes from "
            "a designer (`pablo audition`), never from a recording"
        )
    if not args.role and not args.slug:
        return refused("cast needs --role (or --slug)", missing=["--role"])
    if args.candidate is None:
        return refused("cast needs --candidate <n>, a number `pablo audition` printed", missing=["--candidate"])
    config = load_config(env)
    library = _library(config, args)
    request = CastRequest(
        slug=_slug_for(args),
        candidate=args.candidate,
        recast=args.recast,
        by=_author(env, args.by),
        traits=parse_traits(args.traits) if args.traits is not None else None,
        notes=args.notes,
    )
    return cast(library, request, toolkits(env, config), config.engines, now, work), EXIT_OK


def cmd_auto_cast(env: Mapping[str, str], args: argparse.Namespace, work: Path | None) -> Result:
    from pablo_casting.matching import auto_cast, thresholds_from

    manual = [flag for flag, given in (("--role", args.role is not None), ("--candidate", args.candidate is not None), ("--recast", args.recast), ("--from-wav", args.from_wav is not None)) if given]
    if manual:
        return refused(f"cast --auto matches from the library; it takes no {', '.join(manual)}")
    if work is None:
        return refused("cast --auto needs --work <dir> (the work whose scripts name the roles)", missing=["--work"])
    if args.episode is not None and args.all_episodes:
        return refused("cast --auto takes --episode N or --all, not both")
    try:
        episode = None if args.episode is None else int(args.episode)
    except ValueError:
        return error(f"--episode must be an integer, got {args.episode!r}")
    config = load_config(env)
    thresholds = thresholds_from(config.matching)
    try:
        return auto_cast(work, _library(config, args), episode, thresholds, now), EXIT_OK
    except BindingRefusal as refusal:
        return refused(str(refusal))


def cmd_voices(env: Mapping[str, str], args: argparse.Namespace) -> Result:
    sub = args.rest[0] if args.rest else "list"
    if sub not in VOICES_SUBCOMMANDS:
        return error(f'voices: unknown subcommand "{sub}": one of {", ".join(VOICES_SUBCOMMANDS)}')
    library = _library(load_config(env), args)
    if sub == "list":
        rows = [library.summary(slug) for slug in library.slugs()]
        if args.auto_admitted:
            rows = [row for row in rows if row.get("admitted_by") == "auto"]
        return {"ok": True, "library": str(library.root), "voices": rows}, EXIT_OK
    if len(args.rest) < 2:
        return refused(f"voices {sub} needs a voice slug", missing=["slug"])
    slug = check_slug(args.rest[1])
    if sub == "show":
        return {"ok": True, **library.show(slug)}, EXIT_OK
    card, changed = library.retire(slug, now(), _author(env, args.by), args.reason)
    digest = card_hash(card)
    return {
        "ok": True,
        "slug": slug,
        "retired": card["retired"],
        "changed": changed,
        "hash": digest,
        "message": (
            f"{slug} is retired: never matched again; stories that pin {digest[:12]} still perform"
            if changed
            else f"{slug} was already retired"
        ),
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


def _episode_number(raw: str | None) -> int | None:
    return None if raw is None else int(raw)


def _need_work(work: Path | None, command: str) -> Result | None:
    if work is None:
        return refused(f"{command} needs --work <dir>")
    return None


def cmd_script(work: Path, episode: int | None) -> Result:
    if episode is None:
        return refused("script needs --episode N")
    found = read_episode(work, episode)
    if found is None:
        return refused(f"no script for episode {episode} in {work}", missing=[f"episode {episode}"])
    path, script = found
    return {"ok": True, "file": path.name, "episode": episode, **script.as_body()}, EXIT_OK


def _episode_report(work: Path, number: int, path: Path, script: Script, bound: dict[str, dict[str, object]]) -> dict[str, object]:
    roles = script.role_names()
    return {
        "episode": number,
        "file": str(path.relative_to(work)),
        "lines": len(script.lines),
        "cues": len(script.cues),
        "roles": roles,
        "undeclaredSpeakers": script.undeclared,
        "unboundRoles": [r for r in roles if r not in bound],
        "unknownDirections": [i.as_body() for i in script.issues],
        "offVocabulary": script.off_vocabulary(),
        "multipleDirections": script.multiple_directions(),
        "undescribedRoles": script.undescribed,
    }


def cmd_check(work: Path, episode: int | None) -> Result:
    try:
        bound = read_cast(work)
    except BindingRefusal as refusal:
        return refused(str(refusal))
    reports: list[dict[str, object]] = []
    for number, path in episode_files(work):
        if episode is not None and number != episode:
            continue
        found = read_episode(work, number)
        assert found is not None
        reports.append(_episode_report(work, number, found[0], found[1], bound))
    if episode is not None and not reports:
        return refused(f"no script for episode {episode} in {work}", missing=[f"episode {episode}"])
    return {
        "ok": True,
        "episodes": reports,
        "unknownDirections": [
            {"file": r["file"], **issue} for r in reports for issue in r["unknownDirections"]  # type: ignore[union-attr]
        ],
        "unboundRoles": [{"file": r["file"], "episode": r["episode"], "role": role} for r in reports for role in r["unboundRoles"]],  # type: ignore[union-attr]
        "offVocabulary": [{"file": r["file"], **item} for r in reports for item in r["offVocabulary"]],  # type: ignore[union-attr]
        "multipleDirections": [{"file": r["file"], **item} for r in reports for item in r["multipleDirections"]],  # type: ignore[union-attr]
        "undescribedRoles": [{"file": r["file"], "episode": r["episode"], "role": role} for r in reports for role in r["undescribedRoles"]],  # type: ignore[union-attr]
    }, EXIT_OK


def cmd_status(work: Path, episode: int | None) -> Result:
    if episode is None:
        return refused("status needs --episode N")
    try:
        bound = read_cast(work)
    except BindingRefusal as refusal:
        return refused(str(refusal))
    found = read_episode(work, episode)
    if found is None:
        return {"ready": False, "missing": [f"episode {episode} has no script"]}, EXIT_REFUSED
    roles = found[1].role_names()
    missing = [f"role {role} is not bound to a voice (pablo bind --role {role} --voice <slug>)" for role in roles if role not in bound]
    return {"ready": not missing, "missing": missing, "episode": episode, "roles": roles}, EXIT_REFUSED if missing else EXIT_OK


def cmd_bind(env: Mapping[str, str], work: Path, args: argparse.Namespace) -> Result:
    if not args.role or not args.voice:
        return refused("bind needs --role R and --voice SLUG")
    try:
        configured = load_config(env).library
    except ConfigRefusal as refusal:
        return refused(str(refusal))
    library = library_dir(Path(args.vault) if args.vault else None, configured, Path(args.library) if args.library else None)
    if library is None:
        return refused("no voice library: pass --vault or --library, or set `library` in the casting config")
    try:
        return bind(work, library, args.role, args.voice), EXIT_OK
    except BindingRefusal as refusal:
        return refused(str(refusal))


def run(
    argv: Sequence[str],
    env: Mapping[str, str] | None = None,
    downloader: Downloader | None = None,
    scorers: ScorerFactory | None = None,
    toolkits: ToolkitFactory | None = None,
) -> tuple[Result, bool]:
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
    if args.rest and args.command not in ("takes", "manifest", "gate", "voices"):
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
    if args.command == "gate":
        if args.rest[:1] == ["calibrate"]:
            if len(args.rest) > 1:
                return error(f"gate calibrate takes no positional arguments, got: {' '.join(args.rest[1:])}"), args.json
            return cmd_calibrate(approved_dir=args.approved, others_dir=args.others, card_ref=args.card, apply=args.apply, env=env), args.json
        return cmd_gate(
            args.rest,
            line=args.line,
            card_ref=args.card,
            centroid_path=args.centroid,
            emotion=args.emotion,
            scores_path=args.scores,
            env=env,
            work=work,
            scorer_factory=scorers or real_scorers,
        ), args.json
    toolkit_factory = toolkits or _default_toolkit
    try:
        if args.command == "audition":
            return cmd_audition(env, args, work, toolkit_factory), args.json
        if args.command == "cast" and args.auto:
            return cmd_auto_cast(env, args, work), args.json
        if args.command == "cast":
            return cmd_cast(env, args, work, toolkit_factory), args.json
        if args.command == "voices":
            return cmd_voices(env, args), args.json
    except LibraryRefusal as refusal:
        return refused(str(refusal), **({"missing": refusal.missing} if refusal.missing else {})), args.json
    except (ConfigRefusal, TraitsError, ToolkitUnavailable) as refusal:
        return refused(str(refusal)), args.json
    missing_work = _need_work(work, args.command)
    if missing_work is not None:
        return missing_work, args.json
    assert work is not None
    if args.command == "bind":
        return cmd_bind(env, work, args), args.json
    try:
        episode = _episode_number(args.episode)
    except ValueError:
        return error(f"--episode must be an integer, got {args.episode!r}"), args.json
    if args.command == "script":
        return cmd_script(work, episode), args.json
    if args.command == "check":
        return cmd_check(work, episode), args.json
    return cmd_status(work, episode), args.json


def main(
    argv: Sequence[str],
    env: Mapping[str, str] | None = None,
    downloader: Downloader | None = None,
    scorers: ScorerFactory | None = None,
    toolkits: ToolkitFactory | None = None,
) -> int:
    (body, code), wants_json = run(argv, env, downloader, scorers, toolkits)
    if wants_json:
        print(json.dumps(body))
    elif body.get("ok"):
        print(body.get("message") or json.dumps(body, indent=2))
    else:
        print(f"pablo casting: {body['message']}", file=sys.stderr)
    return code
