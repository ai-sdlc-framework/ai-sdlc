"""Tests for file-backed agent memory."""

import tempfile
from pathlib import Path

from ai_sdlc.agents.memory.file_backend import (
    create_file_episodic_memory,
    create_file_long_term_memory,
)


def test_file_long_term_set_get() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        path = str(Path(tmpdir) / "lt.json")
        mem = create_file_long_term_memory(path)
        mem.set("pattern", {"retry": True}, metadata={"source": "learn"})
        assert mem.get("pattern") == {"retry": True}


def test_file_long_term_persistence() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        path = str(Path(tmpdir) / "lt.json")
        mem1 = create_file_long_term_memory(path)
        mem1.set("key", "value")

        # New instance should load from file
        mem2 = create_file_long_term_memory(path)
        assert mem2.get("key") == "value"


def test_file_long_term_delete() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        path = str(Path(tmpdir) / "lt.json")
        mem = create_file_long_term_memory(path)
        mem.set("key", "value")
        assert mem.delete("key")
        assert mem.get("key") is None
        assert not mem.delete("key")


def test_file_long_term_search() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        path = str(Path(tmpdir) / "lt.json")
        mem = create_file_long_term_memory(path)
        mem.set("pattern/retry", {"count": 3})
        mem.set("pattern/fallback", {"enabled": True})
        mem.set("config/debug", True)
        results = mem.search("pattern/")
        assert len(results) == 2


def test_file_long_term_keys() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        path = str(Path(tmpdir) / "lt.json")
        mem = create_file_long_term_memory(path)
        mem.set("a", 1)
        mem.set("b", 2)
        assert sorted(mem.keys()) == ["a", "b"]


def test_file_episodic_append_and_recent() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        path = str(Path(tmpdir) / "ep.json")
        mem = create_file_episodic_memory(path)
        mem.append({"key": "build", "value": {"status": "ok"}})
        mem.append({"key": "test", "value": {"status": "fail"}})
        mem.append({"key": "deploy", "value": {"status": "ok"}})

        recent = mem.recent(2)
        assert len(recent) == 2
        assert recent[0].key == "test"
        assert recent[1].key == "deploy"


def test_file_episodic_persistence() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        path = str(Path(tmpdir) / "ep.json")
        mem1 = create_file_episodic_memory(path)
        mem1.append({"key": "event", "value": "data"})

        mem2 = create_file_episodic_memory(path)
        entries = mem2.recent(10)
        assert len(entries) == 1
        assert entries[0].key == "event"


def test_file_episodic_search() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        path = str(Path(tmpdir) / "ep.json")
        mem = create_file_episodic_memory(path)
        mem.append({"key": "build", "value": 1})
        mem.append({"key": "test", "value": 2})
        mem.append({"key": "build", "value": 3})

        builds = mem.search("build")
        assert len(builds) == 2
