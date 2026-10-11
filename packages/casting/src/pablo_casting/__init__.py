"""pablo's casting side (pm project `pablo-casting`).

A Python package inside the pablo repo, run by the pablo CLI as
`python -m pablo_casting <command> --json` from a venv pablo provisions lazily
with `uv`. Every command answers with the body pablo prints and pablo's exit
codes: 0 ok, 2 refused, 1 error.
"""

from importlib.metadata import PackageNotFoundError, version as _dist_version

try:
    __version__ = _dist_version("pablo-casting")
except PackageNotFoundError:  # running from a source tree that was never installed
    __version__ = "0.0.0+source"
