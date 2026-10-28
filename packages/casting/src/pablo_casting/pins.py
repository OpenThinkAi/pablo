"""Every built-in model download, pinned to an immutable revision (AGT-2274).

One place: each Hub repo id (or torch.hub GitHub repo) pablo casting downloads
by default, next to the full commit SHA it is fetched at. A loader never asks
for a repo's current revision; it looks its pin up here (`pinned`), so a
force-pushed or re-uploaded checkpoint under the same id cannot change what
pablo runs. A commit SHA names the exact file tree (and, for LFS weights, their
sha256), so it is the integrity check: none of these loaders verifies a
separate hash.

To bump a pin (docs/commands.md, "Pinned model revisions"): read the repo's
current commit with `curl -s https://huggingface.co/api/models/<repo> | jq -r .sha`
(metadata only, no weights), replace the SHA below, and run the `-m models`
tests on the Studio before merging.

Models the author lists in casting.json (`weights`, `engines.designers`) carry
their own optional `revision`; without one they fetch the Hub's current
revision, and pablo says so on stderr.
"""

from __future__ import annotations

PINS: dict[str, str] = {
    # The gate's scorers (scorers.py), read from the Hub 2026-10-28.
    "mlx-community/whisper-large-v3-turbo": "a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb",
    "mlx-community/Qwen3-ForcedAligner-0.6B-bf16": "53c8c0e46733eec430e4b53dd6471d0e5dee45f8",
    "speechbrain/spkrec-ecapa-voxceleb": "0f99f2d0ebe89ac095bcc5903c4dd8f72b367286",
    "facebook/audiobox-aesthetics": "9b1dd8e5df9af7216e836a98974fe3b82c56ded6",
    "emotion2vec/emotion2vec_plus_large": "6c303ba987b86b93193de93e34bb2b077a6bedc4",
    # UTMOS goes through torch.hub (GitHub, not the Hub): the commit tag v1.2.0 points at
    # (git ls-remote, 2026-10-10).
    "tarepan/SpeechMOS": "ed25eacbfa42b99156c36ebec67a733b5dbb9b79",
    # The default voice designers (toolkit.py), read from the Hub 2026-10-28.
    "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16": "7d3824abff87e49756bb0f83fb5411de75d160c4",
    "mlx-community/VoxCPM2-bf16": "a7fb80d9056983135a54ca3f71fcc5a637ccddf5",
    # The performance engines (engines.py).
    "mlx-community/chatterbox-turbo-fp16": "b2d0a13aa7cfff0a06d9acb247ae91c8f19a6d75",
    "mlx-community/Dia-1.6B": "de4fa8c178ca5cc4e9d884b55b03fcfaa0995162",
    "mlx-community/Chatterbox-TTS-fp16": "77c7c8f9307beb5dc6c03cebc7942c4de9d617c9",
    # The mix's SFX and BED cue model (cues.py), read from the Hub 2026-10-28.
    "stabilityai/stable-audio-open-1.0": "f21265c1e2710b3bd2386596943f0007f55f802e",
}


def pinned(repo: str) -> str:
    """The pinned commit of a built-in model; a `KeyError` (a bug, caught by the tests) when there is none."""
    return PINS[repo]


def is_commit(revision: str) -> bool:
    """A full 40-hex commit SHA: the only kind of revision that cannot move (a branch or tag can)."""
    return len(revision) == 40 and all(c in "0123456789abcdef" for c in revision.lower())
