"""Where a work's scripts and casting state live, and `cast.json`, the role -> voice binding.

`cast.json` pins each role to a voice in the shared library: the slug, the
card's hash (so `perform` can refuse when the library card has since changed:
identity never changes under a story silently) and how it was cast (`by`:
`manual` for `pablo bind`, `match` or `design` for auto-casting).

Layout (decision 2 of the pablo-casting design): a work with a radio output
keeps scripts in `outputs/radio/episodes/` and casting state in
`outputs/radio/casting/`. A work that has no output directory yet (the
sandbox drama, whose episode scripts are `chapters/NN-*.md`) reads scripts
from `chapters/` and keeps `casting/cast.json` at the work's top level.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from pablo_casting.library import Library, LibraryRefusal, card_hash, resolve_root
from pablo_casting.script import Script, has_cast_line, parse_script

SLUG = re.compile(r"^[a-z0-9][a-z0-9-]*$")
EPISODE_FILE = re.compile(r"^(\d+)-.*\.md$")
CAST_VERSION = 1


def script_dir(work: Path) -> Path:
    episodes = work / "outputs" / "radio" / "episodes"
    return episodes if episodes.is_dir() else work / "chapters"


def casting_dir(work: Path) -> Path:
    radio = work / "outputs" / "radio"
    return radio / "casting" if radio.is_dir() else work / "casting"


def cast_path(work: Path) -> Path:
    return casting_dir(work) / "cast.json"


def episode_files(work: Path) -> list[tuple[int, Path]]:
    """Every `NN-*.md` in the script directory that carries a `CAST:` line, by episode number."""
    directory = script_dir(work)
    if not directory.is_dir():
        return []
    found: list[tuple[int, Path]] = []
    for path in sorted(directory.iterdir()):
        match = EPISODE_FILE.match(path.name)
        if match and path.is_file() and has_cast_line(path.read_text(encoding="utf-8")):
            found.append((int(match.group(1)), path))
    return sorted(found, key=lambda pair: pair[0])


def read_episode(work: Path, number: int) -> tuple[Path, Script] | None:
    for n, path in episode_files(work):
        if n == number:
            return path, parse_script(path.read_text(encoding="utf-8"))
    return None


def library_dir(vault: Path | None, configured: str | None, explicit: Path | None) -> Path | None:
    """The library's `voices/` directory, by `library.py`'s one rule: the library root is
    `--library`, else the config's `library`, else `<vault>/casting`. `None` when none is known."""
    try:
        return Library(explicit if explicit is not None else resolve_root(configured, str(vault) if vault is not None else None)).voices
    except LibraryRefusal:
        return None


class BindingRefusal(Exception):
    """A binding that cannot be made; a refusal (exit 2) naming why."""


@dataclass(frozen=True)
class Card:
    slug: str
    hash: str
    retired: bool


def load_card(library: Path, slug: str) -> Card:
    if not SLUG.match(slug):
        raise BindingRefusal(f'"{slug}" is not a voice slug (lowercase letters, digits and dashes)')
    path = library / slug / "card.json"
    if not path.is_file():
        raise BindingRefusal(f'no voice "{slug}" in the library ({library}); `pablo voices list` shows what is there')
    try:
        card = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BindingRefusal(f"{path} is not a readable card: {error}") from error
    if not isinstance(card, dict):
        raise BindingRefusal(f"{path} must hold a JSON object")
    return Card(slug=slug, hash=card_hash(card), retired=bool(card.get("retired")))


def read_cast(work: Path) -> dict[str, dict[str, object]]:
    """The bound roles; an absent or empty `cast.json` binds nothing. An unreadable one is a refusal."""
    path = cast_path(work)
    if not path.is_file():
        return {}
    try:
        body = json.loads(path.read_text(encoding="utf-8"))
        roles = body["roles"]
        if not isinstance(roles, dict) or not all(isinstance(v, dict) for v in roles.values()):
            raise TypeError("`roles` must map role names to objects")
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as error:
        raise BindingRefusal(f"{path} is not a valid cast.json: {error}") from error
    return {str(name): dict(value) for name, value in roles.items()}


def write_cast(work: Path, roles: dict[str, dict[str, object]]) -> Path:
    path = cast_path(work)
    path.parent.mkdir(parents=True, exist_ok=True)
    body = {"version": CAST_VERSION, "roles": dict(sorted(roles.items()))}
    path.write_text(json.dumps(body, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def declared_roles(work: Path) -> list[str]:
    """Every role any of the work's scripts needs a voice for."""
    names: list[str] = []
    for _, path in episode_files(work):
        for name in parse_script(path.read_text(encoding="utf-8")).role_names():
            if name not in names:
                names.append(name)
    return names


def bind(work: Path, library: Path, role: str, slug: str, *, by: str = "manual") -> dict[str, object]:
    """Bind `role` to library voice `slug`, pinning its card hash. Refuses a slug that is absent or retired."""
    name = role.strip().upper()
    if not name:
        raise BindingRefusal("--role is required")
    card = load_card(library, slug)
    if card.retired:
        raise BindingRefusal(f'voice "{slug}" is retired and is never bound to a new role; pick another or recast it')
    known = declared_roles(work)
    if known and name not in known:
        raise BindingRefusal(f"no script in this work has a role {name} (roles: {', '.join(known)})")
    roles = read_cast(work)
    previous = roles.get(name)
    roles[name] = {
        "slug": card.slug,
        "card_hash": card.hash,
        "by": by,
        "at": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
    }
    path = write_cast(work, roles)
    body: dict[str, object] = {"ok": True, "role": name, "slug": card.slug, "cardHash": card.hash, "by": by, "castFile": str(path)}
    if previous is not None:
        body["replaced"] = previous.get("slug")
    return body
