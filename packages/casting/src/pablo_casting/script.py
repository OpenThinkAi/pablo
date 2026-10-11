"""The script reader: a radio script into line, cue and role records.

A script is a markdown file with optional pablo frontmatter and, one item per
line:

    CAST: CORA=f "thirties, dry, exact", EDWIN=m   first line: every speaking role
    [SFX: ice rattling in a glass]                 a cue: SFX, BED or MUSIC
    CORA: (dryly) Words (laughs) more words.       a speaker line, with a direction
    A speech that runs on goes on the next lines.  a continuation of the line above

The line and cue records match the prototype's `produce.py` `parse` item for
item (a test holds them to it); what this adds is the direction grammar
(`directions.py`), the described `CAST:` line (`traits.py`) and line numbers,
so `pablo check` can point at a line.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from pablo_casting.directions import Direction, is_nonverbal, parse_direction
from pablo_casting.traits import normalise

LINE = re.compile(r"^([A-Z][A-Z .'\-]{0,30}):\s*(.+)$")
CUE = re.compile(r"^\[(SFX|BED|MUSIC):\s*(.+?)\]\s*$", re.I)
_PAREN = re.compile(r"\(([^)]*)\)")
_SPACE = re.compile(r"\s+")
_QUOTES = '"“”'


@dataclass(frozen=True)
class Role:
    name: str
    gender: str
    description: str | None
    traits: dict[str, object]
    free_text: tuple[str, ...]
    declared: bool = True

    def as_body(self) -> dict[str, object]:
        return {
            "name": self.name,
            "gender": self.gender,
            "description": self.description,
            "traits": self.traits,
            "freeText": list(self.free_text),
            "declared": self.declared,
        }


@dataclass(frozen=True)
class Cue:
    line: int
    kind: str  # SFX | BED | MUSIC
    text: str

    def as_body(self) -> dict[str, object]:
        return {"type": "cue", "line": self.line, "kind": self.kind, "text": self.text}


@dataclass(frozen=True)
class SpokenLine:
    line: int  # file line number of the speaker line
    speaker: str
    text: str  # the words: non-verbals kept, directions removed
    direction: Direction | None
    nonverbals: tuple[str, ...]
    continued: tuple[int, ...] = ()  # file line numbers of its continuation lines

    def as_body(self) -> dict[str, object]:
        return {
            "type": "line",
            "line": self.line,
            "speaker": self.speaker,
            "text": self.text,
            "direction": None if self.direction is None else self.direction.as_body(),
            "nonverbals": list(self.nonverbals),
            "continued": list(self.continued),
        }


@dataclass(frozen=True)
class Issue:
    """A direction the grammar did not accept, with the line it is on."""

    line: int
    text: str  # the parenthetical as written, brackets included
    speaker: str
    kind: str  # `direction` (the leading parenthetical) | `inline` (a stray one inside the words)
    unknown: tuple[str, ...]

    def as_body(self) -> dict[str, object]:
        return {"line": self.line, "speaker": self.speaker, "text": self.text, "kind": self.kind, "unknown": list(self.unknown)}


@dataclass
class Script:
    meta: dict[str, str] = field(default_factory=dict)
    roles: dict[str, Role] = field(default_factory=dict)
    items: list[Cue | SpokenLine] = field(default_factory=list)
    issues: list[Issue] = field(default_factory=list)
    has_cast: bool = False

    @property
    def lines(self) -> list[SpokenLine]:
        return [i for i in self.items if isinstance(i, SpokenLine)]

    @property
    def cues(self) -> list[Cue]:
        return [i for i in self.items if isinstance(i, Cue)]

    @property
    def undeclared(self) -> list[str]:
        """Speakers that speak but are not on the `CAST:` line, in order of first appearance."""
        seen: list[str] = []
        for spoken in self.lines:
            if spoken.speaker not in self.roles and spoken.speaker not in seen:
                seen.append(spoken.speaker)
        return seen

    def role_names(self) -> list[str]:
        """Every role that needs a voice: the `CAST:` roles, then any undeclared speaker."""
        return [*self.roles, *self.undeclared]

    def as_body(self) -> dict[str, object]:
        return {
            "meta": self.meta,
            "roles": [r.as_body() for r in self.roles.values()],
            "undeclared": self.undeclared,
            "lines": len(self.lines),
            "cues": len(self.cues),
            "items": [i.as_body() for i in self.items],
            "issues": [i.as_body() for i in self.issues],
        }


def has_cast_line(text: str) -> bool:
    return any(raw.strip().replace("*", "").upper().startswith("CAST:") for raw in text.splitlines())


def split_frontmatter(text: str) -> tuple[dict[str, str], int]:
    """The frontmatter fields and how many file lines it takes (0 when there is none)."""
    lines = text.split("\n")
    if (lines[0] if lines else "").strip() != "---":
        return {}, 0
    meta: dict[str, str] = {}
    for index in range(1, len(lines)):
        if lines[index].strip() == "---":
            return meta, index + 1
        match = re.match(r"^([A-Za-z0-9_]+):\s*(.*)$", lines[index])
        if match:
            meta[match.group(1)] = match.group(2).strip()
    return {}, 0  # an unclosed fence is not frontmatter


def _split_unquoted(text: str, sep: str) -> list[str]:
    parts: list[str] = []
    current: list[str] = []
    quoted = False
    for char in text:
        if char in _QUOTES:
            quoted = not quoted
        if char == sep and not quoted:
            parts.append("".join(current))
            current = []
        else:
            current.append(char)
    parts.append("".join(current))
    return parts


def parse_cast(raw: str) -> list[tuple[str, str, str | None]]:
    """`CORA=f "thirties, dry", EDWIN=m` -> [(CORA, f, "thirties, dry"), (EDWIN, m, None)]."""
    cast: list[tuple[str, str, str | None]] = []
    for part in _split_unquoted(raw, ","):
        if "=" not in part:
            continue
        name, rest = part.split("=", 1)
        rest = rest.strip()
        quote = re.search(f"[{_QUOTES}]", rest)
        if quote is None:
            gender, description = rest, None
        else:
            gender = rest[: quote.start()]
            description = rest[quote.start() :].strip().strip(_QUOTES).strip() or None
        cast.append((name.strip().upper(), gender.strip().lower()[:1], description))
    return cast


def _words(raw: str, line_no: int, speaker: str, issues: list[Issue], *, lead: bool) -> tuple[str, Direction | None, tuple[str, ...]]:
    """Clean one run of speech: strip parentheticals that are not non-verbals, keep non-verbals.

    With `lead`, the first leading non-non-verbal parenthetical is the direction;
    every other one is a stray, reported. Returns (words, direction, non-verbals).
    """
    direction: Direction | None = None
    nonverbals: list[str] = []
    pieces: list[str] = []
    cursor = 0
    leading = lead
    for match in _PAREN.finditer(raw):
        pieces.append(raw[cursor : match.start()])
        cursor = match.end()
        before = raw[: match.start()]  # earlier leading parentheticals do not count as words
        inner = match.group(1)
        at_front = leading and _PAREN.sub("", before).strip() == ""
        if is_nonverbal(inner):
            pieces.append(match.group(0))
            nonverbals.append(inner.strip().lower())
            continue
        if at_front and direction is None:
            direction = parse_direction(inner)
            if direction.status == "unknown":
                issues.append(Issue(line_no, match.group(0), speaker, "direction", direction.unknown))
            continue
        issues.append(Issue(line_no, match.group(0), speaker, "inline", (inner.strip().lower(),)))
    pieces.append(raw[cursor:])
    return _SPACE.sub(" ", "".join(pieces)).strip(), direction, tuple(nonverbals)


def parse_script(text: str) -> Script:
    script = Script()
    script.meta, offset = split_frontmatter(text)
    body = text.split("\n")[offset:]
    last: int | None = None  # index into script.items of the last item, when it is a spoken line

    for index, raw_line in enumerate(body):
        line_no = offset + index + 1
        raw = raw_line.strip().replace("*", "")
        if not raw:
            continue
        if raw.upper().startswith("CAST:"):
            script.has_cast = True
            for name, gender, description in parse_cast(raw[5:]):
                traits = normalise(name, gender, description)
                script.roles[name] = Role(name, gender, description, traits.traits, traits.free_text)
            continue
        cue = CUE.match(raw)
        if cue:
            script.items.append(Cue(line_no, cue.group(1).upper(), cue.group(2).strip()))
            last = None
            continue
        spoken = LINE.match(raw)
        if spoken:
            speaker = spoken.group(1).strip()
            words, direction, nonverbals = _words(spoken.group(2), line_no, speaker, script.issues, lead=True)
            if _PAREN.sub("", words).strip():
                script.items.append(SpokenLine(line_no, speaker, words, direction, nonverbals))
                last = len(script.items) - 1
            else:
                last = None  # a line of only non-verbals is dropped, as the prototype does
                # ...and so is the continuation that follows it, which the prototype hands to the line above
                if script.items and isinstance(script.items[-1], SpokenLine):
                    last = len(script.items) - 1
        elif last is not None:
            # A speech broken over several lines belongs to the speaker above.
            above = script.items[last]
            assert isinstance(above, SpokenLine)
            more, _, extra = _words(raw, line_no, above.speaker, script.issues, lead=False)
            script.items[last] = SpokenLine(
                above.line,
                above.speaker,
                f"{above.text} {more}".strip(),
                above.direction,
                (*above.nonverbals, *extra),
                (*above.continued, line_no),
            )
    return script
