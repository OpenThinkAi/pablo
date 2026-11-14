"""What `pronounce` leaves out of its "left as written" list, and how it ranks the rest (AGT-2304).

A long essay names dozens of capitalised words that are only ordinary words in a capital letter (`May`, `Center`,
`Federal`) or common first names (`Dan`, `David`), and the few a voice may really get wrong (`Amodei`, `ChatGPT`) were
buried among them. `pronounce` drops those by default (`--all` lists everything) and ranks what is left: mixed-case
tokens first, then words with unusual letter patterns, then the rest. Pure Python, no model; the word lists are
deliberately short and plain, because a miss only leaves a word on the list.
"""

from __future__ import annotations

import re

MONTHS = frozenset("january february march april may june july august september october november december".split())
WEEKDAYS = frozenset("monday tuesday wednesday thursday friday saturday sunday".split())

# Ordinary words that turn up capitalised in a title, a heading, a proper noun ("Federal Reserve", "Main Street") or after a colon.
COMMON_WORDS = frozenset(
    """
    about above across after again against all also always american americans among and another any are around as at
    authority avenue bank before being below best between beyond board bureau business but by california center centre
    central chapter chief church city civil college commission committee community company congress council country county
    court day days department district doctor does during each early east eastern economic education either england english
    enough even ever every european executive federal first for foundation french from future general global good government
    great group had has have he her here high him his house how however human if in industry institute international into
    is it its just last late law least less like little local long made make many may might more most much must national
    never new next night no north northern not nothing now of off office old on once one only or other our out over own
    part people place plan point political poor power president press private program project public question reading
    reports research reserve review right river road rule school science second secret section senate service several
    she should simple since small so social some south southern state states story street student students study such system
    team than that the their them then there these they thing things think this those though three through time times to today
    together too top toward town true two under union united university until up upon us use used very want was way we well
    were west western what when where which while who whole why will with within without work world would year years yes yet
    you young your
    """.split()
)

# Common first names; a surname or a rare name stays on the list.
FIRST_NAMES = frozenset(
    """
    aaron adam alan albert alex alice amanda amy andrew angela ann anna anne anthony arthur barbara ben benjamin beth betty
    bill bob brian bruce carl carol caroline catherine charles charlie chris christine christopher claire daniel dan dave
    david deborah diana diane donald dorothy douglas ed edward elizabeth emily emma eric erik frank fred gary george gerald
    grace greg hannah harry helen henry jack jacob james jane janet jason jeff jeffrey jennifer jenny jeremy jerry jessica
    jill jim joan joe john jon jonathan joseph joshua joyce judith judy julia julie justin karen kate katherine kathy keith
    kelly ken kenneth kevin kim larry laura lauren lee linda lisa lois louis lucy margaret maria mark martha martin mary
    matt matthew megan melissa michael michelle mike nancy nathan neil nicholas nick nicole olivia pamela patricia patrick
    paul peter philip rachel ralph randy raymond rebecca richard rick rob robert robin roger ron ronald rose roy russell ruth
    ryan sam samuel sandra sara sarah scott sean sharon simon sophie stephanie stephen steve steven susan tara teresa terry
    thomas tim timothy tom tony victoria vincent walter wendy william zach
    """.split()
)

_VOWELS = "aeiouy"
_RARE_PAIRS = ("kh", "zh", "dz", "tz", "gz", "sz", "cz", "vv", "jj", "qq", "xx", "zz", "kk", "ij", "bj", "kn", "gn", "pf", "mb", "wr")
_CONSONANT_RUN = re.compile(r"[^aeiouy]{4,}")
_VOWEL_RUN = re.compile(r"[aeiouy]{3,}")


def is_mixed_case(word: str) -> bool:
    """A capital after the first letter in a word that is not all caps (`ChatGPT`, `iPhone`, `McDonald`)."""
    letters = [c for c in word if c.isalpha()]
    if len(letters) < 2 or all(c.isupper() for c in letters):
        return False
    return any(c.isupper() for c in letters[1:]) or letters[0].islower() and any(c.isupper() for c in letters)


def is_unusual(word: str) -> bool:
    """Letter patterns English rarely has: a `q` without `u`, `x`/`z`/`j` inside the word, four consonants or three vowels
    in a row, or a pair from a short list of non-English clusters. A heuristic that only decides the order."""
    low = "".join(c for c in word.lower() if c.isalpha())
    if len(low) < 3:
        return False
    if re.search(r"q(?!u)", low) or any(pair in low for pair in _RARE_PAIRS):
        return True
    if any(c in low[1:] for c in "xzj") or _CONSONANT_RUN.search(low) or _VOWEL_RUN.search(low):
        return True
    return not any(c in _VOWELS for c in low)


def is_common(word: str) -> bool:
    """A month or weekday name, a common English word or a common first name, in any case."""
    low = word.lower()
    return low in MONTHS or low in WEEKDAYS or low in COMMON_WORDS or low in FIRST_NAMES


def rank(word: str) -> int:
    """0 for a mixed-case token, 1 for unusual letter patterns, 2 for the rest."""
    if is_mixed_case(word):
        return 0
    return 1 if is_unusual(word) else 2
