"""Tests for in-memory agent memory implementations."""

import time

from ai_sdlc.agents.memory.in_memory import create_agent_memory


def test_working_memory() -> None:
    mem = create_agent_memory()
    mem.working.set("key", "value")
    assert mem.working.get("key") == "value"
    assert mem.working.keys() == ["key"]
    assert mem.working.delete("key")
    assert mem.working.get("key") is None
    mem.working.set("a", 1)
    mem.working.set("b", 2)
    mem.working.clear()
    assert mem.working.keys() == []


def test_short_term_memory() -> None:
    mem = create_agent_memory()
    mem.short_term.set("k", "v", ttl_ms=60000)
    assert mem.short_term.get("k") == "v"
    assert "k" in mem.short_term.keys()
    assert mem.short_term.delete("k")
    assert mem.short_term.get("k") is None


def test_short_term_memory_expiration() -> None:
    mem = create_agent_memory()
    # Set with 1ms TTL — should expire almost immediately
    mem.short_term.set("ephemeral", "gone", ttl_ms=1)
    time.sleep(0.01)
    assert mem.short_term.get("ephemeral") is None


def test_long_term_memory() -> None:
    mem = create_agent_memory()
    mem.long_term.set("pattern", {"type": "retry"}, metadata={"source": "learn"})
    assert mem.long_term.get("pattern") == {"type": "retry"}

    entries = mem.long_term.search("pat")
    assert len(entries) == 1
    assert entries[0].key == "pattern"
    assert entries[0].metadata == {"source": "learn"}

    assert "pattern" in mem.long_term.keys()
    assert mem.long_term.delete("pattern")
    assert mem.long_term.get("pattern") is None


def test_shared_memory() -> None:
    mem = create_agent_memory()
    mem.shared.set("project", "config", {"debug": True})
    assert mem.shared.get("project", "config") == {"debug": True}
    assert mem.shared.keys("project") == ["config"]
    assert mem.shared.delete("project", "config")
    assert mem.shared.get("project", "config") is None


def test_episodic_memory() -> None:
    mem = create_agent_memory()
    entry1 = mem.episodic.append({"key": "build", "value": {"status": "success"}})
    entry2 = mem.episodic.append(
        {"key": "test", "value": {"status": "failed"}, "metadata": {"run": "42"}}
    )
    mem.episodic.append({"key": "build", "value": {"status": "success"}})

    assert entry1.tier == "episodic"
    assert entry2.metadata == {"run": "42"}

    recent = mem.episodic.recent(2)
    assert len(recent) == 2
    assert recent[0].key == "test"
    assert recent[1].key == "build"

    builds = mem.episodic.search("build")
    assert len(builds) == 2


def test_all_tiers_independent() -> None:
    mem = create_agent_memory()
    mem.working.set("key", "working")
    mem.short_term.set("key", "short", ttl_ms=60000)
    mem.long_term.set("key", "long")
    mem.shared.set("ns", "key", "shared")
    mem.episodic.append({"key": "key", "value": "episodic"})

    assert mem.working.get("key") == "working"
    assert mem.short_term.get("key") == "short"
    assert mem.long_term.get("key") == "long"
    assert mem.shared.get("ns", "key") == "shared"
    assert mem.episodic.search("key")[0].value == "episodic"
