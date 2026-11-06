"""Cross-SDK audit chain conformance (conformance/audit-chain)."""

from __future__ import annotations

import json
import os
from dataclasses import replace
from pathlib import Path

import pytest

from ai_sdlc.audit.file_sink import (
    create_file_sink,
    load_entries_from_file,
    verify_file_integrity,
)
from ai_sdlc.audit.logger import canonicalize, compute_entry_hash
from ai_sdlc.audit.types import AuditEntry

ROOT = Path(__file__).resolve().parents[3] / "conformance" / "audit-chain"
FIXTURE = json.loads((ROOT / "fixture.json").read_text())


def _seal() -> list[AuditEntry]:
    out: list[AuditEntry] = []
    for i in FIXTURE["inputs"]:
        prev = out[-1].hash if out else None
        base = AuditEntry(
            id=i["id"],
            timestamp=i["timestamp"],
            actor=i["actor"],
            action=i["action"],
            resource=i["resource"],
            decision=i["decision"],
            policy=i.get("policy"),
            details=i.get("details"),
            previous_hash=prev,
            schema_version=FIXTURE["schemaVersion"],
        )
        out.append(replace(base, hash=compute_entry_hash(base, prev)))
    return out


def test_fixture_hashes_match_and_sample_written(tmp_path: Path) -> None:
    entries = _seal()
    if os.environ.get("AUDIT_CONFORMANCE_WRITE"):
        target = ROOT / "samples" / "python.jsonl"
        target.write_text("")
        sink = create_file_sink(str(target))
        for e in entries:
            sink.write(e)
    assert [e.hash for e in entries] == FIXTURE["expectedHashes"]


@pytest.mark.parametrize("name", ["typescript", "go", "python"])
def test_verifies_every_sdk_sample(name: str) -> None:
    assert verify_file_integrity(str(ROOT / "samples" / f"{name}.jsonl")).valid


def test_one_byte_change_fails(tmp_path: Path) -> None:
    text = (ROOT / "samples" / "typescript.jsonl").read_text()
    p = tmp_path / "t.jsonl"
    p.write_text(text.replace("policy/strict", "policy/strict2"))
    result = verify_file_integrity(str(p))
    assert not result.valid
    assert result.broken_at == 1


def test_downgraded_schema_version_fails(tmp_path: Path) -> None:
    p = tmp_path / "d.jsonl"
    p.write_text(
        "\n".join(
            json.dumps({k: v for k, v in json.loads(line).items() if k != "schemaVersion"})
            for line in (ROOT / "samples" / "go.jsonl").read_text().splitlines()
        )
        + "\n"
    )
    assert not verify_file_integrity(str(p)).valid
    assert len(load_entries_from_file(str(p))) == 3


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (1.0, "1"),
        (-0.0, "0"),
        (2.5, "2.5"),
        (1e21, "1e+21"),
        (1e-7, "1e-7"),
        (123456789012345680000.0, "123456789012345680000"),
        (0.000001, "0.000001"),
        (1.5e-9, "1.5e-9"),
        (True, "true"),
        (None, "null"),
    ],
)
def test_canonical_numbers(value: object, expected: str) -> None:
    assert canonicalize(value) == expected


def test_canonical_strings_and_keys() -> None:
    assert canonicalize({"b": "<&>é", "a": [1, 2]}) == '{"a":[1,2],"b":"<&>é"}'
    assert canonicalize(("x",)) == '["x"]'
    with pytest.raises(TypeError):
        canonicalize(object())
    with pytest.raises(ValueError):
        canonicalize(float("nan"))


def test_legacy_chain_without_schema_version_still_verifies(tmp_path: Path) -> None:
    out: list[AuditEntry] = []
    for i in FIXTURE["inputs"]:
        prev = out[-1].hash if out else None
        base = AuditEntry(
            id=i["id"],
            timestamp=i["timestamp"],
            actor=i["actor"],
            action=i["action"],
            resource=i["resource"],
            decision=i["decision"],
            policy=i.get("policy"),
            details=i.get("details"),
            previous_hash=prev,
        )
        out.append(replace(base, hash=compute_entry_hash(base, prev)))
    p = tmp_path / "legacy.jsonl"
    sink = create_file_sink(str(p))
    for e in out:
        sink.write(e)
    assert verify_file_integrity(str(p)).valid
