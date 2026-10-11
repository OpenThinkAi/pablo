"""The shared voice library: where cards live, the card hash, and the
read/retire side of `voices`.

Layout (design: "The cast card and the voice library"), under the library
root (the config's `library`, else `<vault>/casting`):

    voices/<slug>/card.json            tracked
    voices/<slug>/reference.flac       tracked; 24 kHz mono, 20-30 s
    voices/<slug>/reference.txt        tracked; its transcript
    voices/<slug>/embedding.ecapa.npy  tracked; from the reference
    voices/<slug>/auditions/           untracked; every candidate, kept
    voices/<slug>/recast/<timestamp>/  untracked; a recast's previous card
    .gitignore                         written on first use

The **card hash** is sha256 over the card's canonical JSON (sorted keys, no
whitespace), and the card holds `reference.sha256`, so a changed reference is
a changed card. Curation status is not identity: `retired` is left out of the
hash, so retiring a voice never breaks a story that pins it.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from pablo_casting.audio import file_sha256

CARD_FILES = ("card.json", "reference.flac", "reference.txt", "embedding.ecapa.npy")
"""The files a card is: the only ones git tracks in a voice directory."""

HASH_EXCLUDED = ("retired",)
"""Card fields that are curation, not identity, and stay out of the card hash."""

GITIGNORE_LINES = ("auditions/", "takes/", "recast/", "archive/", "renders/*.m4a", ".cast-staging/")
GITIGNORE_HEADER = "# pablo casting: candidates, takes and archives stay on disk, untracked (AGT-1679)"

_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class LibraryRefusal(Exception):
    """A library precondition is unmet; a refusal (exit 2)."""

    def __init__(self, message: str, missing: list[str] | None = None) -> None:
        super().__init__(message)
        self.missing = missing or []


def slugify(role: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", role.lower()).strip("-")


def check_slug(slug: str) -> str:
    if not _SLUG.match(slug):
        raise LibraryRefusal(f'"{slug}" is not a voice slug (lowercase letters, digits and dashes)')
    return slug


def card_hash(card: Mapping[str, object]) -> str:
    identity = {key: value for key, value in card.items() if key not in HASH_EXCLUDED}
    canonical = json.dumps(identity, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def resolve_root(library: str | None, vault: str | None) -> Path:
    """The library root: the config's `library`, else `<vault>/casting`."""
    if library:
        return Path(library).expanduser()
    if vault:
        return Path(vault) / "casting"
    raise LibraryRefusal(
        "no voice library: set `library` in the casting config or run inside a vault (PABLO_VAULT)",
        missing=["library"],
    )


@dataclass(frozen=True)
class Library:
    root: Path

    @property
    def voices(self) -> Path:
        return self.root / "voices"

    def voice_dir(self, slug: str) -> Path:
        return self.voices / check_slug(slug)

    def auditions(self, slug: str) -> Path:
        return self.voice_dir(slug) / "auditions"

    def card_path(self, slug: str) -> Path:
        return self.voice_dir(slug) / "card.json"

    def ensure_gitignore(self) -> Path:
        """Writes the library `.gitignore` on first use; adds any missing line to an existing one."""
        path = self.root / ".gitignore"
        self.root.mkdir(parents=True, exist_ok=True)
        existing = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
        missing = [line for line in GITIGNORE_LINES if line not in existing]
        if missing:
            lines = existing or [GITIGNORE_HEADER]
            path.write_text("\n".join([*lines, *missing]) + "\n", encoding="utf-8")
        return path

    def read_card(self, slug: str) -> dict[str, object]:
        path = self.card_path(slug)
        if not path.exists():
            raise LibraryRefusal(f'no voice "{slug}" in the library at {self.root}', missing=[str(path)])
        try:
            card = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise LibraryRefusal(f"{path} is not valid JSON: {error}") from error
        if not isinstance(card, dict):
            raise LibraryRefusal(f"{path} must hold a JSON object")
        return card

    def write_card(self, slug: str, card: Mapping[str, object]) -> None:
        self.card_path(slug).write_text(json.dumps(card, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    def slugs(self) -> list[str]:
        if not self.voices.is_dir():
            return []
        return sorted(entry.name for entry in self.voices.iterdir() if entry.is_dir() and _SLUG.match(entry.name))

    def audition_numbers(self, slug: str) -> list[int]:
        folder = self.auditions(slug)
        if not folder.is_dir():
            return []
        return sorted(int(p.stem) for p in folder.glob("*.json") if p.stem.isdigit())

    def summary(self, slug: str) -> dict[str, object]:
        """One `voices list` row: the card's identity and status, or an uncast voice's auditions."""
        auditions = len(self.audition_numbers(slug))
        if not self.card_path(slug).exists():
            return {"slug": slug, "cast": False, "auditions": auditions}
        card = self.read_card(slug)
        admitted = card.get("admitted") if isinstance(card.get("admitted"), dict) else {}
        return {
            "slug": slug,
            "cast": True,
            "hash": card_hash(card),
            "description": card.get("description"),
            "traits": card.get("traits", {}),
            "admitted_by": admitted.get("by") if isinstance(admitted, dict) else None,
            "retired": "retired" in card,
            "auditions": auditions,
        }

    def show(self, slug: str) -> dict[str, object]:
        card = self.read_card(slug)
        reference = card.get("reference") if isinstance(card.get("reference"), dict) else {}
        file = self.voice_dir(slug) / str(reference.get("file", "reference.flac")) if isinstance(reference, dict) else None
        intact = bool(file and file.exists() and isinstance(reference, dict) and file_sha256(file) == reference.get("sha256"))
        return {
            "slug": slug,
            "hash": card_hash(card),
            "card": card,
            "retired": "retired" in card,
            "reference_intact": intact,
            "auditions": self.audition_numbers(slug),
            "path": str(self.voice_dir(slug)),
        }

    def retire(self, slug: str, at: str, by: str, reason: str | None) -> tuple[dict[str, object], bool]:
        """Marks a voice unmatchable. The card hash is unchanged, so stories that pin it keep performing.
        Returns the card and whether this call changed it (retiring twice is a no-op)."""
        card = self.read_card(slug)
        if "retired" in card:
            return card, False
        card["retired"] = {"at": at, "by": by, **({"reason": reason} if reason else {})}
        self.write_card(slug, card)
        return card, True
