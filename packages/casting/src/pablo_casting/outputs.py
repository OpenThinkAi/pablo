"""Which audio output a command works on (AGT-2158, pm project `pablo-platform`, D-7).

Two outputs of a work are performed: `radio` (scripts in
`outputs/radio/episodes/`) and `narrated` (readings of another output's prose,
in `outputs/narrated/readings/`, AGT-2137). Each keeps its own casting state
beside its scripts, `outputs/<output>/casting/`: `cast.json`, `flags.json`,
`renders/epNN/` and `takes/`, so a narrated unit 1 and a radio episode 1 never
share a manifest, a flag or a binding.

The output is set once per command, by `cli.run`, from `--output` or else the
`PABLO_CASTING_OUTPUT` environment variable the pablo CLI sets (`radio` when
neither is given), and every path helper (`binding.script_dir`,
`binding.casting_dir`, `takes.casting_dir`, the lexicon) reads it through
`current()`. A unit keeps the radio vocabulary on disk (`renders/epNN/`,
`epNN.v<k>.m4a`): the number is the output's unit number.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

OUTPUT_ENV = "PABLO_CASTING_OUTPUT"
RADIO = "radio"
NARRATED = "narrated"
# output -> the directory its scripts live in, under `outputs/<output>/`.
SCRIPT_DIRS: dict[str, str] = {RADIO: "episodes", NARRATED: "readings"}
AUDIO_OUTPUTS: tuple[str, ...] = tuple(SCRIPT_DIRS)

_current: ContextVar[str] = ContextVar("pablo_casting_output", default=RADIO)


def current() -> str:
    """The output the running command works on."""
    return _current.get()


@contextmanager
def using(output: str) -> Iterator[None]:
    """Run a block on `output`'s scripts and casting state. Refuses an output that is not performed."""
    if output not in SCRIPT_DIRS:
        raise ValueError(f"unknown audio output {output!r}: one of {', '.join(AUDIO_OUTPUTS)}")
    token = _current.set(output)
    try:
        yield
    finally:
        _current.reset(token)


def output_dir(work: Path) -> Path:
    """`<work>/outputs/<output>/` for the current output."""
    return work / "outputs" / current()


def scripts_dir(work: Path) -> Path:
    """The current output's script directory (radio's `episodes/`, narrated's `readings/`)."""
    return output_dir(work) / SCRIPT_DIRS[current()]
