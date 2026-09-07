// Run with: node --test ai-sdlc-plugin/scripts/persist-reviewer-artifacts.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./persist-reviewer-artifacts.sh', import.meta.url));

function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), 'persist-reviewer-artifacts-test-'));
  const claudeProjectsDir = join(root, 'claude-projects');
  const worktree = join(root, 'worktree');
  mkdirSync(claudeProjectsDir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  return { root, claudeProjectsDir, worktree };
}

function writeTranscript(claudeProjectsDir, projectSlug, sessionId, agentId, content, mtime) {
  const dir = join(claudeProjectsDir, projectSlug, sessionId, 'subagents');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `agent-${agentId}.jsonl`);
  writeFileSync(file, content, 'utf8');
  if (mtime) {
    utimesSync(file, mtime, mtime);
  }
  return file;
}

function writeVerdict(root, content) {
  const file = join(root, 'verdict.json');
  writeFileSync(file, JSON.stringify(content), 'utf8');
  return file;
}

function run(args, env) {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.status,
  };
}

describe('persist-reviewer-artifacts.sh', () => {
  it('resolves the harness transcript by agent-id and copies it + the verdict to the worktree', () => {
    const { root, claudeProjectsDir, worktree } = makeHarness();
    try {
      writeTranscript(
        claudeProjectsDir,
        'proj-slug',
        'session-1',
        'agent-123',
        '{"event":"transcript-line"}\n',
      );
      const verdictFile = writeVerdict(root, { approved: true, findings: [], summary: 'ok' });

      const r = run(
        [
          '--worktree',
          worktree,
          '--task-id',
          'AISDLC-599',
          '--reviewer',
          'code-reviewer',
          '--agent-id',
          'agent-123',
          '--verdict-file',
          verdictFile,
        ],
        { AI_SDLC_CLAUDE_PROJECTS_DIR: claudeProjectsDir },
      );

      assert.equal(r.code, 0, r.stderr);

      const transcriptDest = join(
        worktree,
        '.ai-sdlc',
        'transcripts',
        'aisdlc-599',
        'code-reviewer.jsonl',
      );
      const verdictDest = join(worktree, '.ai-sdlc', 'verdicts', 'code-reviewer-aisdlc-599.json');

      assert.equal(existsSync(transcriptDest), true);
      assert.equal(existsSync(verdictDest), true);
      assert.equal(readFileSync(transcriptDest, 'utf8'), '{"event":"transcript-line"}\n');
      assert.deepEqual(JSON.parse(readFileSync(verdictDest, 'utf8')), {
        approved: true,
        findings: [],
        summary: 'ok',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lowercases the task id in the destination paths', () => {
    const { root, claudeProjectsDir, worktree } = makeHarness();
    try {
      writeTranscript(claudeProjectsDir, 'proj-slug', 'session-1', 'agent-abc', 'line\n');
      const verdictFile = writeVerdict(root, { approved: true });

      const r = run(
        [
          '--worktree',
          worktree,
          '--task-id',
          'AISDLC-599',
          '--reviewer',
          'security-reviewer',
          '--agent-id',
          'agent-abc',
          '--verdict-file',
          verdictFile,
        ],
        { AI_SDLC_CLAUDE_PROJECTS_DIR: claudeProjectsDir },
      );

      assert.equal(r.code, 0, r.stderr);
      assert.equal(
        existsSync(
          join(worktree, '.ai-sdlc', 'transcripts', 'aisdlc-599', 'security-reviewer.jsonl'),
        ),
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('newest-mtime wins when the same agent-id appears under multiple project dirs', () => {
    const { root, claudeProjectsDir, worktree } = makeHarness();
    try {
      const older = new Date(Date.now() - 60_000);
      const newer = new Date();
      writeTranscript(
        claudeProjectsDir,
        'proj-old',
        'session-old',
        'agent-dup',
        '{"which":"old"}\n',
        older,
      );
      writeTranscript(
        claudeProjectsDir,
        'proj-new',
        'session-new',
        'agent-dup',
        '{"which":"new"}\n',
        newer,
      );
      const verdictFile = writeVerdict(root, { approved: true });

      const r = run(
        [
          '--worktree',
          worktree,
          '--task-id',
          'AISDLC-599',
          '--reviewer',
          'test-reviewer',
          '--agent-id',
          'agent-dup',
          '--verdict-file',
          verdictFile,
        ],
        { AI_SDLC_CLAUDE_PROJECTS_DIR: claudeProjectsDir },
      );

      assert.equal(r.code, 0, r.stderr);
      const dest = join(worktree, '.ai-sdlc', 'transcripts', 'aisdlc-599', 'test-reviewer.jsonl');
      assert.equal(readFileSync(dest, 'utf8'), '{"which":"new"}\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exits non-zero with an actionable message when no transcript is found for the agent-id', () => {
    const { root, claudeProjectsDir, worktree } = makeHarness();
    try {
      const verdictFile = writeVerdict(root, { approved: true });

      const r = run(
        [
          '--worktree',
          worktree,
          '--task-id',
          'AISDLC-599',
          '--reviewer',
          'code-reviewer',
          '--agent-id',
          'agent-does-not-exist',
          '--verdict-file',
          verdictFile,
        ],
        { AI_SDLC_CLAUDE_PROJECTS_DIR: claudeProjectsDir },
      );

      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /no harness transcript found/i);
      assert.equal(
        existsSync(join(worktree, '.ai-sdlc', 'transcripts', 'aisdlc-599', 'code-reviewer.jsonl')),
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exits non-zero when the verdict file does not exist', () => {
    const { root, claudeProjectsDir, worktree } = makeHarness();
    try {
      writeTranscript(claudeProjectsDir, 'proj-slug', 'session-1', 'agent-1', 'line\n');

      const r = run(
        [
          '--worktree',
          worktree,
          '--task-id',
          'AISDLC-599',
          '--reviewer',
          'code-reviewer',
          '--agent-id',
          'agent-1',
          '--verdict-file',
          join(root, 'nope.json'),
        ],
        { AI_SDLC_CLAUDE_PROJECTS_DIR: claudeProjectsDir },
      );

      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /verdict file not found/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is idempotent — re-running with the same args overwrites cleanly', () => {
    const { root, claudeProjectsDir, worktree } = makeHarness();
    try {
      writeTranscript(claudeProjectsDir, 'proj-slug', 'session-1', 'agent-1', 'first\n');
      const verdictFile = writeVerdict(root, { approved: true, findings: [] });

      const args = [
        '--worktree',
        worktree,
        '--task-id',
        'AISDLC-599',
        '--reviewer',
        'code-reviewer',
        '--agent-id',
        'agent-1',
        '--verdict-file',
        verdictFile,
      ];
      const env = { AI_SDLC_CLAUDE_PROJECTS_DIR: claudeProjectsDir };

      const r1 = run(args, env);
      assert.equal(r1.code, 0, r1.stderr);

      const r2 = run(args, env);
      assert.equal(r2.code, 0, r2.stderr);

      const dest = join(worktree, '.ai-sdlc', 'transcripts', 'aisdlc-599', 'code-reviewer.jsonl');
      assert.equal(readFileSync(dest, 'utf8'), 'first\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exits non-zero with a usage message when a required flag is missing', () => {
    const r = run(['--worktree', '/tmp/whatever']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /usage:/i);
  });
});
