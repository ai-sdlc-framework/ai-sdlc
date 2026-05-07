/**
 * Tests for the /ai-sdlc orchestrator-tick slash command (AISDLC-225).
 *
 * This is the consumer-bridge slash command that reads the dispatch manifest
 * produced by `ClaudeCliInlineSpawner`, invokes the Agent tool, and writes
 * the result back for the orchestrator tick loop.
 *
 * Body-contract assertions read from `orchestrator-tick.md` itself,
 * mirroring the pattern in `execute.test.mjs`.
 *
 * Run with: node --test ai-sdlc-plugin/commands/orchestrator-tick.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cmdFile = join(__dirname, 'orchestrator-tick.md');

let frontmatter;
let cmdBody;

before(() => {
  const cmdContent = readFileSync(cmdFile, 'utf-8');
  const cmdMatch = cmdContent.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!cmdMatch) throw new Error('No frontmatter in orchestrator-tick.md');

  // Parse frontmatter: supports both scalar and list forms
  frontmatter = {};
  let currentKey = null;
  for (const line of cmdMatch[1].split('\n')) {
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentKey) {
      if (!Array.isArray(frontmatter[currentKey])) {
        frontmatter[currentKey] = [];
      }
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
  cmdBody = cmdMatch[2];
});

describe('/ai-sdlc orchestrator-tick frontmatter', () => {
  it('declares the command name as orchestrator-tick', () => {
    assert.equal(frontmatter.name, 'orchestrator-tick');
  });

  it('declares an argument hint', () => {
    assert.ok(frontmatter['argument-hint'], 'argument-hint should be present');
  });

  it('declares allowed-tools list', () => {
    assert.ok(Array.isArray(frontmatter['allowed-tools']), 'allowed-tools must be an array');
  });

  it('grants Agent tool access (the core reason this lives in a slash command)', () => {
    const tools = frontmatter['allowed-tools'];
    assert.ok(Array.isArray(tools), 'allowed-tools must be an array');
    const hasAgent = tools.some((t) => t === 'Agent' || t.startsWith('Agent('));
    assert.ok(
      hasAgent,
      'orchestrator-tick must grant the Agent tool so it can dispatch subagents inline. Got: ' +
        JSON.stringify(tools),
    );
  });

  it('grants Agent access to developer subagent type', () => {
    const tools = frontmatter['allowed-tools'];
    const agentTool = tools.find((t) => t.startsWith('Agent('));
    if (agentTool) {
      assert.ok(
        agentTool.includes('developer'),
        'Agent tool grant must include developer subagent type',
      );
    }
  });

  it('grants Bash tool (needed to run cli-orchestrator and read files)', () => {
    const tools = frontmatter['allowed-tools'];
    assert.ok(Array.isArray(tools) && tools.includes('Bash'), 'Bash must be in allowed-tools');
  });

  it('grants Read tool (needed to read dispatch manifest)', () => {
    const tools = frontmatter['allowed-tools'];
    assert.ok(Array.isArray(tools) && tools.includes('Read'), 'Read must be in allowed-tools');
  });

  it('uses inherit model (same session model as main Claude Code session)', () => {
    assert.equal(frontmatter.model, 'inherit');
  });
});

describe('/ai-sdlc orchestrator-tick body — consumer bridge protocol', () => {
  it('references the feature flag AI_SDLC_AUTONOMOUS_ORCHESTRATOR', () => {
    assert.ok(
      cmdBody.includes('AI_SDLC_AUTONOMOUS_ORCHESTRATOR'),
      'must check the feature flag before running',
    );
  });

  it('uses direct-node invocation for cli-orchestrator (CLAUDE.md AISDLC-156 rule)', () => {
    assert.ok(
      cmdBody.includes('node pipeline-cli/bin/cli-orchestrator.mjs'),
      'must invoke cli-orchestrator via node pipeline-cli/bin/cli-orchestrator.mjs',
    );
    assert.ok(
      !cmdBody.includes('pnpm --filter @ai-sdlc/pipeline-cli exec cli-orchestrator'),
      'must NOT invoke cli-orchestrator via pnpm exec (AISDLC-156)',
    );
  });

  it('references the dispatch manifest path', () => {
    assert.ok(
      cmdBody.includes('dispatch-manifest.json'),
      'must reference dispatch-manifest.json to read the manifest',
    );
  });

  it('references the dispatch result path', () => {
    assert.ok(
      cmdBody.includes('dispatch-result.json'),
      'must reference dispatch-result.json to write the Agent result',
    );
  });

  it('references manifest-emitted status detection', () => {
    assert.ok(
      cmdBody.includes('manifest-emitted'),
      'must detect manifest-emitted status from the tick output',
    );
  });

  it('references ScheduleWakeup or loop control', () => {
    const hasScheduleWakeup = cmdBody.includes('ScheduleWakeup');
    const hasLoop = cmdBody.includes('/loop');
    assert.ok(
      hasScheduleWakeup || hasLoop,
      'must reference ScheduleWakeup or /loop for loop control',
    );
  });

  it('references the --once flag for single-tick mode', () => {
    assert.ok(
      cmdBody.includes('--once'),
      'must support --once flag so operator can run a single tick without looping',
    );
  });

  it('references the orchestrator-inline-loop documentation', () => {
    assert.ok(
      cmdBody.includes('orchestrator-inline-loop'),
      'must reference docs/operations/orchestrator-inline-loop.md',
    );
  });

  it('references ARTIFACTS_DIR for resolving manifest and result paths', () => {
    assert.ok(
      cmdBody.includes('ARTIFACTS_DIR'),
      'must use ARTIFACTS_DIR to resolve paths (consistent with ClaudeCliInlineSpawner)',
    );
  });
});

describe('/ai-sdlc orchestrator-tick body — hard rules', () => {
  it('declares the no-merge rule', () => {
    assert.ok(
      cmdBody.includes('Never merge') || cmdBody.includes('never merge'),
      'must declare the no-merge rule',
    );
  });

  it('declares the no-force-push rule', () => {
    assert.ok(
      cmdBody.includes('Never force-push') || cmdBody.includes('no.*force-push'),
      'must declare the no-force-push rule',
    );
  });
});

describe('/ai-sdlc orchestrator-tick body — dispatch result protocol', () => {
  it('describes the dispatch-result.json shape', () => {
    assert.ok(
      cmdBody.includes('"version"') ||
        cmdBody.includes('version:') ||
        cmdBody.includes('writtenAt'),
      'must describe the dispatch-result.json shape',
    );
  });

  it('describes the Agent invocation step', () => {
    assert.ok(
      cmdBody.includes('Agent tool'),
      'must describe invoking the Agent tool with manifest parameters',
    );
  });

  it('mentions the subagent type mapping from manifest', () => {
    assert.ok(
      cmdBody.includes('subagentType') || cmdBody.includes('SUBAGENT_TYPE'),
      'must reference subagentType from the manifest',
    );
  });
});
