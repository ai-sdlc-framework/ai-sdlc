/**
 * Tests for the /ai-sdlc dispatch-worker slash command (AISDLC-377.1).
 *
 * The Worker side of RFC-0041's Conductor / Worker split. Operator opens N
 * sibling CC sessions and fires this in each. Each session claims one
 * Dispatch Board manifest, invokes the developer subagent in foreground,
 * writes the verdict, ScheduleWakeup-loops.
 *
 * Body-contract assertions read from `dispatch-worker.md` itself,
 * mirroring the pattern in `orchestrator-tick.test.mjs`.
 *
 * Run with: node --test ai-sdlc-plugin/commands/dispatch-worker.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cmdFile = join(__dirname, 'dispatch-worker.md');

let frontmatter;
let cmdBody;

before(() => {
  const cmdContent = readFileSync(cmdFile, 'utf-8');
  const cmdMatch = cmdContent.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!cmdMatch) throw new Error('No frontmatter in dispatch-worker.md');

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

describe('/ai-sdlc dispatch-worker frontmatter', () => {
  it('declares the command name as dispatch-worker', () => {
    assert.equal(frontmatter.name, 'dispatch-worker');
  });

  it('declares an argument hint', () => {
    assert.ok(frontmatter['argument-hint'], 'argument-hint should be present');
  });

  it('declares allowed-tools list', () => {
    assert.ok(Array.isArray(frontmatter['allowed-tools']), 'allowed-tools must be an array');
  });

  it('grants Agent tool access for the developer subagent', () => {
    const tools = frontmatter['allowed-tools'];
    const agentTool = tools.find((t) => t.startsWith('Agent(') || t === 'Agent');
    assert.ok(agentTool, 'dispatch-worker must grant the Agent tool');
    if (agentTool && agentTool.startsWith('Agent(')) {
      assert.ok(
        agentTool.includes('developer'),
        'Agent grant must include the developer subagent (the Worker invokes only this)',
      );
    }
  });

  it('grants Bash tool (needed to run cli-dispatch)', () => {
    const tools = frontmatter['allowed-tools'];
    assert.ok(tools.includes('Bash'), 'Bash must be in allowed-tools');
  });

  it('grants Read tool', () => {
    const tools = frontmatter['allowed-tools'];
    assert.ok(tools.includes('Read'), 'Read must be in allowed-tools');
  });

  it('uses inherit model', () => {
    assert.equal(frontmatter.model, 'inherit');
  });
});

describe('/ai-sdlc dispatch-worker body — RFC-0041 §4.3.1 protocol', () => {
  it('references the feature flag AI_SDLC_AUTONOMOUS_ORCHESTRATOR', () => {
    assert.ok(
      cmdBody.includes('AI_SDLC_AUTONOMOUS_ORCHESTRATOR'),
      'must check the feature flag before running',
    );
  });

  it('references PIPELINE_CLI_BIN for portable invocation', () => {
    assert.ok(
      cmdBody.includes('PIPELINE_CLI_BIN'),
      'must define PIPELINE_CLI_BIN for AISDLC-245.4 path resolution',
    );
    assert.ok(
      cmdBody.includes('CLAUDE_PLUGIN_DIR'),
      'must reference CLAUDE_PLUGIN_DIR for adopter-install layout',
    );
  });

  it('uses cli-dispatch claim with --worker-kind in-session-agent', () => {
    assert.ok(
      /cli-dispatch\.mjs"\s+claim/.test(cmdBody),
      'must invoke `cli-dispatch claim` to atomically claim manifests',
    );
    assert.ok(
      cmdBody.includes('--worker-kind in-session-agent'),
      'must specify --worker-kind in-session-agent on claim',
    );
  });

  it('writes a heartbeat after claim', () => {
    assert.ok(
      /cli-dispatch\.mjs"\s+heartbeat/.test(cmdBody),
      'must invoke `cli-dispatch heartbeat` to populate inflight state',
    );
  });

  it('writes a verdict via cli-dispatch write-verdict', () => {
    assert.ok(
      /cli-dispatch\.mjs"\s+write-verdict/.test(cmdBody),
      'must invoke `cli-dispatch write-verdict` to land the verdict',
    );
  });

  it('describes the empty-queue hibernate path', () => {
    assert.ok(
      /hibernat|empty/.test(cmdBody.toLowerCase()),
      'must describe the empty-queue hibernate behavior',
    );
  });

  it('describes the quota-exhausted (OQ-7) handling', () => {
    assert.ok(
      cmdBody.includes('quota-exhausted'),
      'must describe the OQ-7 quota-exhausted verdict path',
    );
    assert.ok(
      /Retry-After|retryAfter|retry-after/.test(cmdBody),
      'must reference the Retry-After header for OQ-7 cool-down',
    );
  });

  it('uses ScheduleWakeup for the loop', () => {
    assert.ok(
      cmdBody.includes('ScheduleWakeup'),
      'must reference ScheduleWakeup for loop continuation',
    );
  });

  it('supports --once', () => {
    assert.ok(cmdBody.includes('--once'), 'must support --once for single-tick mode');
  });

  it('cites RFC-0041 as the source of truth', () => {
    assert.ok(cmdBody.includes('RFC-0041'), 'must cite RFC-0041 as the architecture reference');
  });

  it('cites AISDLC-353 (the subscription-only cost model)', () => {
    assert.ok(
      cmdBody.includes('AISDLC-353') || cmdBody.includes('subscription'),
      'must reference the subscription-preserving cost model',
    );
  });
});

describe('/ai-sdlc dispatch-worker body — Phase 1.5 iteration (AISDLC-377.2)', () => {
  it('checks the resume signal BEFORE claiming a fresh manifest (Step 2a)', () => {
    assert.ok(
      /cli-dispatch\.mjs"\s+read-resume-signal/.test(cmdBody),
      'must invoke `cli-dispatch read-resume-signal` to detect a Conductor-written resume signal',
    );
  });

  it('references the AI_SDLC_DISPATCH_RESUME_TASK_ID worker env tracking', () => {
    assert.ok(
      cmdBody.includes('AI_SDLC_DISPATCH_RESUME_TASK_ID'),
      'must track the resume task ID via AI_SDLC_DISPATCH_RESUME_TASK_ID env var',
    );
  });

  it('describes the Agent continue:true semantics for resumption', () => {
    assert.ok(
      /continue:?\s*true/i.test(cmdBody),
      'must describe Agent continue:true semantics for context-preserving resumption',
    );
  });

  it('consumes the resume signal via remove-resume-signal before writing verdict', () => {
    assert.ok(
      /cli-dispatch\.mjs"\s+remove-resume-signal/.test(cmdBody),
      'must invoke `cli-dispatch remove-resume-signal` to consume the signal mid-iteration',
    );
  });

  it('threads --iterations-attempted onto the verdict', () => {
    assert.ok(
      cmdBody.includes('--iterations-attempted'),
      'must pass --iterations-attempted on write-verdict to record the burn count',
    );
  });

  it('describes the iterate-needed outcome path', () => {
    assert.ok(
      cmdBody.includes('iterate-needed'),
      'must describe the iterate-needed outcome for verifier-recoverable failures',
    );
  });

  it('cites RFC-0041 OQ-4 (iteration-as-continuation resolution)', () => {
    assert.ok(
      cmdBody.includes('OQ-4') || cmdBody.includes('Phase 1.5'),
      'must cite OQ-4 (or Phase 1.5) as the source of the iteration contract',
    );
  });
});

describe('/ai-sdlc dispatch-worker body — hard rules', () => {
  it('declares the no-merge rule', () => {
    assert.ok(
      cmdBody.includes('Never merge') || cmdBody.includes('never merge'),
      'must declare the no-merge rule',
    );
  });

  it('declares the no-edit rule for .ai-sdlc and .github/workflows', () => {
    assert.ok(
      cmdBody.includes('.ai-sdlc') && cmdBody.includes('.github/workflows'),
      'must declare the governance no-edit list',
    );
  });
});
