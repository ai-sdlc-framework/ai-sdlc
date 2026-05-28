/**
 * Tests for the /ai-sdlc resolve-conflicts slash command (AISDLC-460).
 *
 * The command body spawns the ci-conflict-resolver subagent, parses the
 * structured return JSON, and on escalation writes a 24h cool-down +
 * posts a deduplicated PR comment via the ci-failure-watcher runtime
 * module.
 *
 * Run with: node --test ai-sdlc-plugin/commands/resolve-conflicts.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cmdFile = join(__dirname, 'resolve-conflicts.md');

let frontmatter;
let body;

before(() => {
  const content = readFileSync(cmdFile, 'utf-8');
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error('No frontmatter in resolve-conflicts.md');

  frontmatter = {};
  let currentKey = null;
  for (const line of match[1].split('\n')) {
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentKey) {
      if (!Array.isArray(frontmatter[currentKey])) frontmatter[currentKey] = [];
      frontmatter[currentKey].push(listMatch[1].trim());
      continue;
    }
    const kvMatch = line.match(/^([\w-]+):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const value = kvMatch[2].trim();
      if (value) frontmatter[key] = value;
      currentKey = key;
    }
  }
  body = match[2];
});

describe('/ai-sdlc resolve-conflicts frontmatter', () => {
  it('declares the command name', () => {
    assert.equal(frontmatter.name, 'resolve-conflicts');
  });

  it('argument-hint references PR number', () => {
    assert.ok(frontmatter['argument-hint'], 'argument-hint should be present');
    assert.match(frontmatter['argument-hint'], /pr-number/);
  });

  it('inherits model from session', () => {
    assert.equal(frontmatter.model, 'inherit');
  });

  it('declares Agent(ci-conflict-resolver) — single subagent allowlist', () => {
    const tools = frontmatter['allowed-tools'];
    assert.ok(Array.isArray(tools), 'allowed-tools must be a list');
    const agentDecl = tools.find((t) => t.startsWith('Agent('));
    assert.ok(agentDecl, 'must declare Agent(<allowlist>) form');
    assert.match(
      agentDecl,
      /\bci-conflict-resolver\b/,
      'allowlist must include ci-conflict-resolver',
    );
  });

  it('declares Bash + Read for the wrapper logic', () => {
    const tools = frontmatter['allowed-tools'];
    assert.ok(tools.includes('Bash'), 'must grant Bash');
    assert.ok(tools.includes('Read'), 'must grant Read');
  });

  it('description mentions AISDLC-460', () => {
    assert.match(frontmatter.description, /AISDLC-460/);
  });
});

describe('/ai-sdlc resolve-conflicts body', () => {
  it('refuses on main/master', () => {
    assert.match(body, /refusing to operate on protected branch/i);
  });

  it('validates the PR-number argument', () => {
    assert.match(body, /ERROR: pass a PR number/i);
  });

  it('routes cool-down + deduped comment through ci-failure-watcher runtime', () => {
    assert.match(body, /ci-failure-watcher/);
    assert.match(body, /writeCooldown/);
    assert.match(body, /composeEscalationComment/);
    assert.match(body, /postDeduplicatedComment/);
  });

  it('never runs gh pr merge for merge variants', () => {
    assert.doesNotMatch(body, /gh pr merge .* --merge/);
    assert.doesNotMatch(body, /gh pr merge .* --squash/);
    assert.doesNotMatch(body, /gh pr merge .* --rebase/);
  });

  it('declares the hard rules', () => {
    assert.match(body, /Hard rules/i);
    assert.match(body, /Never merge a PR/);
    assert.match(body, /--force-with-lease/);
  });

  it('uses the ci-conflict-resolver classifier from the watcher module', () => {
    assert.match(body, /classifyPrFailureShape/);
    assert.match(body, /normalizePrSnapshot/);
  });
});
