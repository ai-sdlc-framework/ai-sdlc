"""Parse duration strings in shorthand (60s, 5m, 2h, 1d, 2w) or ISO 8601 format."""

from __future__ import annotations

import re

_SHORTHAND_RE = re.compile(r"^(\d+)([smhdw])$")
_ISO_RE = re.compile(r"^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$")

_SHORTHAND_MULTIPLIERS: dict[str, int] = {
    "s": 1_000,
    "m": 60_000,
    "h": 3_600_000,
    "d": 86_400_000,
    "w": 604_800_000,
}


def parse_duration(value: str) -> int:
    """Parse a duration string and return milliseconds.

    Supports:
      - Shorthand: ``60s``, ``5m``, ``2h``, ``1d``, ``2w``
      - ISO 8601: ``PT1H30M``, ``PT30S``

    Raises:
        ValueError: If the duration string is invalid.
    """
    m = _SHORTHAND_RE.match(value)
    if m:
        return int(m.group(1)) * _SHORTHAND_MULTIPLIERS[m.group(2)]

    m = _ISO_RE.match(value)
    if m:
        hours = int(m.group(1) or 0)
        minutes = int(m.group(2) or 0)
        seconds = int(m.group(3) or 0)
        if hours == 0 and minutes == 0 and seconds == 0:
            raise ValueError(f"Invalid ISO 8601 duration: {value}")
        return (hours * 3600 + minutes * 60 + seconds) * 1000

    raise ValueError(f"Invalid duration: {value}")
