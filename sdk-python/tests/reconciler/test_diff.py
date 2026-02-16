"""Tests for resource diff utilities."""

from ai_sdlc.core.types import (
    Metadata,
    Pipeline,
    PipelineSpec,
    PipelineStatus,
    Provider,
    Stage,
    Trigger,
)
from ai_sdlc.reconciler.diff import (
    create_resource_cache,
    has_spec_changed,
    resource_fingerprint,
)


def _pipeline(name: str = "test", agent: str = "builder") -> Pipeline:
    return Pipeline(
        metadata=Metadata(name=name),
        spec=PipelineSpec(
            stages=[Stage(name="build", agent=agent)],
            triggers=[Trigger(event="push")],
            providers={"gh": Provider(type="github")},
        ),
    )


def test_fingerprint_deterministic() -> None:
    p = _pipeline()
    fp1 = resource_fingerprint(p)
    fp2 = resource_fingerprint(p)
    assert fp1 == fp2


def test_fingerprint_ignores_status() -> None:
    p1 = _pipeline()
    p2 = _pipeline()
    p2.status = PipelineStatus(phase="Running")
    assert resource_fingerprint(p1) == resource_fingerprint(p2)


def test_fingerprint_detects_spec_change() -> None:
    p1 = _pipeline(agent="builder")
    p2 = _pipeline(agent="tester")
    assert resource_fingerprint(p1) != resource_fingerprint(p2)


def test_has_spec_changed_same() -> None:
    p = _pipeline()
    assert not has_spec_changed(p, p)


def test_has_spec_changed_different() -> None:
    p1 = _pipeline(agent="builder")
    p2 = _pipeline(agent="tester")
    assert has_spec_changed(p1, p2)


def test_cache_first_time_returns_true() -> None:
    cache = create_resource_cache()
    p = _pipeline()
    assert cache.should_reconcile(p)


def test_cache_same_resource_returns_false() -> None:
    cache = create_resource_cache()
    p = _pipeline()
    cache.should_reconcile(p)
    assert not cache.should_reconcile(p)


def test_cache_changed_resource_returns_true() -> None:
    cache = create_resource_cache()
    p1 = _pipeline(agent="builder")
    cache.should_reconcile(p1)
    p2 = _pipeline(agent="tester")
    assert cache.should_reconcile(p2)


def test_cache_clear_and_size() -> None:
    cache = create_resource_cache()
    cache.should_reconcile(_pipeline("a"))
    cache.should_reconcile(_pipeline("b"))
    assert cache.size() == 2
    cache.clear()
    assert cache.size() == 0
