/**
 * Tests for the /ai-sdlc orchestrator-tick slash command.
 *
 * Original purpose (AISDLC-225): guard the legacy claude-cli inline-manifest
 * consumer-bridge contract. Replaced by RFC-0041 Phase 1 (AISDLC-377.1):
 * the Conductor now emits Dispatch Board manifests + polls done/+failed/
 * verdicts in foreground; Worker sessions running /ai-sdlc dispatch-worker
 * own the actual `Agent` dispatch. The legacy `claude-cli` inline-manifest
 * path was removed in RFC-0041 Phase 3.3 (AISDLC-377.6).
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

  it('grants Agent tool access for reviewer fan-out', () => {
    const tools = frontmatter['allowed-tools'];
    assert.ok(Array.isArray(tools), 'allowed-tools must be an array');
    const hasAgent = tools.some((t) => t === 'Agent' || t.startsWith('Agent('));
    assert.ok(
      hasAgent,
      'orchestrator-tick must grant the Agent tool so it can fan out reviewer subagents. Got: ' +
        JSON.stringify(tools),
    );
  });

  it('grants Agent access to the 3 reviewer subagent types (RFC-0041 Phase 1)', () => {
    const tools = frontmatter['allowed-tools'];
    const agentTool = tools.find((t) => t.startsWith('Agent('));
    if (agentTool) {
      // Conductor only fans out reviewers; the developer subagent is invoked
      // by Workers in their own CC sessions (not in this slash command).
      assert.ok(
        agentTool.includes('code-reviewer'),
        'Agent tool grant must include code-reviewer subagent type',
      );
      assert.ok(
        agentTool.includes('test-reviewer'),
        'Agent tool grant must include test-reviewer subagent type',
      );
      assert.ok(
        agentTool.includes('security-reviewer'),
        'Agent tool grant must include security-reviewer subagent type',
      );
    }
  });

  it('grants Bash tool (needed to run cli-dispatch + cli-deps)', () => {
    const tools = frontmatter['allowed-tools'];
    assert.ok(Array.isArray(tools) && tools.includes('Bash'), 'Bash must be in allowed-tools');
  });

  it('grants Read tool', () => {
    const tools = frontmatter['allowed-tools'];
    assert.ok(Array.isArray(tools) && tools.includes('Read'), 'Read must be in allowed-tools');
  });

  it('uses inherit model (same session model as main Claude Code session)', () => {
    assert.equal(frontmatter.model, 'inherit');
  });
});

describe('/ai-sdlc orchestrator-tick body — RFC-0041 Phase 1 Dispatch Board protocol', () => {
  it('references the feature flag AI_SDLC_AUTONOMOUS_ORCHESTRATOR', () => {
    assert.ok(
      cmdBody.includes('AI_SDLC_AUTONOMOUS_ORCHESTRATOR'),
      'must check the feature flag before running',
    );
  });

  it('uses direct-node invocation for cli-dispatch via $PIPELINE_CLI_BIN', () => {
    assert.ok(
      cmdBody.includes('cli-dispatch.mjs'),
      'must reference cli-dispatch.mjs binary for Dispatch Board operations',
    );
    assert.ok(
      cmdBody.includes('PIPELINE_CLI_BIN'),
      'must use $PIPELINE_CLI_BIN variable for portable invocation (AISDLC-245.4)',
    );
    assert.ok(
      !cmdBody.includes('pnpm --filter @ai-sdlc/pipeline-cli exec cli-dispatch'),
      'must NOT invoke cli-dispatch via pnpm exec (AISDLC-156)',
    );
  });

  it('references the Dispatch Board subdirectories', () => {
    assert.ok(
      cmdBody.match(/queue\/|inflight\/|done\/|failed\//),
      'must reference at least one Dispatch Board subdir name (queue/inflight/done/failed)',
    );
  });

  it('describes verdict pickup from done/', () => {
    assert.ok(
      /collect-verdicts|done\//.test(cmdBody),
      'must describe polling done/ verdicts via collect-verdicts',
    );
  });

  it('describes manifest emission via write-manifest', () => {
    assert.ok(
      cmdBody.includes('write-manifest'),
      'must describe emitting manifests via write-manifest subcommand',
    );
  });

  it('references the stale-heartbeat sweep', () => {
    assert.ok(
      cmdBody.includes('sweep'),
      'must reference the sweep subcommand for stale-heartbeat reclamation',
    );
  });

  it('references the dispatch-worker companion slash command', () => {
    assert.ok(
      cmdBody.includes('dispatch-worker'),
      'must point operators at /ai-sdlc dispatch-worker for Worker sessions',
    );
  });

  it('references ScheduleWakeup for loop control', () => {
    assert.ok(
      cmdBody.includes('ScheduleWakeup'),
      'must reference ScheduleWakeup for autonomous loop continuation',
    );
  });

  it('references the --once flag for single-tick mode', () => {
    assert.ok(
      cmdBody.includes('--once'),
      'must support --once flag so operator can run a single tick without looping',
    );
  });

  it('references RFC-0041 as the source of truth', () => {
    assert.ok(cmdBody.includes('RFC-0041'), 'must cite RFC-0041 as the architecture reference');
  });
});

describe('/ai-sdlc orchestrator-tick body — Phase 1.5 iteration (AISDLC-377.2)', () => {
  it('handles iterate-needed verdicts via probe-iteration-budget', () => {
    assert.ok(
      /probe-iteration-budget/.test(cmdBody),
      'must invoke `cli-dispatch probe-iteration-budget` for iterate-needed decisions',
    );
  });

  it('writes a resume signal when budget is not exhausted', () => {
    assert.ok(
      /write-resume-signal/.test(cmdBody),
      'must invoke `cli-dispatch write-resume-signal` to trigger Worker iteration',
    );
  });

  it('MINOR (iteration-2 review): write-resume-signal invocation includes --task-id and --feedback', () => {
    // Tighter contract than the keyword-grep check above: the bash
    // invocation must pass the two required flags on the same invocation
    // (writeResumeSignal's TS surface requires both — a regression that
    // drops --feedback would silently emit a useless signal).
    const idx = cmdBody.indexOf('write-resume-signal');
    assert.ok(idx >= 0);
    // 400-char window after the invocation is enough to span the line-
    // continued bash command.
    const window = cmdBody.slice(idx, idx + 400);
    assert.ok(
      /--task-id\s+"\$TASK_ID"/.test(window),
      'write-resume-signal must pass --task-id "$TASK_ID"',
    );
    assert.ok(
      /--feedback\s+"\$FEEDBACK_TEXT"/.test(window),
      'write-resume-signal must pass --feedback "$FEEDBACK_TEXT" (the Worker would otherwise resume with no context)',
    );
  });

  it('escalates with iteration-exhausted when budget is exhausted', () => {
    assert.ok(
      /write-iteration-exhausted/.test(cmdBody),
      'must invoke `cli-dispatch write-iteration-exhausted` at budget cap',
    );
  });

  it('describes the iterate-needed → resume-or-escalate decision', () => {
    assert.ok(cmdBody.includes('iterate-needed'), 'must describe the iterate-needed outcome path');
    assert.ok(
      cmdBody.includes('iteration-exhausted') || cmdBody.includes('iteration budget'),
      'must describe budget exhaustion handling',
    );
  });

  it('MAJOR #2 (iteration-2 review): assigns ATTEMPTS and BUDGET from PROBE_JSON BEFORE invoking write-iteration-exhausted', () => {
    // Earlier revisions referenced $ATTEMPTS / $BUDGET as positional args
    // on the write-iteration-exhausted invocation without ever assigning
    // them from PROBE_JSON — that emitted empty numeric args, causing the
    // escalated diagnostic to carry NaN/invalid values. We assert against
    // the actual `node ... cli-dispatch.mjs write-iteration-exhausted`
    // INVOCATION line (not any incidental mention of the subcommand in
    // prose/comments above it).
    const invocationRe =
      /node\s+"\$PIPELINE_CLI_BIN\/cli-dispatch\.mjs"\s+write-iteration-exhausted/;
    const invocationMatch = invocationRe.exec(cmdBody);
    assert.ok(
      invocationMatch,
      'orchestrator-tick.md must invoke `node "$PIPELINE_CLI_BIN/cli-dispatch.mjs" write-iteration-exhausted`',
    );
    const invocationIdx = invocationMatch.index;
    // The two assignments must use a node -e (or jq) extraction off PROBE_JSON
    // and assign to ATTEMPTS / BUDGET respectively. Crucially, both
    // assignments must precede the invocation so the variables are bound
    // when the invocation reads them.
    const attemptsAssignRe = /ATTEMPTS=\$\(/;
    const budgetAssignRe = /BUDGET=\$\(/;
    const attemptsMatch = attemptsAssignRe.exec(cmdBody);
    const budgetMatch = budgetAssignRe.exec(cmdBody);
    assert.ok(
      attemptsMatch,
      'orchestrator-tick.md must assign ATTEMPTS from the probe-iteration-budget output',
    );
    assert.ok(
      budgetMatch,
      'orchestrator-tick.md must assign BUDGET from the probe-iteration-budget output',
    );
    assert.ok(
      attemptsMatch.index < invocationIdx,
      `ATTEMPTS= must be assigned BEFORE the write-iteration-exhausted invocation (assignment at ${attemptsMatch.index}, invocation at ${invocationIdx})`,
    );
    assert.ok(
      budgetMatch.index < invocationIdx,
      `BUDGET= must be assigned BEFORE the write-iteration-exhausted invocation (assignment at ${budgetMatch.index}, invocation at ${invocationIdx})`,
    );
    // And the invocation MUST reference both vars on the same line as
    // --iterations-attempted / --iteration-budget. We extract a 400-char
    // window around the invocation and grep for the flag/var pairs.
    const window = cmdBody.slice(invocationIdx, invocationIdx + 400);
    assert.ok(
      /--iterations-attempted\s+"\$ATTEMPTS"/.test(window),
      'write-iteration-exhausted invocation must pass --iterations-attempted "$ATTEMPTS"',
    );
    assert.ok(
      /--iteration-budget\s+"\$BUDGET"/.test(window),
      'write-iteration-exhausted invocation must pass --iteration-budget "$BUDGET"',
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

  it('declares the no-force-push (or force-with-lease) rule', () => {
    assert.ok(
      cmdBody.includes('Never force-push') ||
        cmdBody.includes('no.*force-push') ||
        cmdBody.includes('--force-with-lease'),
      'must declare force-push policy (Never force-push, or only --force-with-lease)',
    );
  });

  it('forbids editing .ai-sdlc/** and .github/workflows/**', () => {
    assert.ok(
      cmdBody.includes('.ai-sdlc') && cmdBody.includes('.github/workflows'),
      'must declare the governance no-edit list',
    );
  });
});

describe('/ai-sdlc orchestrator-tick body — AISDLC-245.4 path resolution', () => {
  it('establishes PIPELINE_CLI_BIN with CLAUDE_PLUGIN_DIR resolution', () => {
    assert.ok(
      cmdBody.includes('PIPELINE_CLI_BIN'),
      'must define PIPELINE_CLI_BIN for portable CLI invocation',
    );
    assert.ok(
      cmdBody.includes('CLAUDE_PLUGIN_DIR'),
      'must reference CLAUDE_PLUGIN_DIR for adopter-install layout',
    );
  });

  it('includes dogfood fallback when CLAUDE_PLUGIN_DIR is unset', () => {
    assert.ok(
      cmdBody.includes('pipeline-cli/bin'),
      'must include fallback path to dogfood monorepo pipeline-cli/bin',
    );
  });
});
