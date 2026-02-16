"""Tests for in-memory audit sink."""


from ai_sdlc.audit.logger import create_audit_log
from ai_sdlc.audit.memory_sink import create_in_memory_audit_sink


def test_sink_receives_entries() -> None:
    sink = create_in_memory_audit_sink()
    log = create_audit_log(sink)
    log.record(actor="a", action="x", resource="r", decision="allowed")
    log.record(actor="b", action="y", resource="r", decision="denied")

    assert sink.get_entry_count() == 2
    entries = sink.get_entries()
    assert entries[0].actor == "a"
