"""Spoken forms of written shorthand for the engines (AGT-2302), before numerals are spelled. Pure Python, no model.

The script keeps what the author wrote; `engines.read_text` runs `expand` on the engine input only, on every track,
then `numerals.spell_numbers`, the caps rules and the lexicon. In order:

- **Links**: URLs and email addresses are masked first (`mask`), so no rule rewrites inside them, and put back
  as written at the end (`unmask`); `pablo pronounce` lists them for the author to rewrite by hand.
- **Abbreviations** (case-sensitive): `Mr.` Mister, `Mrs.` Missus, `Ms.` Miz; before a capitalised name `Dr.`
  Doctor, `St.` Saint, `Gov.` Governor, `Sen.` Senator, `Rep.` Representative, `Prof.` Professor, `Gen.` General,
  `Lt.` Lieutenant, `Sgt.` Sergeant; after a name `Jr.` Junior, `Sr.` Senior (titles keep their capital); `vs.`/`vs` versus, `etc.` et
  cetera, `e.g.` for example, `i.e.` that is, `approx.` approximately, `No. 2` number 2; `Jan.`..`Dec.` before a
  day number the month and the day as an ordinal (`Oct. 22` -> "October twenty-second"). An abbreviation that
  ends its line keeps a full stop.
- **Dates** `10/22/2026` -> "October twenty-second, 2026" (three slash parts: month, day, year).
- **Times** `3:15` -> "three fifteen", `3:05` -> "three oh five", `12:00` -> "twelve", `3:00 p.m.`, `3pm`,
  `3p`, `3 PM` -> "three p.m.".
- **Fractions** `1/2` one half, `1/3` one third, `2/3` two thirds, `1/4` one quarter, `3/4` three quarters,
  `1 1/2` "one and one half", otherwise "n over d" (`24/7` "twenty-four seven").
- **Decades, quarters, fiscal years**: `'90s` nineties, `1990s` nineteen nineties, `2020s` twenty twenties;
  `Q3` "Q three"; `FY2026` "fiscal year 2026".
- **Magnitudes** `$7T` seven trillion dollars, `15M` fifteen million, `3B`/`3bn` billion, `4k`/`$4K` thousand
  (`4K` and `8K` without `$` are a screen resolution and stay), `10x` ten times.
- **Units** after a number, singular for exactly 1: mph, km, km/h, kg, lb/lbs, ft, `in.`, mi, cm, mm, ml, GB, MB,
  TB, bps (basis points), pts, ppl, hr/hrs, min/mins, sec/secs, yr/yrs.
- **Symbols**: `&` and, `%` with no number percent, a slash between words " or ", `×` or `x` between numbers
  times, `~` before a number about, `±` plus or minus, `#` before a number number, `@` at.

Numbers these rules produce are words already, so `spell_numbers` never reads them as years. A word the work's
lexicon respells (`keep`, lower-case, without its full stop) is left to the lexicon.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Collection

from pablo_casting.numerals import Changes, ONES, under_hundred, cardinal, ordinal, recorded

_WORDS = re.compile(r"[A-Za-z0-9]+(?:'[A-Za-z0-9]+)*")

# --- links ---------------------------------------------------------------------------------------------------

_LINK = re.compile(
    r"(?:https?://|www\.)[^\s<>\"]+[^\s<>\".,;:!?)\]]"
    r"|[\w.+-]+@[\w-]+(?:\.[\w-]+)+"
    r"|\b[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|io|ai|gov|edu|co|uk|dev|app)(?:/[^\s<>\"]*[^\s<>\".,;:!?)\]])?\b"
)


def links(text: str) -> list[str]:
    """The URLs and email addresses in `text`, as written."""
    return [m.group(0) for m in _LINK.finditer(text)]


def mask(text: str) -> tuple[str, list[str]]:
    """`text` with each link replaced by a placeholder no rule matches, and the links in order."""
    found: list[str] = []

    def hide(match: re.Match[str]) -> str:
        found.append(match.group(0))
        return "\ue000" + "".join(chr(0xE100 + int(d)) for d in str(len(found) - 1)) + "\ue001"

    return _LINK.sub(hide, text), found


def unmask(text: str, found: list[str]) -> str:
    def show(match: re.Match[str]) -> str:
        return found[int("".join(str(ord(c) - 0xE100) for c in match.group(0)[1:-1]))]

    return re.sub("\ue000[\ue100-\ue109]+\ue001", show, text) if found else text


# --- numbers as words ------------------------------------------------------------------------------------------


def number_words(raw: str) -> str:
    """A written number as said, never as a year: "2,000" two thousand, "2.5" two point five."""
    whole, _, fraction = raw.replace(",", "").partition(".")
    words = cardinal(int(whole or "0"))
    return f"{words} point {' '.join(ONES[int(d)] for d in fraction)}" if fraction else words


def _is_one(raw: str) -> bool:
    return raw.replace(",", "") in ("1", "1.0")


# --- abbreviations -------------------------------------------------------------------------------------------

# Titles keep their capital, as a title before a name is written ("Governor Lisa Cook").
ALWAYS = {"Mr": "Mister", "Mrs": "Missus", "Ms": "Miz"}
BEFORE_NAME = {
    "Dr": "Doctor", "St": "Saint", "Gov": "Governor", "Sen": "Senator", "Rep": "Representative",
    "Prof": "Professor", "Gen": "General", "Lt": "Lieutenant", "Sgt": "Sergeant",
}  # fmt: skip
AFTER_NAME = {"Jr": "Junior", "Sr": "Senior"}
PLAIN = {"etc.": "et cetera", "e.g.": "for example", "i.e.": "that is", "approx.": "approximately"}
MONTHS = {
    "Jan": "January", "Feb": "February", "Mar": "March", "Apr": "April", "Aug": "August", "Sept": "September",
    "Sep": "September", "Oct": "October", "Nov": "November", "Dec": "December",
}  # fmt: skip
MONTH_NAMES = ("", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December")
KNOWN_ABBREVIATIONS = frozenset({*ALWAYS, *BEFORE_NAME, *AFTER_NAME, *MONTHS, "vs", "etc", "approx", "No"})

_ABBREV_ALWAYS = re.compile(r"\b(Mr|Mrs|Ms)\.")
_ABBREV_BEFORE = re.compile(r"\b(" + "|".join(BEFORE_NAME) + r")\.(?=\s+[A-Z])")
_ABBREV_AFTER = re.compile(r"(?<=[A-Za-z])(,?\s+)(Jr|Sr)\.")
_VERSUS = re.compile(r"\bvs\b\.?")
_PLAIN = re.compile(r"(?<![\w.])(etc\.|e\.g\.|i\.e\.|approx\.)")
_NUMBER_ABBREV = re.compile(r"\bNo\.\s?(?=\d)")
_MONTH_DAY = re.compile(r"\b(" + "|".join(MONTHS) + r")\.\s+(\d{1,2})(?:st|nd|rd|th)?\b(?![\d:/.]\d)")


def _ends(match: re.Match[str]) -> bool:
    """The match ends its line, so the full stop it took was also the sentence's."""
    return match.string[match.end() :].strip() == ""


def _stop(match: re.Match[str], words: str) -> str:
    return words + "." if _ends(match) and match.group(0).endswith(".") else words


# --- the rest ----------------------------------------------------------------------------------------------------

_DATE = re.compile(r"(?<![\w/.])(\d{1,2})/(\d{1,2})/(\d{4}|\d{2})(?![\w/])")
_AMPM = r"(?:\s?([AaPp])\.?\s?[Mm]\b\.?|([ap])\b)"
_TIME = re.compile(r"(?<![\w:.])(\d{1,2}):(\d{2})(?::\d{2})?(?![\d:])" + f"(?:{_AMPM})?")
_HOUR_AMPM = re.compile(r"(?<![\w:.$])(\d{1,2})" + _AMPM)
_FRACTIONS = {(1, 2): "one half", (1, 3): "one third", (2, 3): "two thirds", (1, 4): "one quarter", (3, 4): "three quarters"}
_MIXED = re.compile(r"(?<![\w./])(\d+)\s+(\d+)/(\d+)(?![\w/]|\.\d)")
_FRACTION = re.compile(r"(?<![\w./])(\d+)/(\d+)(?![\w/]|\.\d)")
_DECADE_SHORT = re.compile(r"(?<!\w)['’](\d)0s\b")
_DECADE = re.compile(r"\b(1\d|20)(\d)0s\b")
_QUARTER = re.compile(r"\bQ([1-4])\b")
_FISCAL = re.compile(r"\bFY\s?['’]?(\d{4}|\d{2})\b")
MAGNITUDES = {"T": "trillion", "tn": "trillion", "B": "billion", "bn": "billion", "M": "million", "mn": "million", "K": "thousand", "k": "thousand"}
# A word suffix may follow a space (`7 bn`); a letter must touch the number (`7T`, never `7 T-shirts`).
_MAGNITUDE = re.compile(r"(?<![\w.])(\$)?(\d+(?:,\d{3})*(?:\.\d+)?)(?:\s?(tn|bn|mn)|([TBMKk]))\b(?![-'’]|\.\d)")
_RESOLUTION = re.compile(r"\s*(?:video|tv|tvs|display|displays|resolution|monitor|monitors|screen|screens|hdr|uhd|stream|streaming)\b|\s*[.,;:!?)]|\s*$", re.I)
_TIMES_SUFFIX = re.compile(r"(?<![\w.])(\d+(?:\.\d+)?)x\b")
UNITS: dict[str, tuple[str, str]] = {
    "mph": ("mile per hour", "miles per hour"), "km/h": ("kilometer per hour", "kilometers per hour"),
    "km": ("kilometer", "kilometers"), "kg": ("kilogram", "kilograms"), "lb": ("pound", "pounds"),
    "lbs": ("pound", "pounds"), "ft": ("foot", "feet"), "in.": ("inch", "inches"), "mi": ("mile", "miles"),
    "cm": ("centimeter", "centimeters"), "mm": ("millimeter", "millimeters"), "ml": ("milliliter", "milliliters"),
    "GB": ("gigabyte", "gigabytes"), "MB": ("megabyte", "megabytes"), "TB": ("terabyte", "terabytes"),
    "bps": ("basis point", "basis points"), "pts": ("point", "points"), "ppl": ("people", "people"),
    "hr": ("hour", "hours"), "hrs": ("hour", "hours"), "min": ("minute", "minutes"), "mins": ("minute", "minutes"),
    "sec": ("second", "seconds"), "secs": ("second", "seconds"), "yr": ("year", "years"), "yrs": ("year", "years"),
}  # fmt: skip
_UNIT = re.compile(
    r"(?<![\w.])(\d+(?:,\d{3})*(?:\.\d+)?)\s?("
    + "|".join(re.escape(u) for u in sorted(UNITS, key=len, reverse=True) if u != "in.")
    + r")\b|(?<![\w.])(\d+(?:,\d{3})*(?:\.\d+)?)\s?(in\.)"
)
_TIMES = re.compile(r"(?<=\d)\s?[×x]\s?(?=\d)")
_ABOUT = re.compile(r"~\s?(?=[\d$.])")
_PLUS_MINUS = re.compile(r"\s?±\s?")
_HASH = re.compile(r"#\s?(?=\d)")
_AT = re.compile(r"\s?@\s?")
_AND = re.compile(r"\s?&\s?")
_PERCENT = re.compile(r"(?<![\d.])\s?%")
_WORD_SLASH = re.compile(r"(?<=[A-Za-z])(?<!\bkm)(?<!\bm)/(?=[A-Za-z])")  # not km/h, m/s
_SPACES = re.compile(r"[ \t]{2,}")


def _hour(raw: str) -> str:
    return cardinal(int(raw))


def _time(match: re.Match[str]) -> str:
    hours, minutes, ap, ap_short = match.groups()
    h, m = int(hours), int(minutes)
    if h > 23 or m > 59:
        return match.group(0)
    words = _hour(hours) if m == 0 else f"{_hour(hours)} oh {ONES[m]}" if m < 10 else f"{_hour(hours)} {under_hundred(m)}"
    half = ap or ap_short
    return f"{words} {half.lower()}.m." if half else words


def _hour_ampm(match: re.Match[str]) -> str:
    hours, ap, ap_short = match.groups()
    if not 1 <= int(hours) <= 12:
        return match.group(0)
    return f"{_hour(hours)} {(ap or ap_short).lower()}.m."


def _date(match: re.Match[str]) -> str:
    month, day, year = (int(g) for g in match.groups())
    if not (1 <= month <= 12 and 1 <= day <= 31):
        return match.group(0)
    return f"{MONTH_NAMES[month]} {ordinal(day)}, {match.group(3)}"


def fraction_words(n: int, d: int) -> str:
    if (n, d) in _FRACTIONS:
        return _FRACTIONS[(n, d)]
    if (n, d) == (24, 7):
        return "twenty-four seven"
    return f"{cardinal(n)} over {cardinal(d)}"


def _decade_word(tens: int) -> str:
    return {0: "hundreds", 1: "tens"}.get(tens) or under_hundred(tens * 10)[:-1] + "ies"


def _decade(match: re.Match[str]) -> str:
    century, tens = match.group(1), int(match.group(2))
    if century == "20" and tens == 0:
        return "two thousands"
    return f"{under_hundred(int(century))} {_decade_word(tens)}"


def _magnitude(match: re.Match[str]) -> str:
    dollar, raw, word, letter = match.groups()
    suffix = word or letter
    if suffix == "K" and not dollar and raw in ("2", "4", "5", "8") and _RESOLUTION.match(match.string, match.end()):
        return match.group(0)  # 4K video: a screen resolution
    return f"{number_words(raw)} {MAGNITUDES[suffix]}" + (" dollars" if dollar else "")


def _unit(match: re.Match[str]) -> str:
    raw = match.group(1) or match.group(3)
    unit = match.group(2) or match.group(4)
    one, many = UNITS[unit]
    words = f"{number_words(raw)} {one if _is_one(raw) else many}"
    return words + "." if unit == "in." and _ends(match) else words


def expand(text: str, changes: Changes | None = None, keep: Collection[str] = ()) -> str:
    """`text` with written shorthand in its spoken form (see the module docstring); `changes` gets each replacement."""

    def kept(fn: Callable[[re.Match[str]], str], group: int = 1) -> Callable[[re.Match[str]], str]:
        def sub(match: re.Match[str]) -> str:
            # Any word of the match the lexicon respells leaves the whole match to it (`min -> minimum` in "5 min").
            words = _WORDS.findall(match.group(group) or "") + _WORDS.findall(match.group(0))
            return match.group(0) if keep and any(w.lower() in keep for w in words) else fn(match)

        return recorded(sub, changes)

    def rule(pattern: re.Pattern[str], fn: Callable[[re.Match[str]], str], group: int = 1) -> None:
        nonlocal text
        text = pattern.sub(kept(fn, group), text)

    rule(_ABBREV_ALWAYS, lambda m: _stop(m, ALWAYS[m.group(1)]))
    rule(_ABBREV_BEFORE, lambda m: BEFORE_NAME[m.group(1)])
    rule(_ABBREV_AFTER, lambda m: m.group(1) + _stop(m, AFTER_NAME[m.group(2)]), 2)
    rule(_VERSUS, lambda m: _stop(m, "versus"), 0)
    rule(_PLAIN, lambda m: _stop(m, PLAIN[m.group(1)]))
    rule(_NUMBER_ABBREV, lambda m: "number ", 0)
    rule(_MONTH_DAY, lambda m: f"{MONTHS[m.group(1)]} {ordinal(int(m.group(2)))}")
    rule(_DATE, _date, 0)
    rule(_TIME, _time, 0)
    rule(_HOUR_AMPM, _hour_ampm, 0)
    rule(_MIXED, lambda m: f"{cardinal(int(m.group(1)))} and {fraction_words(int(m.group(2)), int(m.group(3)))}", 0)
    rule(_FRACTION, lambda m: fraction_words(int(m.group(1)), int(m.group(2))), 0)
    rule(_DECADE_SHORT, lambda m: _decade_word(int(m.group(1))), 0)
    rule(_DECADE, _decade, 0)
    rule(_QUARTER, lambda m: f"Q {ONES[int(m.group(1))]}", 0)
    rule(_FISCAL, lambda m: "fiscal year " + (m.group(1) if len(m.group(1)) == 4 else under_hundred(int(m.group(1)))), 0)
    rule(_MAGNITUDE, _magnitude, 0)
    rule(_TIMES_SUFFIX, lambda m: f"{number_words(m.group(1))} times", 0)
    rule(_UNIT, _unit, 0)
    rule(_TIMES, lambda m: " times ", 0)
    rule(_ABOUT, lambda m: "about ", 0)
    rule(_PLUS_MINUS, lambda m: " plus or minus ", 0)
    rule(_HASH, lambda m: "number ", 0)
    rule(_AT, lambda m: " at ", 0)
    rule(_AND, lambda m: " and ", 0)
    rule(_PERCENT, lambda m: " percent", 0)
    rule(_WORD_SLASH, lambda m: " " if re.match(r"or\b", m.string[m.end() :]) else " or ", 0)  # and/or -> "and or"
    return _SPACES.sub(" ", text)


# --- what `pronounce` lists as undecided ---------------------------------------------------------------------------

_ABBREVIATION_LIKE = re.compile(r"(?<![\w.])([A-Za-z]{1,5})\.(?=\s+[a-z0-9])")
_DOTTED = re.compile(r"(?<![\w.])(?:[A-Za-z]\.){2,}")
_NUMBER_UNIT = re.compile(r"(?<![\w.])\d+(?:\.\d+)?([A-Za-z]{1,5})\b")
_DECIDED_SUFFIXES = frozenset({"st", "nd", "rd", "th", "s", "x", "a", "p", "am", "pm", *MAGNITUDES, *(u for u in UNITS if "." not in u and "/" not in u)})


def undecided(text: str) -> list[tuple[str, str]]:
    """`(token, kind)` the rules saw but could not decide: `link`, `abbreviation` (a short word and a full stop that
    is not a sentence's end) and `unit` (letters stuck to a number)."""
    found: list[tuple[str, str]] = [(link, "link") for link in links(text)]
    masked, _ = mask(text)
    dotted = {m.start() for m in _DOTTED.finditer(masked)}
    for match in _ABBREVIATION_LIKE.finditer(masked):
        word = match.group(1)
        if word in KNOWN_ABBREVIATIONS or match.start() in dotted or masked[max(0, match.start() - 2) : match.start()].endswith("."):
            continue
        if word.islower() and len(word) > 3:
            continue  # an ordinary word ending a sentence the author did not capitalise after
        found.append((match.group(0), "abbreviation"))
    for match in _NUMBER_UNIT.finditer(masked):
        if match.group(1) not in _DECIDED_SUFFIXES and match.group(1).lower() not in ("am", "pm"):
            found.append((match.group(0), "unit"))
    return found
