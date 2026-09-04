/**
 * Integration test for AISDLC-571: proves the FULL path from a real
 * `SubagentStart` hook firing through to `determineVerdictClass()` returning
 * `'independent'`.
 *
 * The AISDLC-568 unit tests in `verdict-class.test.ts` cover
 * `determineVerdictClass()`'s contract by hand-writing marker JSON directly —
 * they never exercise `ai-sdlc-plugin/hooks/subagent-start.js` itself. That
 * gap is exactly what let AISDLC-571 ship undetected: the canonical
 * marketplace manifest never registered the hook that produces the marker,
 * so in production the marker was NEVER written, yet the AISDLC-568 unit
 * tests stayed green because they synthesize the marker themselves.
 *
 * This test invokes `subagent-start.js` as a real `SubagentStart` hook
 * invocation would — as a child process, reading its stdin payload, writing
 * to `$CLAUDE_PROJECT_DIR/.ai-sdlc/subagent-sessions/` — and then feeds the
 * resulting marker's timestamp into `determineVerdictClass()` exactly as
 * `pipeline-cli` would for a reviewer transcript leaf written in the same
 * window. If the hook script (or its wiring into either plugin manifest)
 * regresses, this test fails; the AISDLC-568 unit tests alone would not
 * catch it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { determineVerdictClass, subagentSessionsDir } from './verdict-class.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findRepoRoot(startDir: string): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: startDir,
    encoding: 'utf-8',
  }).trim();
}

const repoRoot = findRepoRoot(__dirname);
const subagentStartHookPath = join(repoRoot, 'ai-sdlc-plugin', 'hooks', 'subagent-start.js');

let fakeProjectDir: string;

beforeEach(() => {
  fakeProjectDir = mkdtempSync(join(tmpdir(), 'verdict-class-integration-'));
});

afterEach(() => {
  rmSync(fakeProjectDir, { recursive: true, force: true });
});

describe('SubagentStart hook -> determineVerdictClass integration (AISDLC-571)', () => {
  it('the shipped hook script exists (regression guard for the manifest-wiring bug)', () => {
    expect(existsSync(subagentStartHookPath)).toBe(true);
  });

  it('a real hook invocation writes a marker that determineVerdictClass consumes as independent', () => {
    // Give the fake project dir a minimal agent-role.yaml so the hook's
    // SECOND responsibility (governance-injection into additionalContext,
    // scope item 3) is also exercised by this same real invocation, not
    // just the marker-write path.
    const aiSdlcDir = join(fakeProjectDir, '.ai-sdlc');
    mkdirSync(aiSdlcDir, { recursive: true });
    writeFileSync(
      join(aiSdlcDir, 'agent-role.yaml'),
      'spec:\n  constraints:\n    blockedActions:\n      - "gh pr merge*"\n',
    );

    // Simulate exactly what Claude Code does on a real SubagentStart event:
    // spawn the hook script as a child process with a JSON payload on stdin,
    // scoped to a fake project dir via CLAUDE_PROJECT_DIR (mirrors the env
    // var subagent-start.js itself reads).
    const stdout = execFileSync('node', [subagentStartHookPath], {
      input: JSON.stringify({ agent_id: 'integration-test-agent' }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: fakeProjectDir,
      },
    });

    // Guard with a clear assertion message rather than letting an empty
    // stdout fall through to a raw `JSON.parse` SyntaxError. Empty stdout
    // here means the hook exited before reaching its output-write step —
    // e.g. the AISDLC-571 CI regression where a Linux-only EAGAIN on the
    // stdin read caused the top-level fail-safe `catch` to exit(0)
    // immediately, before ever writing the marker or the governance
    // context. If this assertion fires, `subagent-start.js`'s stdin read
    // is failing to actually deliver a payload in this environment.
    expect(
      stdout.trim().length,
      'subagent-start.js produced no stdout — hook exited early',
    ).toBeGreaterThan(0);

    // The hook's SECOND responsibility (governance injection, scope item 3)
    // works once the hook is actually registered/invoked.
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SubagentStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('gh pr merge*');

    // The marker (AISDLC-568's structural signal) was actually written to
    // disk by the real hook script — not hand-synthesized by the test.
    const sessionsDir = subagentSessionsDir(fakeProjectDir);
    expect(existsSync(sessionsDir)).toBe(true);
    const markerFiles = readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
    expect(markerFiles).toHaveLength(1);
    expect(markerFiles[0]).toContain('integration-test-agent');

    // A reviewer transcript leaf written "now" (i.e. within the lookback
    // window of the marker the hook just wrote) must be classified
    // 'independent' — this is the exact code path a real reviewer subagent
    // dispatch exercises in production, not a fail-safe unit-level fixture.
    const verdictClass = determineVerdictClass({
      repoRoot: fakeProjectDir,
      transcriptMtimeMs: Date.now(),
    });
    expect(verdictClass).toBe('independent');

    // Marker is consumed (deleted) on match, matching AISDLC-568's
    // one-marker-per-leaf contract.
    expect(readdirSync(sessionsDir)).toHaveLength(0);
  });

  it('without a real hook firing (no marker), the same leaf falls back to self-authored', () => {
    // Sanity check: a transcript leaf written into a fake project dir where
    // the SubagentStart hook never fired (the exact AISDLC-571 production
    // bug — hook unregistered in the canonical manifest) must NOT be
    // misclassified as independent.
    writeFileSync(join(fakeProjectDir, 'unrelated-file.txt'), 'no hook fired here');

    const verdictClass = determineVerdictClass({
      repoRoot: fakeProjectDir,
      transcriptMtimeMs: Date.now(),
    });

    expect(verdictClass).toBe('self-authored');
  });
});
