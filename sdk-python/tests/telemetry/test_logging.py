"""Tests for structured logging."""

from ai_sdlc.telemetry.logging import (
    create_buffer_logger,
    create_console_logger,
    create_no_op_logger,
)


def test_no_op_logger() -> None:
    log = create_no_op_logger()
    log.debug("test")
    log.info("test")
    log.warn("test")
    log.error("test")


def test_buffer_logger() -> None:
    log = create_buffer_logger("test")
    log.debug("d")
    log.info("i", {"key": "val"})
    log.warn("w")
    log.error("e", err=ValueError("boom"))

    entries = log.get_entries()
    assert len(entries) == 4
    assert entries[0].level == "debug"
    assert entries[0].logger == "test"
    assert entries[1].attributes == {"key": "val"}
    assert entries[3].error is not None

    log.clear()
    assert len(log.get_entries()) == 0


def test_console_logger(capsys: object) -> None:
    log = create_console_logger("console")
    log.info("hello")
    # Just verify it doesn't crash
