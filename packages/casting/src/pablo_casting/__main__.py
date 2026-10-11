"""`python -m pablo_casting <command> [--json]`."""

import sys

from pablo_casting.cli import main

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
