"""Tests for all 9 community adapter stubs."""

from __future__ import annotations

import pytest

from ai_sdlc.adapters.interfaces import (
    CreateBranchInput,
    CreateIssueInput,
    CreatePRInput,
    DeployInput,
    Finding,
    IssueFilter,
    NotificationInput,
    ScanInput,
    ThreadInput,
    TriggerBuildInput,
)
from ai_sdlc.adapters.stubs.bitbucket import create_stub_bitbucket
from ai_sdlc.adapters.stubs.code_analysis import (
    StubCodeAnalysisConfig,
    create_stub_code_analysis,
)
from ai_sdlc.adapters.stubs.deployment_target import create_stub_deployment_target
from ai_sdlc.adapters.stubs.gitlab import create_stub_gitlab_ci, create_stub_gitlab_source
from ai_sdlc.adapters.stubs.jira import create_stub_jira
from ai_sdlc.adapters.stubs.messenger import create_stub_messenger
from ai_sdlc.adapters.stubs.semgrep import (
    StubSemgrepConfig,
    create_stub_semgrep,
)
from ai_sdlc.adapters.stubs.sonarqube import (
    StubSonarQubeConfig,
    create_stub_sonarqube,
)

# ── CodeAnalysis ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_stub_code_analysis_empty() -> None:
    ca = create_stub_code_analysis()
    result = await ca.run_scan(ScanInput(repository="test"))
    assert result.status == "completed"
    findings = await ca.get_findings(result.id)
    assert findings == []
    summary = await ca.get_severity_summary(result.id)
    assert summary.critical == 0


@pytest.mark.asyncio
async def test_stub_code_analysis_preloaded() -> None:
    finding = Finding(id="f1", severity="high", message="test", file="a.py", rule="r1")
    ca = create_stub_code_analysis(StubCodeAnalysisConfig(preloaded_findings=[finding]))
    result = await ca.run_scan(ScanInput(repository="test"))
    findings = await ca.get_findings(result.id)
    assert len(findings) == 1
    assert findings[0].severity == "high"
    summary = await ca.get_severity_summary(result.id)
    assert summary.high == 1


# ── Messenger ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_stub_messenger() -> None:
    m = create_stub_messenger()
    await m.send_notification(NotificationInput(channel="gen", message="hello"))
    assert len(m.get_notification_log()) == 1
    t = await m.create_thread(ThreadInput(channel="gen", title="t", message="hi"))
    assert t.id.startswith("thread-")
    await m.post_update(t.id, "update")


# ── DeploymentTarget ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_stub_deployment_target() -> None:
    dt = create_stub_deployment_target()
    dep = await dt.deploy(DeployInput(artifact="app", environment="prod", version="1.0"))
    assert dep.id.startswith("deploy-")
    status = await dt.get_deployment_status(dep.id)
    assert status.status == "succeeded"
    rolled = await dt.rollback(dep.id)
    assert rolled.status == "rolled-back"


# ── GitLab CI ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_stub_gitlab_ci() -> None:
    ci = create_stub_gitlab_ci()
    build = await ci.trigger_build(TriggerBuildInput(branch="main"))
    assert build.id.startswith("gl-build-")
    status = await ci.get_build_status(build.id)
    assert status.status == "succeeded"
    tests = await ci.get_test_results(build.id)
    assert tests.passed == 10
    cov = await ci.get_coverage_report(build.id)
    assert cov.line_coverage == 85.0


# ── GitLab Source ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_stub_gitlab_source() -> None:
    src = create_stub_gitlab_source()
    br = await src.create_branch(CreateBranchInput(name="feat"))
    assert br.name == "feat"
    pr = await src.create_pr(CreatePRInput(
        title="MR", source_branch="feat", target_branch="main",
    ))
    assert pr.id.startswith("gl-mr-")
    merged = await src.merge_pr(pr.id, "squash")
    assert merged.merged


# ── Jira ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_stub_jira() -> None:
    jira = create_stub_jira()
    issue = await jira.create_issue(CreateIssueInput(title="Bug"))
    assert issue.id.startswith("JIRA-")
    got = await jira.get_issue(issue.id)
    assert got.title == "Bug"
    await jira.add_comment(issue.id, "fixing")
    comments = await jira.get_comments(issue.id)
    assert len(comments) == 1
    transitioned = await jira.transition_issue(issue.id, "in-progress")
    assert transitioned.status == "in-progress"
    listed = await jira.list_issues(IssueFilter(status="in-progress"))
    assert len(listed) == 1


# ── Bitbucket ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_stub_bitbucket() -> None:
    bb = create_stub_bitbucket()
    br = await bb.create_branch(CreateBranchInput(name="fix"))
    assert br.name == "fix"
    pr = await bb.create_pr(CreatePRInput(
        title="Fix", source_branch="fix", target_branch="main",
    ))
    assert pr.id.startswith("bb-pr-")
    merged = await bb.merge_pr(pr.id, "merge")
    assert merged.merged


# ── SonarQube ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_stub_sonarqube() -> None:
    finding = Finding(id="f1", severity="critical", message="vuln", file="a.py", rule="r1")
    sq = create_stub_sonarqube(StubSonarQubeConfig(
        preloaded_findings=[finding], quality_gate_status="ERROR",
    ))
    result = await sq.run_scan(ScanInput(repository="test"))
    summary = await sq.get_severity_summary(result.id)
    assert summary.critical == 1
    assert sq.get_quality_gate_status() == "ERROR"


# ── Semgrep ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_stub_semgrep() -> None:
    finding = Finding(id="f1", severity="medium", message="issue", file="b.py", rule="r2")
    sg = create_stub_semgrep(StubSemgrepConfig(
        preloaded_findings=[finding],
        supported_rulesets=["owasp"],
    ))
    result = await sg.run_scan(ScanInput(repository="test", rulesets=["owasp"]))
    findings = await sg.get_findings(result.id)
    assert len(findings) == 1

    # Unsupported ruleset yields no findings
    result2 = await sg.run_scan(ScanInput(repository="test", rulesets=["custom"]))
    findings2 = await sg.get_findings(result2.id)
    assert len(findings2) == 0
    assert sg.get_supported_rulesets() == ["owasp"]
