"""Requirement-construction detection (RFC-0008 §B.4.2).

Given a parsed spaCy `Doc` and a list of pattern strings (e.g. "requires
developer", "X required", "developer integration required"), returns
matches where the pattern's *concept* appears in the text as part of a
requirement construction (`requires`, `needs`, `must have`, `required`
adjectival, or `for X` prepositional purpose) AND is NOT negated.

The detector is designed to be dependency-aware but conservative: a
requirement construction must be explicit in the parse tree. Literal
substring matches without a supporting construction do NOT match.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, List, Optional, Protocol, Sequence


# ── Protocols to keep spaCy optional at import time ─────────────────


class _Token(Protocol):
    i: int
    text: str
    lemma_: str
    dep_: str
    pos_: str
    head: "_Token"

    def __iter__(self) -> "Sequence[_Token]": ...  # type: ignore[override]


# ── Trigger words ───────────────────────────────────────────────────

REQUIREMENT_VERBS = {"require", "need"}
REQUIREMENT_MODALS = {"must"}
REQUIREMENT_ADJS = {"required", "needed", "mandatory"}

# Words that indicate a pattern's concept tokens (the "what is required")
# should be extracted from the pattern by stripping these.
PATTERN_TRIGGER_TOKENS = {
    "requires",
    "require",
    "required",
    "needs",
    "need",
    "needed",
    "must",
    "have",
    "has",
    "mandatory",
    "is",
    "are",
    "be",
}


@dataclass
class Match:
    pattern: str
    matched_text: str
    dep_path: List[str] = field(default_factory=list)
    construction: str = ""


# ── Pure helpers ────────────────────────────────────────────────────


def _extract_concept(pattern: str) -> List[str]:
    """Strip trigger words, lowercase, and return the remaining tokens."""
    tokens = [t for t in pattern.strip().lower().split() if t]
    return [t for t in tokens if t not in PATTERN_TRIGGER_TOKENS]


def _token_lemma(tok) -> str:  # noqa: ANN001
    """Prefer lemma, fall back to lowercased text. Works with spaCy tokens."""
    lemma = getattr(tok, "lemma_", None)
    if lemma:
        return lemma.lower()
    return getattr(tok, "text", str(tok)).lower()


def _find_concept_spans(doc, concept_tokens: List[str]) -> List[tuple]:
    """Find all (start_i, end_i) spans in `doc` whose lemma sequence matches `concept_tokens`.

    Uses lemma-level match, case-insensitive; span tokens must be
    contiguous.
    """
    if not concept_tokens:
        return []
    n = len(concept_tokens)
    spans: List[tuple] = []
    doc_tokens = list(doc)
    for start in range(len(doc_tokens) - n + 1):
        window = doc_tokens[start : start + n]
        if all(_token_lemma(window[k]) == concept_tokens[k] for k in range(n)):
            spans.append((start, start + n))
    return spans


def _span_root(doc, start: int, end: int):  # noqa: ANN001
    """Return the highest ancestor *inside* the span, i.e. the dep-tree root
    of the contiguous subtree covering [start, end)."""
    doc_tokens = list(doc)
    span = doc_tokens[start:end]
    # A span root is the token whose head is outside the span (or itself).
    for tok in span:
        head = tok.head
        if head.i < start or head.i >= end or head.i == tok.i:
            return tok
    # Fallback — first token.
    return span[0]


def _is_negated(token) -> bool:  # noqa: ANN001
    """Walk from `token` toward root, checking for a `neg` dependent."""
    visited = set()
    cursor = token
    for _ in range(10):  # bounded walk
        if cursor.i in visited:
            break
        visited.add(cursor.i)
        for child in cursor.children:
            if child.dep_ == "neg":
                return True
            # Common negating constructions
            if _token_lemma(child) in {"not", "n't", "never", "no"}:
                return True
        if cursor.head.i == cursor.i:
            break
        cursor = cursor.head
    return False


def _dep_path_up(token, stop_pred: Callable[[object], bool]) -> List[str]:
    """Return labels of dep edges from `token` up to the first ancestor
    where `stop_pred(token)` is true (inclusive)."""
    path: List[str] = []
    cursor = token
    for _ in range(20):
        path.append(cursor.dep_)
        if stop_pred(cursor):
            break
        if cursor.head.i == cursor.i:
            break
        cursor = cursor.head
    return path


def _detect_construction(span_root) -> Optional[tuple]:  # noqa: ANN001
    """Classify the requirement construction governing `span_root`.

    Returns (label, governor_token) or None.
    """
    # Walk up from span_root; look for a requirement verb/adj/modal.
    cursor = span_root
    for _ in range(6):
        head = cursor.head
        # Direct object / nsubj:pass of a requirement verb
        if head is not cursor and _token_lemma(head) in REQUIREMENT_VERBS:
            return (f"{cursor.dep_}({_token_lemma(head)})", head)
        # Prepositional "for ..." (purpose/requirement)
        if head is not cursor and _token_lemma(head) == "for" and head.dep_ == "prep":
            return ("prep(for)", head)
        # "X required" — required is an adjective modifying X
        for child in cursor.children:
            if _token_lemma(child) in REQUIREMENT_ADJS:
                return (f"amod({_token_lemma(child)})", child)
        # Modal "must have X"
        if head is not cursor and _token_lemma(head) == "have":
            # Look for a `must` aux on have
            for aux in head.children:
                if aux.dep_ == "aux" and _token_lemma(aux) in REQUIREMENT_MODALS:
                    return ("aux(must)+have", head)
        if head.i == cursor.i:
            break
        cursor = head
    return None


# ── Public entry point ──────────────────────────────────────────────


def detect_matches(text: str, patterns: Sequence[str], nlp) -> List[Match]:  # noqa: ANN001
    """Run dep-parse detection.

    `nlp` is a spaCy `Language` callable (e.g. from `spacy.load`).
    """
    if not text or not patterns:
        return []

    doc = nlp(text)
    matches: List[Match] = []

    for pattern in patterns:
        concept_tokens = _extract_concept(pattern)
        if not concept_tokens:
            # A pattern consisting only of trigger words — skip.
            continue

        for start, end in _find_concept_spans(doc, concept_tokens):
            span_root = _span_root(doc, start, end)

            construction = _detect_construction(span_root)
            if construction is None:
                continue
            label, governor = construction

            # Negation on governor skips the match.
            if _is_negated(governor):
                continue

            # Build the dep-path from span root up to governor.
            path: List[str] = []
            cursor = span_root
            for _ in range(10):
                path.append(cursor.dep_)
                if cursor.i == governor.i:
                    break
                if cursor.head.i == cursor.i:
                    break
                cursor = cursor.head

            doc_tokens = list(doc)
            matched_text = " ".join(t.text for t in doc_tokens[start:end])

            matches.append(
                Match(
                    pattern=pattern,
                    matched_text=matched_text,
                    dep_path=path,
                    construction=label,
                )
            )

    return matches
