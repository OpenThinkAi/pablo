"""The sound library: real CC0 / public-domain recordings for everyday SFX and BED cues (AGT-1799).

Stable Audio Open renders everyday sounds badly (a clock like a wet log, an
unrecognisable dress rustle), so a cue whose description matches a curated
recording is built from that recording; only unmatched cues fall back to the
generator (`cues.py`). The library is audio on disk, never in the repo:

    <sounds>/<id>.<ext>    the recording exactly as downloaded (FLAC, AIFF, WAV, OGG), never modified
    <sounds>/<id>.json     its record: where it came from and what it is

The directory is `--sounds`, else the casting config's `sounds`, else
`$XDG_DATA_HOME/pablo/sounds` (`~/.local/share/pablo/sounds`); with none of
them present there is no library and every cue is generated, as before.

**Licence is the hard constraint.** A record must carry a `licence` of
`CC0-1.0` or `public-domain`, the `source_url` of the page the licence was
read on, and the `author`; `add` refuses anything else, and loading a library
that holds such a record is a refusal naming it (nothing is mixed from a
library with an unlicensed file in it).

**Matching** is deterministic and explainable, no model: the description's
words are reduced to stems (`stem`) and scored against each recording's
`subjects` (what the sound is: 3 points each) and `tags` (what else it has: 1
point each). A recording is a candidate only when it is for the cue's kind,
at least one subject matches and its score reaches `MIN_SCORE`; ties are
broken by a draw seeded with the cue's key, so the same cue always gets the
same recording and a tie never depends on file order. `matches` returns every
candidate ranked, which is what a "swap cue" picks the next one from.

**Rhythmic recordings** (`rhythmic: true`: a clock, crickets, a metronome) are
never chopped into random segments: `rhythm_loop` finds their ticks, lays
them on an exact grid of their own median interval and makes a loop of whole
cycles that starts and ends just before a tick, so a bed built from it repeats
at its natural period with every tick on time (`mix.LoopPlan`).
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from pablo_casting.audio import file_sha256, read_audio

LICENCES = ("CC0-1.0", "public-domain")
"""The only licences a recording in the library may carry."""
AUDIO_SUFFIXES = (".flac", ".wav", ".aif", ".aiff", ".ogg")
KINDS = ("SFX", "BED")
SUBJECT_POINTS = 3
TAG_POINTS = 1
MIN_SCORE = 3
"""One subject is enough; a tag alone never is."""

_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,79}$")
_WORD = re.compile(r"[a-z]+")
STOP = frozenset(
    "a an the of and or in on at to from with by into onto over under through as is are be its it his her their them "
    "this that these those sound sounds noise noises some very slowly softly quietly then while who which slow soft quiet".split()
)


class SoundRefusal(Exception):
    """A recording or a record that may not be used (licence, source, a missing file): a refusal (exit 2)."""

    def __init__(self, message: str, problems: Sequence[str] = ()) -> None:
        super().__init__(message)
        self.problems = list(problems)


def stem(word: str) -> str:
    """A crude, consistent stem: the same rule on descriptions and tags is what matters, not linguistic truth."""
    w = word.lower()
    for suffix in ("ing", "ed", "es", "s"):
        if suffix == "s" and w.endswith(("ss", "us", "is")):
            continue
        if w.endswith(suffix) and len(w) - len(suffix) >= 3:
            w = w[: -len(suffix)]
            break
    if w.endswith("e") and len(w) > 3:
        w = w[:-1]
    if len(w) > 3 and w[-1] == w[-2] and w[-1] not in "aeiouls":
        w = w[:-1]
    return w


def terms(text: str) -> set[str]:
    return {stem(w) for w in _WORD.findall(text.lower()) if w not in STOP and len(w) > 1}


@dataclass(frozen=True)
class Sound:
    id: str
    path: Path
    title: str
    source_url: str
    licence: str
    author: str
    kinds: tuple[str, ...]
    subjects: tuple[str, ...]
    tags: tuple[str, ...]
    rhythmic: bool
    excerpt: tuple[float, float] | None
    sha256: str
    seconds: float
    record: Mapping[str, object] = field(compare=False, repr=False)

    def provenance(self) -> dict[str, object]:
        return {"id": self.id, "title": self.title, "source_url": self.source_url, "licence": self.licence, "author": self.author, "sha256": self.sha256}


@dataclass(frozen=True)
class Match:
    sound: Sound
    score: int
    subjects: tuple[str, ...]
    tags: tuple[str, ...]

    def as_body(self) -> dict[str, object]:
        return {"id": self.sound.id, "score": self.score, "subjects": list(self.subjects), "tags": list(self.tags), "title": self.sound.title}


def record_problems(raw: object) -> list[str]:
    """Why a record may not be in the library (empty when it may)."""
    if not isinstance(raw, Mapping):
        return ["the record is not a JSON object"]
    problems: list[str] = []
    sid = raw.get("id")
    if not isinstance(sid, str) or not _ID.match(sid):
        problems.append("id: lowercase letters, digits and dashes")
    licence = raw.get("licence")
    if licence not in LICENCES:
        problems.append(f"licence: must be one of {', '.join(LICENCES)} (got {licence!r}); nothing else is allowed in the library")
    url = raw.get("source_url")
    if not isinstance(url, str) or not re.match(r"^https?://\S+$", url):
        problems.append("source_url: the http(s) page the licence was read on is required")
    author = raw.get("author")
    if not isinstance(author, str) or not author.strip():
        problems.append("author: required")
    kinds = raw.get("kinds")
    if not isinstance(kinds, list) or not kinds or any(k not in KINDS for k in kinds):
        problems.append(f"kinds: a non-empty list of {', '.join(KINDS)}")
    subjects = raw.get("subjects")
    if not isinstance(subjects, list) or not subjects or not all(isinstance(s, str) and s.strip() for s in subjects):
        problems.append("subjects: a non-empty list of words naming what the sound is")
    tags = raw.get("tags", [])
    if not isinstance(tags, list) or not all(isinstance(t, str) for t in tags):
        problems.append("tags: a list of words")
    if not isinstance(raw.get("rhythmic", False), bool):
        problems.append("rhythmic: true or false")
    excerpt = raw.get("excerpt")
    if excerpt is not None and not (
        isinstance(excerpt, list) and len(excerpt) == 2 and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in excerpt) and 0 <= excerpt[0] < excerpt[1]
    ):
        problems.append("excerpt: [start, end] seconds, start < end")
    return problems


def _sound(record_path: Path, raw: Mapping[str, object]) -> Sound:
    sid = str(raw["id"])
    audio = record_path.parent / str(raw.get("file", ""))
    if not raw.get("file") or not audio.is_file() or audio.parent != record_path.parent:
        raise SoundRefusal(f"{record_path.name}: its audio file {raw.get('file')!r} is not beside it")
    excerpt = raw.get("excerpt")
    return Sound(
        id=sid,
        path=audio,
        title=str(raw.get("title") or sid),
        source_url=str(raw["source_url"]),
        licence=str(raw["licence"]),
        author=str(raw["author"]),
        kinds=tuple(str(k) for k in raw["kinds"]),  # type: ignore[union-attr]
        subjects=tuple(sorted({stem(w) for s in raw["subjects"] for w in _WORD.findall(str(s).lower())})),  # type: ignore[union-attr]
        tags=tuple(sorted({stem(w) for t in raw.get("tags", []) for w in _WORD.findall(str(t).lower())})),  # type: ignore[union-attr]
        rhythmic=bool(raw.get("rhythmic", False)),
        excerpt=(float(excerpt[0]), float(excerpt[1])) if isinstance(excerpt, list) else None,
        sha256=str(raw.get("sha256", "")),
        seconds=float(raw.get("seconds", 0.0)),  # type: ignore[arg-type]
        record=raw,
    )


def _tiebreak(seed: str, sid: str) -> int:
    return int.from_bytes(hashlib.sha256(f"sound-tie:{seed}:{sid}".encode()).digest()[:8], "big")


class SoundLibrary:
    def __init__(self, root: Path, sounds: Sequence[Sound]) -> None:
        self.root = root
        self.sounds = list(sounds)
        self._by_id = {s.id: s for s in self.sounds}

    @classmethod
    def load(cls, root: Path) -> SoundLibrary:
        """Every record under `root`; any record that may not be used is a refusal naming each."""
        sounds: list[Sound] = []
        problems: list[str] = []
        for record_path in sorted(root.glob("*.json")) if root.is_dir() else []:
            try:
                raw = json.loads(record_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as broken:
                problems.append(f"{record_path.name}: {broken}")
                continue
            found = record_problems(raw)
            if found:
                problems.extend(f"{record_path.name}: {p}" for p in found)
                continue
            try:
                sounds.append(_sound(record_path, raw))
            except SoundRefusal as refusal:
                problems.append(str(refusal))
        if problems:
            raise SoundRefusal(f"the sound library at {root} holds records that may not be used: {'; '.join(problems)}", problems)
        return cls(root, sounds)

    def get(self, sid: str) -> Sound | None:
        return self._by_id.get(sid)

    def matches(self, kind: str, desc: str, seed: str) -> list[Match]:
        """Every candidate recording for `(kind, desc)`, best first; ties in a seeded order."""
        words = terms(desc)
        out: list[Match] = []
        for sound in self.sounds:
            if kind not in sound.kinds:
                continue
            subjects = tuple(sorted(words & set(sound.subjects)))
            if not subjects:
                continue
            tags = tuple(sorted((words & set(sound.tags)) - set(subjects)))
            score = SUBJECT_POINTS * len(subjects) + TAG_POINTS * len(tags)
            if score >= MIN_SCORE:
                out.append(Match(sound, score, subjects, tags))
        return sorted(out, key=lambda m: (-m.score, _tiebreak(seed, m.sound.id)))

    def best(self, kind: str, desc: str, seed: str) -> Match | None:
        found = self.matches(kind, desc, seed)
        return found[0] if found else None

    def add(self, source: Path, record: Mapping[str, object]) -> Sound:
        """Copies `source` (read only as audio) into the library beside its record; refuses an unlicensed or unreadable one."""
        problems = record_problems(record)
        if problems:
            raise SoundRefusal(f"{source.name} was not added: {'; '.join(problems)}", problems)
        suffix = source.suffix.lower()
        if suffix not in AUDIO_SUFFIXES:
            raise SoundRefusal(f"{source.name} was not added: only {', '.join(AUDIO_SUFFIXES)} files")
        sid = str(record["id"])
        if self.get(sid) is not None or (self.root / f"{sid}.json").exists():
            raise SoundRefusal(f"{sid} is already in the sound library")
        try:
            audio, rate = read_audio(source)
        except Exception as unreadable:  # noqa: BLE001 - libsndfile raises several types; any of them means "not audio we can read"
            raise SoundRefusal(f"{source.name} was not added: it does not decode as audio ({unreadable})") from unreadable
        if len(audio) == 0:
            raise SoundRefusal(f"{source.name} was not added: it holds no audio")
        self.root.mkdir(parents=True, exist_ok=True)
        ignore = self.root / ".gitignore"
        if not ignore.exists():
            ignore.write_text("# downloaded recordings stay on disk, never in a repo; the .json records say where each came from\n*\n", encoding="utf-8")
        target = self.root / f"{sid}{suffix}"
        shutil.copyfile(source, target)
        full = {
            **record,
            "file": target.name,
            "sha256": file_sha256(target),
            "seconds": round(len(audio) / rate, 3),
            "sample_rate": rate,
        }
        (self.root / f"{sid}.json").write_text(json.dumps(full, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        sound = _sound(self.root / f"{sid}.json", full)
        self.sounds.append(sound)
        self._by_id[sid] = sound
        return sound


def sounds_dir_for(explicit: str | None, configured: str | None, env: Mapping[str, str]) -> Path:
    if explicit:
        return Path(explicit).expanduser()
    if configured:
        return Path(configured).expanduser()
    base = env.get("XDG_DATA_HOME")
    root = Path(base) if base else Path(env.get("HOME", str(Path.home()))) / ".local" / "share"
    return root / "pablo" / "sounds"


def open_sounds(explicit: str | None, configured: str | None, env: Mapping[str, str]) -> SoundLibrary | None:
    """The sound library, or None when its directory does not exist (every cue is then generated)."""
    root = sounds_dir_for(explicit, configured, env)
    if not root.is_dir():
        if explicit:
            raise SoundRefusal(f"--sounds {explicit} is not a directory")
        return None
    return SoundLibrary.load(root)


# --- rhythm -----------------------------------------------------------------------------------


@dataclass(frozen=True)
class Loop:
    """A seamless loop of a rhythmic recording, in samples of the cue audio it was built into.

    The cue audio is the recording *regularised*: its ticks re-laid on an exact
    grid (`period` seconds apart, or a tick-tock pair of `periods` when the two
    alternate), each tick's own slice of the recording kept. The loop runs
    from `start` (`pre` before the first tick) for `length` samples, a whole
    number of cycles, so its seam lands in the quiet just before a tick; the
    `xfade` samples before `start` are the quiet a seam crossfades from. Played
    back to back (`mix.LoopPlan`) every tick stays on the grid.
    """

    start: int
    length: int
    xfade: int
    periods: tuple[int, ...]
    ticks: int

    @property
    def cycles(self) -> int:
        return len(self.periods)

    def as_body(self) -> dict[str, object]:
        return {"start": self.start, "length": self.length, "xfade": self.xfade, "periods": list(self.periods), "ticks": self.ticks}


def onsets(audio: np.ndarray, rate: int, *, refractory: float = 0.12) -> list[int]:
    """Tick onsets (samples): where a 1 ms high-passed energy envelope first rises past half of each strong peak."""
    x = np.asarray(audio, dtype=np.float64).reshape(-1)
    if len(x) < rate // 10:
        return []
    hp = np.diff(x, prepend=x[0])
    hop = max(1, rate // 1000)
    frames = len(hp) // hop
    env = np.sqrt((hp[: frames * hop] ** 2).reshape(frames, hop).mean(axis=1))
    floor, top = float(np.median(env)), float(np.percentile(env, 99.9))
    if top <= floor * 4:
        return []
    threshold = floor + 0.3 * (top - floor)
    gap = int(refractory * 1000)
    out: list[int] = []
    k = 0
    while k < frames:
        if env[k] >= threshold:
            peak_at = k + int(np.argmax(env[k : k + 30]))
            half = env[peak_at] * 0.5
            first = peak_at
            while first > 0 and env[first - 1] >= half and peak_at - first < 30:
                first -= 1
            lo = first * hop  # to the sample: the first in that frame past half the frame's own peak
            seg = np.abs(hp[lo : lo + hop])
            out.append(lo + (int(np.argmax(seg >= 0.5 * float(seg.max()))) if seg.size and seg.max() > 0 else 0))
            k = peak_at + gap
        else:
            k += 1
    return out


def aligned(audio: np.ndarray, rate: int, ticks: Sequence[int], *, before: float = 0.05, after: float = 0.2, search: float = 0.04, rounds: int = 4, drop: bool = False) -> list[int]:
    """`ticks` moved onto one consistent point of each tick: each tick's envelope aligned to the ticks' mean shape.

    A tick is often several clicks (an escapement's pre-click, its main blow), and
    a threshold crossing lands on whichever passes first, a few tens of ms apart
    from tick to tick. Cross-correlating every tick's 0.25 ms envelope with
    their average (re-averaged after each round) puts all of them on the same
    point of the shape, which is what "on time" means to the ear. A tick too
    near either end to be searched keeps its threshold time, or with `drop` is
    left out.
    """
    x = np.asarray(audio, dtype=np.float64).reshape(-1)
    if len(ticks) < 2:
        return list(ticks)
    hop = max(1, rate // 4000)
    hp = np.diff(x, prepend=x[0])
    frames = len(hp) // hop
    env = np.sqrt((hp[: frames * hop] ** 2).reshape(frames, hop).mean(axis=1))
    b, a, s = int(before * rate / hop), int(after * rate / hop), int(search * rate / hop)
    at = [t // hop for t in ticks]
    usable = [k for k, t in enumerate(at) if t - b - s >= 0 and t + a + s <= frames]
    if len(usable) < 2:
        return [] if drop else list(ticks)
    shift = {k: 0 for k in usable}
    for _ in range(rounds):
        template = np.mean([env[at[k] + shift[k] - b : at[k] + shift[k] + a] for k in usable], axis=0)
        template = (template - template.mean()) / (np.linalg.norm(template - template.mean()) or 1.0)
        for k in usable:
            region = env[at[k] - b - s : at[k] + a + s]
            windows = np.lib.stride_tricks.sliding_window_view(region, b + a)
            centred = windows - windows.mean(axis=1, keepdims=True)
            score = centred @ template / (np.linalg.norm(centred, axis=1) + 1e-12)
            shift[k] = int(np.argmax(score)) - s
    return [(at[k] + shift[k]) * hop if k in shift else ticks[k] for k in range(len(ticks)) if k in shift or not drop]


def _cycles(gaps: np.ndarray) -> int:
    """2 when every second interval is alike and the two kinds differ (a tick-tock out of beat), else 1."""
    if len(gaps) < 4:
        return 1
    even, odd = float(np.median(gaps[0::2])), float(np.median(gaps[1::2]))
    return 2 if abs(even - odd) > 0.05 * float(np.median(gaps)) else 1


def rhythm_loop(audio: np.ndarray, rate: int, *, pre: float = 0.025, xfade: float = 0.02, fade: float = 0.005, tolerance: float = 0.15) -> tuple[np.ndarray, Loop] | None:
    """The recording regularised into a loop of whole cycles, or None when it has no steady tick.

    The longest run of ticks whose intervals are all within `tolerance` of their
    kind's median is kept; each tick's slice (from `pre` before it to `pre`
    before the next) is laid at an exact multiple of the median interval,
    trimmed in the quiet when the recorded one was longer, extended with its own
    quiet tail when shorter, joined with `fade`-long crossfades. The result has
    `xfade + fade` samples of the quiet before the first tick ahead of the loop.
    """
    x = np.asarray(audio, dtype=np.float32).reshape(-1)
    ticks = aligned(x, rate, onsets(x, rate))
    if len(ticks) < 5:
        return None
    gaps = np.diff(ticks).astype(np.float64)
    cycles = _cycles(gaps)
    medians = [float(np.median(gaps[p::cycles])) for p in range(cycles)]
    ok = [abs(g - medians[k % cycles]) <= tolerance * medians[k % cycles] for k, g in enumerate(gaps)]
    pre_n, xfade_n, fade_n = int(round(pre * rate)), int(round(xfade * rate)), int(round(fade * rate))
    head_n = xfade_n + fade_n
    best: tuple[int, int] | None = None  # ticks [i, e): every gap i..e-1 is steady
    run = 0
    for k in range(len(gaps) + 1):
        if k == len(gaps) or not ok[k]:
            i = run
            while i < k and ticks[i] - pre_n - head_n < 0:
                i += 1
            n = (k - i) // cycles * cycles
            if n >= max(2, cycles) and (best is None or n > best[1] - best[0]):
                best = (i, i + n)
            run = k + 1
    if best is None:
        return None
    i, e = best
    phase = [int(round(medians[(i + p) % cycles])) for p in range(cycles)]  # the loop's own phase order
    lengths = [phase[(k - i) % cycles] for k in range(i, e)]
    grid = [head_n + pre_n + sum(lengths[: k - i]) for k in range(i, e)]  # where each tick lands in the result
    ramp = np.linspace(0.0, 1.0, fade_n, dtype=np.float32) if fade_n else np.zeros(0, dtype=np.float32)

    def build(at_ticks: Sequence[int]) -> np.ndarray:
        out = np.zeros(head_n + sum(lengths) + fade_n, dtype=np.float32)

        def place(at: int, piece: np.ndarray, fade_in: bool) -> None:
            piece = piece.copy()
            if fade_n and fade_in:
                piece[:fade_n] *= ramp
            if fade_n:
                piece[-fade_n:] *= ramp[::-1]
            out[at : at + len(piece)] += piece

        start0 = at_ticks[i] - pre_n
        place(0, x[start0 - head_n : start0 + fade_n], fade_in=False)
        at = head_n
        for k, want in zip(range(i, e), lengths):
            begin, natural = at_ticks[k] - pre_n, ticks[k + 1] - at_ticks[k]
            size = want + fade_n
            if natural >= size:
                slot = x[begin : begin + size]
            else:  # the recorded interval was short: its own quiet tail, repeated, fills it
                short = size - natural
                body = x[begin : begin + natural + fade_n].copy()
                tail = x[begin + natural - short : begin + natural + fade_n].copy()
                if fade_n:
                    body[-fade_n:] *= ramp[::-1]
                    tail[:fade_n] *= ramp
                slot = np.zeros(size + fade_n, dtype=np.float32)
                slot[: len(body)] += body
                slot[natural : natural + len(tail)] += tail
                slot = slot[:size]
            place(at, slot, fade_in=True)
            at += want
        return out

    out = build(ticks)
    return out, Loop(start=head_n, length=sum(lengths), xfade=xfade_n, periods=tuple(phase), ticks=e - i)


def tick_jitter(audio: np.ndarray, rate: int, cycles: int = 1) -> dict[str, object]:
    """AC3's measure: how far each tick-to-same-tick interval (`cycles` ticks apart) strays from their median, in ms."""
    ticks = aligned(audio, rate, onsets(audio, rate), drop=True)
    if len(ticks) < cycles + 2:
        return {"ticks": len(ticks), "max_ms": None, "std_ms": None}
    spans = np.array([ticks[k + cycles] - ticks[k] for k in range(len(ticks) - cycles)], dtype=np.float64) / rate * 1000
    dev = np.abs(spans - np.median(spans))
    return {"ticks": len(ticks), "cycle_ms": round(float(np.median(spans)), 3), "max_ms": round(float(dev.max()), 3), "std_ms": round(float(spans.std()), 3)}
