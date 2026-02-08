import { describe, it, expect } from 'vitest';
import { createStubGitLabCI, createStubGitLabSource } from './gitlab.js';
import { createStubJira } from './jira.js';
import { createStubBitbucket } from './bitbucket.js';
import { createStubSonarQube } from './sonarqube.js';
import { createStubSemgrep } from './semgrep.js';

describe('StubGitLabCI', () => {
  it('triggers and tracks builds', async () => {
    const ci = createStubGitLabCI();
    const build = await ci.triggerBuild({ branch: 'main' });
    expect(build.id).toMatch(/^gl-build-/);
    expect(build.status).toBe('succeeded');
    expect(ci.getBuildCount()).toBe(1);

    const status = await ci.getBuildStatus(build.id);
    expect(status.status).toBe('succeeded');
  });

  it('returns test results and coverage', async () => {
    const ci = createStubGitLabCI();
    const build = await ci.triggerBuild({ branch: 'main' });
    const results = await ci.getTestResults(build.id);
    expect(results.passed).toBeGreaterThan(0);

    const coverage = await ci.getCoverageReport(build.id);
    expect(coverage.lineCoverage).toBeGreaterThan(0);
  });

  it('throws on unknown build', async () => {
    const ci = createStubGitLabCI();
    await expect(ci.getBuildStatus('unknown')).rejects.toThrow('not found');
  });
});

describe('StubGitLabSource', () => {
  it('creates branches and merge requests', async () => {
    const src = createStubGitLabSource();
    await src.createBranch({ name: 'feature/test' });
    expect(src.getBranchCount()).toBe(1);

    const mr = await src.createPR({
      title: 'Test MR',
      sourceBranch: 'feature/test',
      targetBranch: 'main',
    });
    expect(mr.id).toMatch(/^gl-mr-/);
    expect(mr.status).toBe('open');
    expect(src.getPRCount()).toBe(1);
  });

  it('merges MR', async () => {
    const src = createStubGitLabSource();
    const mr = await src.createPR({
      title: 'MR',
      sourceBranch: 'a',
      targetBranch: 'b',
    });
    const result = await src.mergePR(mr.id, 'merge');
    expect(result.merged).toBe(true);
  });
});

describe('StubJira', () => {
  it('creates and retrieves issues', async () => {
    const jira = createStubJira();
    const issue = await jira.createIssue({ title: 'Bug fix', labels: ['bug'] });
    expect(issue.id).toMatch(/^JIRA-/);
    expect(issue.status).toBe('open');
    expect(jira.getIssueCount()).toBe(1);

    const retrieved = await jira.getIssue(issue.id);
    expect(retrieved.title).toBe('Bug fix');
  });

  it('updates issue fields', async () => {
    const jira = createStubJira();
    const issue = await jira.createIssue({ title: 'Original' });
    const updated = await jira.updateIssue(issue.id, { title: 'Updated' });
    expect(updated.title).toBe('Updated');
  });

  it('transitions issue status', async () => {
    const jira = createStubJira();
    const issue = await jira.createIssue({ title: 'Task' });
    const transitioned = await jira.transitionIssue(issue.id, 'in-progress');
    expect(transitioned.status).toBe('in-progress');
  });

  it('filters issues by status', async () => {
    const jira = createStubJira();
    await jira.createIssue({ title: 'A' });
    await jira.createIssue({ title: 'B' });
    const second = await jira.getIssue('JIRA-2');
    await jira.transitionIssue(second.id, 'done');

    const open = await jira.listIssues({ status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0].title).toBe('A');
  });

  it('throws on unknown issue', async () => {
    const jira = createStubJira();
    await expect(jira.getIssue('JIRA-999')).rejects.toThrow('not found');
  });
});

describe('StubBitbucket', () => {
  it('creates branches and PRs', async () => {
    const bb = createStubBitbucket();
    await bb.createBranch({ name: 'feature/abc' });
    expect(bb.getBranchCount()).toBe(1);

    const pr = await bb.createPR({
      title: 'PR Title',
      sourceBranch: 'feature/abc',
      targetBranch: 'main',
    });
    expect(pr.id).toMatch(/^bb-pr-/);
    expect(pr.status).toBe('open');
    expect(bb.getPRCount()).toBe(1);
  });

  it('merges PR', async () => {
    const bb = createStubBitbucket();
    const pr = await bb.createPR({
      title: 'PR',
      sourceBranch: 'a',
      targetBranch: 'b',
    });
    const result = await bb.mergePR(pr.id, 'squash');
    expect(result.merged).toBe(true);
    expect(bb.getStoredPR(pr.id)?.status).toBe('merged');
  });

  it('throws on unknown PR merge', async () => {
    const bb = createStubBitbucket();
    await expect(bb.mergePR('unknown', 'merge')).rejects.toThrow('not found');
  });
});

describe('StubSonarQube', () => {
  it('runs scan with no findings', async () => {
    const sq = createStubSonarQube();
    const scan = await sq.runScan({ repository: 'repo' });
    expect(scan.id).toMatch(/^sq-scan-/);
    expect(scan.status).toBe('completed');

    const findings = await sq.getFindings(scan.id);
    expect(findings).toHaveLength(0);
    expect(sq.getScanCount()).toBe(1);
  });

  it('returns preloaded findings', async () => {
    const sq = createStubSonarQube({
      preloadedFindings: [
        { id: 'f1', severity: 'high', message: 'SQL injection', file: 'db.ts', rule: 'sqli' },
      ],
    });
    const scan = await sq.runScan({ repository: 'repo' });
    const findings = await sq.getFindings(scan.id);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('high');
  });

  it('computes severity summary', async () => {
    const sq = createStubSonarQube({
      preloadedFindings: [
        { id: 'f1', severity: 'critical', message: 'm1', file: 'a.ts', rule: 'r1' },
        { id: 'f2', severity: 'high', message: 'm2', file: 'b.ts', rule: 'r2' },
        { id: 'f3', severity: 'high', message: 'm3', file: 'c.ts', rule: 'r3' },
      ],
    });
    const scan = await sq.runScan({ repository: 'repo' });
    const summary = await sq.getSeveritySummary(scan.id);
    expect(summary).toEqual({ critical: 1, high: 2, medium: 0, low: 0 });
  });

  it('reports quality gate status', () => {
    const ok = createStubSonarQube({ qualityGateStatus: 'OK' });
    expect(ok.getQualityGateStatus()).toBe('OK');

    const error = createStubSonarQube({ qualityGateStatus: 'ERROR' });
    expect(error.getQualityGateStatus()).toBe('ERROR');
  });
});

describe('StubSemgrep', () => {
  it('runs scan with no findings', async () => {
    const sg = createStubSemgrep();
    const scan = await sg.runScan({ repository: 'repo' });
    expect(scan.id).toMatch(/^sg-scan-/);
    expect(scan.status).toBe('completed');

    const findings = await sg.getFindings(scan.id);
    expect(findings).toHaveLength(0);
    expect(sg.getScanCount()).toBe(1);
  });

  it('returns preloaded findings', async () => {
    const sg = createStubSemgrep({
      preloadedFindings: [
        { id: 'f1', severity: 'medium', message: 'XSS risk', file: 'app.ts', rule: 'xss' },
      ],
    });
    const scan = await sg.runScan({ repository: 'repo' });
    const findings = await sg.getFindings(scan.id);
    expect(findings).toHaveLength(1);
  });

  it('reports supported rulesets', () => {
    const sg = createStubSemgrep({ supportedRulesets: ['p/typescript', 'p/security-audit'] });
    expect(sg.getSupportedRulesets()).toEqual(['p/typescript', 'p/security-audit']);
  });

  it('filters findings by rulesets', async () => {
    const sg = createStubSemgrep({
      preloadedFindings: [
        { id: 'f1', severity: 'low', message: 'style', file: 'a.ts', rule: 'style' },
      ],
      supportedRulesets: ['p/typescript'],
    });

    // Matching ruleset: findings returned
    const scan1 = await sg.runScan({ repository: 'repo', rulesets: ['p/typescript'] });
    const f1 = await sg.getFindings(scan1.id);
    expect(f1).toHaveLength(1);

    // Non-matching ruleset: no findings
    const scan2 = await sg.runScan({ repository: 'repo', rulesets: ['p/unknown'] });
    const f2 = await sg.getFindings(scan2.id);
    expect(f2).toHaveLength(0);
  });

  it('throws on unknown scan', async () => {
    const sg = createStubSemgrep();
    await expect(sg.getFindings('unknown')).rejects.toThrow('not found');
  });
});
