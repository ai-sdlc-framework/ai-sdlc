"""Tests for audit logger."""

from ai_sdlc.audit.logger import create_audit_log
from ai_sdlc.audit.types import AuditFilter


def test_record_and_entries() -> None:
    log = create_audit_log()
    e = log.record(
        actor="agent-1", action="execute",
        resource="pipeline/build", decision="allowed",
    )
    assert e.actor == "agent-1"
    assert e.hash is not None
    assert e.previous_hash is None

    entries = log.entries()
    assert len(entries) == 1


def test_hash_chain() -> None:
    log = create_audit_log()
    e1 = log.record(actor="a", action="x", resource="r", decision="allowed")
    e2 = log.record(actor="b", action="y", resource="r", decision="denied")

    assert e2.previous_hash == e1.hash
    assert e2.hash != e1.hash


def test_integrity_verification() -> None:
    log = create_audit_log()
    log.record(actor="a", action="x", resource="r", decision="allowed")
    log.record(actor="b", action="y", resource="r", decision="denied")
    log.record(actor="c", action="z", resource="r", decision="overridden")

    result = log.verify_integrity()
    assert result.valid


def test_query_filter() -> None:
    log = create_audit_log()
    log.record(actor="agent-1", action="execute", resource="r", decision="allowed")
    log.record(actor="agent-2", action="promote", resource="r", decision="allowed")

    results = log.query(AuditFilter(actor="agent-1"))
    assert len(results) == 1
    assert results[0].actor == "agent-1"

    results = log.query(AuditFilter(decision="denied"))
    assert len(results) == 0


def test_empty_log_integrity() -> None:
    log = create_audit_log()
    assert log.verify_integrity().valid
