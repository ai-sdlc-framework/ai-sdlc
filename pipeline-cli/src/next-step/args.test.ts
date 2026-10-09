import { describe, expect, it } from 'vitest';
import { ccrRefusalMessage, detectCcr, parseExecuteArg } from './args.js';

describe('parseExecuteArg (AISDLC-393 shapes)', () => {
  it.each([
    ['AISDLC-393', { form: 'backlog-task', taskId: 'AISDLC-393' }],
    ['INGEST-42', { form: 'backlog-task', taskId: 'INGEST-42' }],
    ['AISDLC-100.5', { form: 'backlog-task', taskId: 'AISDLC-100.5' }],
    ['  AISDLC-7  ', { form: 'backlog-task', taskId: 'AISDLC-7' }],
    ['gh:612', { form: 'gh-issue', issueNumber: 612 }],
    ['612', { form: 'gh-issue', issueNumber: 612 }],
    ['#612', { form: 'gh-issue', issueNumber: 612 }],
  ])('classifies %s', (raw, expected) => {
    expect(parseExecuteArg(raw)).toEqual({ ok: true, ...expected });
  });

  it('gives gh: the highest precedence over a task-id-looking string', () => {
    // 'gh:12' can never be a task id (the colon fails the task regex); precedence is explicit.
    expect(parseExecuteArg('gh:12')).toMatchObject({ form: 'gh-issue', issueNumber: 12 });
  });

  it.each(['', '   ', 'abc', 'AISDLC', '12abc', 'gh:', 'gh:abc', '-5', 'AISDLC-', '#'])(
    'rejects %j and lists the accepted forms',
    (raw) => {
      const r = parseExecuteArg(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toContain('Accepted forms');
        expect(r.reason).toContain('gh:<number>');
      }
    },
  );

  it('rejects issue number zero', () => {
    const r = parseExecuteArg('gh:0');
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('must be positive') });
    expect(parseExecuteArg('#00').ok).toBe(false);
  });
});

describe('detectCcr (AISDLC-442)', () => {
  const home = '/home/op';
  const base = { homeDir: home, exists: () => true };

  it('detects CLAUDE_CODE_ENV=ccr first', () => {
    expect(detectCcr({ ...base, env: { CLAUDE_CODE_ENV: 'ccr' } })).toMatch(/CLAUDE_CODE_ENV=ccr/);
  });

  it('detects CLAUDE_REMOTE_EXECUTION=1', () => {
    expect(detectCcr({ ...base, env: { CLAUDE_REMOTE_EXECUTION: '1' } })).toMatch(
      /CLAUDE_REMOTE_EXECUTION=1/,
    );
  });

  it('detects a set CLAUDE_CODE_ENV with the signing key absent', () => {
    const reason = detectCcr({
      homeDir: home,
      env: { CLAUDE_CODE_ENV: 'cli' },
      exists: (p) => p !== `${home}/.ai-sdlc/signing-key.pem`,
    });
    expect(reason).toMatch(/signing-key\.pem absent/);
  });

  it('never refuses on a missing signing key alone (a setup error, not a sandbox)', () => {
    expect(detectCcr({ homeDir: home, env: {}, exists: () => false })).toBeNull();
  });

  it('does not refuse a local session that has a key', () => {
    expect(detectCcr({ ...base, env: { CLAUDE_CODE_ENV: 'cli' } })).toBeNull();
  });

  it('honours AI_SDLC_SKIP_CCR_GUARD=1 before any detection', () => {
    expect(
      detectCcr({ ...base, env: { CLAUDE_CODE_ENV: 'ccr', AI_SDLC_SKIP_CCR_GUARD: '1' } }),
    ).toBeNull();
  });

  it('refusal text names both supported alternatives and the runbook', () => {
    const msg = ccrRefusalMessage('why');
    expect(msg).toContain('mcp__backlog__task_create');
    expect(msg).toContain('mcp__github__create_issue');
    expect(msg).toContain('docs/operations/remote-agents-readonly.md');
  });
});
