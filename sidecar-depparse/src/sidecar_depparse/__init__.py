"""AI-SDLC dep-parse sidecar — requirement-construction detection for RFC-0008."""

from .detector import Match, detect_matches
from .schemas import MatchRequest, MatchResponse, HealthResponse

__all__ = [
    "Match",
    "detect_matches",
    "MatchRequest",
    "MatchResponse",
    "HealthResponse",
]

__version__ = "0.1.0"
