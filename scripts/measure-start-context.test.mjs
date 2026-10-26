import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  measureStatic,
  measureTranscript,
  countSessionStartRegistrations,
} from './measure-start-context.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Ceiling for the statically measurable executor start context (AISDLC-1067). Raise only
// with a reason. This is only a proxy for the 30k-token target on the full second model call,
// which also includes skill/agent listings and MCP schemas that depend on the operator machine.
const STATIC_CEILING_TOKENS = 7500;

describe('measureTranscript (AISDLC-1067)', () => {
  const write = (lines) => {
    const f = join(mkdtempSync(join(tmpdir(), 'mt-')), 't.jsonl');
    writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return f;
  };

  it('sums input and cache tokens of the second usage block', () => {
    const f = write([
      { message: { usage: { input_tokens: 1, cache_creation_input_tokens: 2 } } },
      { type: 'user' },
      {
        message: {
          usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 },
        },
      },
    ]);
    assert.equal(measureTranscript(f), 60);
  });

  it('falls back to the only usage block and throws when none', () => {
    assert.equal(measureTranscript(write([{ usage: { input_tokens: 5 } }])), 5);
    assert.throws(() => measureTranscript(write([{ type: 'user' }])), /no assistant usage/);
  });
});

describe('executor start context budget (AISDLC-1067)', () => {
  it('stays under the committed ceiling', () => {
    const { total, contributors } = measureStatic();
    assert.ok(
      total <= STATIC_CEILING_TOKENS,
      `start context ${total} > ${STATIC_CEILING_TOKENS}: ${JSON.stringify(contributors)}`,
    );
  });

  it('registers the SessionStart governance hook exactly once', () => {
    assert.equal(countSessionStartRegistrations(root), 1);
    const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
    assert.equal(settings.hooks.SessionStart, undefined);
  });

  it('prints the governance block exactly once per hook run', () => {
    const r = spawnSync('node', [join(root, 'ai-sdlc-plugin/hooks/session-start.js')], {
      input: JSON.stringify({ session_id: 'budget-test', source: 'startup' }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: '' },
      encoding: 'utf8',
    });
    assert.equal(r.stdout.split('AI-SDLC Governance Active').length - 1, 1);
  });
});
