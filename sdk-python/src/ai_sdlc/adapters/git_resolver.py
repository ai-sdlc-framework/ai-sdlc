"""Git-based adapter resolver.

Resolves adapter metadata from git repository references (PRD Section 9.3).
Format: ``github.com/<org>/<repo>@<ref>``
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Protocol

from ai_sdlc.adapters.registry import AdapterMetadata, validate_adapter_metadata
from ai_sdlc.adapters.scanner import parse_metadata_yaml

_GIT_REF_PATTERN = re.compile(r"^([^/]+)/([^/]+)/([^@]+)@(.+)$")


@dataclass(frozen=True)
class GitAdapterReference:
    host: str
    org: str
    repo: str
    ref: str


class GitAdapterFetcher(Protocol):
    """Abstraction for fetching raw file content from a git host."""

    async def fetch(self, url: str) -> str | None: ...


@dataclass(frozen=True)
class GitResolveResult:
    metadata: AdapterMetadata | None
    error: str | None = None


def parse_git_adapter_ref(ref: str) -> GitAdapterReference:
    """Parse a git adapter reference string.

    Expected format: ``github.com/org/repo@v1.0.0``
    """
    match = _GIT_REF_PATTERN.match(ref)
    if not match:
        raise ValueError(
            f'Invalid git adapter reference "{ref}": '
            "expected format <host>/<org>/<repo>@<ref>"
        )
    return GitAdapterReference(
        host=match.group(1),
        org=match.group(2),
        repo=match.group(3),
        ref=match.group(4),
    )


def build_raw_url(parsed: GitAdapterReference) -> str:
    """Build the raw content URL for a metadata.yaml file."""
    if parsed.host == "github.com":
        return (
            f"https://raw.githubusercontent.com/"
            f"{parsed.org}/{parsed.repo}/{parsed.ref}/metadata.yaml"
        )
    raise ValueError(f"Unsupported git host: {parsed.host}")


def create_stub_git_adapter_fetcher(entries: dict[str, str]) -> GitAdapterFetcher:
    """Create a stub fetcher for testing. Maps URLs to YAML content strings."""

    class _StubFetcher:
        async def fetch(self, url: str) -> str | None:
            return entries.get(url)

    return _StubFetcher()


async def resolve_git_adapter(
    ref: str,
    fetcher: GitAdapterFetcher,
) -> GitResolveResult:
    """Resolve adapter metadata from a git reference."""
    try:
        parsed = parse_git_adapter_ref(ref)
    except ValueError as err:
        return GitResolveResult(metadata=None, error=str(err))

    try:
        url = build_raw_url(parsed)
    except ValueError as err:
        return GitResolveResult(metadata=None, error=str(err))

    content = await fetcher.fetch(url)
    if content is None:
        return GitResolveResult(
            metadata=None, error=f"Failed to fetch metadata from {url}"
        )

    try:
        metadata = parse_metadata_yaml(content)
    except Exception as err:
        return GitResolveResult(metadata=None, error=f"Invalid YAML: {err}")

    validation = validate_adapter_metadata(metadata)
    if not validation.valid:
        return GitResolveResult(
            metadata=None,
            error=f"Validation failed: {'; '.join(validation.errors)}",
        )

    return GitResolveResult(metadata=metadata)
