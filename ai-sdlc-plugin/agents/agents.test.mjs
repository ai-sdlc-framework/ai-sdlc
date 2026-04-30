/**
 * Tests for AI-SDLC agent definition files.
 *
 * Parses the YAML frontmatter from each agent .md file and verifies
 * tool restrictions are correctly defined.
 *
 * Run with: node --test ai-sdlc-plugin/agents/agents.test.mjs
 * Uses Node.js built-in test runner (no Vitest needed).
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Parse YAML frontmatter from a markdown file.
 * Extracts the content between --- delimiters and parses simple YAML
 * (scalar fields and list fields).
 */
function parseFrontmatter(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error(`No frontmatter found in ${filePath}`);

  const yaml = match[1];
  const result = {};
  const lines = yaml.split('\n');

  let currentKey = null;

  for (const line of lines) {
    // List item
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentKey) {
      if (!Array.isArray(result[currentKey])) {
        result[currentKey] = [];
      }
      result[currentKey].push(listMatch[1].trim());
      continue;
    }

    // Key-value pair
    const kvMatch = line.match(/^(\w+):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const value = kvMatch[2].trim();
      if (value) {
        result[key] = value;
      }
      currentKey = key;
      continue;
    }
  }

  return result;
}

const agentFiles = [
  'code-reviewer.md',
  'security-reviewer.md',
  'test-reviewer.md',
  'developer.md',
  'execute-orchestrator.md',
];
const reviewerFiles = ['code-reviewer.md', 'security-reviewer.md', 'test-reviewer.md'];
// The orchestrator is the only agent with Agent(<allowlist>) in its tools list
// (the Task tool was renamed to Agent in Claude Code v2.1.63 — AISDLC-90).
// Every other agent declares disallowedTools: [AgentTool] to prevent recursive
// subagent spawning. We exempt the orchestrator from the
// all-agents-disallow-AgentTool assertion below.
const nonOrchestratorAgentFiles = agentFiles.filter((f) => f !== 'execute-orchestrator.md');
const agents = {};

before(() => {
  for (const file of agentFiles) {
    const filePath = join(__dirname, file);
    agents[file] = parseFrontmatter(filePath);
  }
});

describe('agent definition tool restrictions', () => {
  it('code-reviewer.md has Edit in disallowedTools', () => {
    assert.ok(
      agents['code-reviewer.md'].disallowedTools.includes('Edit'),
      'code-reviewer should disallow Edit',
    );
  });

  it('code-reviewer.md has Write in disallowedTools', () => {
    assert.ok(
      agents['code-reviewer.md'].disallowedTools.includes('Write'),
      'code-reviewer should disallow Write',
    );
  });

  it('security-reviewer.md has Bash in disallowedTools', () => {
    assert.ok(
      agents['security-reviewer.md'].disallowedTools.includes('Bash'),
      'security-reviewer should disallow Bash',
    );
  });

  it('test-reviewer.md has Edit in disallowedTools', () => {
    assert.ok(
      agents['test-reviewer.md'].disallowedTools.includes('Edit'),
      'test-reviewer should disallow Edit',
    );
  });

  it('test-reviewer.md has Write in disallowedTools', () => {
    assert.ok(
      agents['test-reviewer.md'].disallowedTools.includes('Write'),
      'test-reviewer should disallow Write',
    );
  });

  it('all non-orchestrator agents have AgentTool in disallowedTools', () => {
    // execute-orchestrator is the deliberate exception — it's the one agent
    // permitted to spawn nested subagents (developer + 3 reviewers). Every
    // other agent must disallow AgentTool to prevent recursive subagent
    // spawning that would break the parallel-runs design (see AISDLC-82).
    for (const file of nonOrchestratorAgentFiles) {
      assert.ok(
        agents[file].disallowedTools.includes('AgentTool'),
        `${file} should disallow AgentTool`,
      );
    }
  });

  it('all agents have Read in tools', () => {
    for (const file of agentFiles) {
      assert.ok(agents[file].tools.includes('Read'), `${file} should have Read in allowed tools`);
    }
  });

  it('all agents have a name field', () => {
    for (const file of agentFiles) {
      assert.ok(agents[file].name, `${file} should have a name`);
    }
  });

  it('all agents have a description field', () => {
    for (const file of agentFiles) {
      assert.ok(agents[file].description, `${file} should have a description`);
    }
  });

  it('all agents inherit the model from the parent session', () => {
    for (const file of agentFiles) {
      assert.equal(
        agents[file].model,
        'inherit',
        `${file} should inherit model — keeps subagent on the orchestrator's tier`,
      );
    }
  });

  it('developer.md has Edit and Write in tools (it implements code)', () => {
    assert.ok(agents['developer.md'].tools.includes('Edit'), 'developer needs Edit');
    assert.ok(agents['developer.md'].tools.includes('Write'), 'developer needs Write');
    assert.ok(agents['developer.md'].tools.includes('Bash'), 'developer needs Bash');
  });

  it('developer.md disallows AgentTool (no recursive subagent spawning)', () => {
    assert.ok(
      agents['developer.md'].disallowedTools.includes('AgentTool'),
      'developer must not spawn nested subagents',
    );
  });

  it('developer.md uses claude-code as its harness', () => {
    assert.equal(
      agents['developer.md'].harness,
      'claude-code',
      'developer is the implementer; reviewer independence is enforced via the reviewer agents',
    );
  });

  it('developer.md body documents the [ai-sdlc-progress] convention', () => {
    const body = readFileSync(join(__dirname, 'developer.md'), 'utf-8');
    assert.ok(
      body.includes('[ai-sdlc-progress]'),
      'developer prompt must instruct emitting progress lines per stage',
    );
  });

  it('developer.md body embeds the hard governance rules (defense-in-depth)', () => {
    const body = readFileSync(join(__dirname, 'developer.md'), 'utf-8');
    // SubagentStart hook also injects these, but embedding them in the agent
    // prompt is belt-and-braces in case the hook ever fails to fire.
    assert.ok(body.includes('Never merge'), 'embed never-merge rule');
    assert.ok(body.includes('Never force-push'), 'embed never-force-push rule');
    assert.ok(body.includes('Never edit `.ai-sdlc/**`'), 'embed blocked-paths rule');
  });
});

describe('execute-orchestrator agent (AISDLC-82)', () => {
  it('declares Agent(<allowlist>) in its tools list (the only agent permitted to spawn subagents)', () => {
    // AISDLC-90: the Task tool was renamed to Agent in Claude Code v2.1.63.
    // The orchestrator uses the modern Agent(<allowlist>) form, which both
    // grants the tool and restricts which subagent types can be spawned —
    // defense-in-depth against recursive orchestrator spawning.
    const tools = agents['execute-orchestrator.md'].tools;
    const agentDecl = tools.find((t) => t.startsWith('Agent('));
    assert.ok(
      agentDecl,
      'execute-orchestrator must declare Agent(<allowlist>) form to spawn developer + 3 reviewer subagents',
    );
    // Allowlist must contain exactly the four spawnable subagents.
    assert.match(agentDecl, /\bdeveloper\b/, 'allowlist must include developer');
    assert.match(agentDecl, /\bcode-reviewer\b/, 'allowlist must include code-reviewer');
    assert.match(agentDecl, /\btest-reviewer\b/, 'allowlist must include test-reviewer');
    assert.match(agentDecl, /\bsecurity-reviewer\b/, 'allowlist must include security-reviewer');
  });

  it('does NOT declare the legacy bare Task tool (renamed to Agent in v2.1.63 — AISDLC-90)', () => {
    // Negative assertion: a bare `Task` entry would silently no-op under the
    // modern allowlist semantics. The legacy spelling must not regress.
    const tools = agents['execute-orchestrator.md'].tools;
    assert.ok(
      !tools.includes('Task'),
      'execute-orchestrator must NOT declare bare `Task` — use Agent(<allowlist>) instead',
    );
  });

  it('does NOT over-declare AskUserQuestion (removed in AISDLC-90)', () => {
    // Negative regression guard for AC #9: the orchestrator body uses the
    // structured-failure-return pattern (outcome: aborted + populate notes)
    // at every "ask the user" site rather than calling AskUserQuestion
    // directly. Re-introducing AskUserQuestion would silently re-enable the
    // mid-pipeline interactive prompt that breaks parallel runs.
    const tools = agents['execute-orchestrator.md'].tools;
    assert.ok(
      !tools.includes('AskUserQuestion'),
      'execute-orchestrator must NOT declare AskUserQuestion — over-declared, removed in AISDLC-90',
    );
  });

  it('does NOT have AgentTool in disallowedTools (it needs to spawn subagents)', () => {
    const disallowed = agents['execute-orchestrator.md'].disallowedTools || [];
    assert.ok(
      !disallowed.includes('AgentTool'),
      'execute-orchestrator must NOT disallow AgentTool — it is the orchestrator',
    );
  });

  it('inherits the model from the spawning session (no fixed model lock-in)', () => {
    assert.equal(
      agents['execute-orchestrator.md'].model,
      'inherit',
      'execute-orchestrator must inherit model so dev/Max-20x tier flows through',
    );
  });

  it('declares the plugin task_edit + task_complete tools with the correct MCP namespace (AISDLC-90)', () => {
    // Plugin-supplied MCP tools use the namespace
    // `mcp__plugin_<plugin-name>_<server-name>__<tool>`. From plugin.json,
    // plugin name is `ai-sdlc` and the server key under mcpServers is also
    // `ai-sdlc`, so the prefix is `mcp__plugin_ai-sdlc_ai-sdlc__`.
    const tools = agents['execute-orchestrator.md'].tools;
    assert.ok(
      tools.includes('mcp__plugin_ai-sdlc_ai-sdlc__task_edit'),
      'execute-orchestrator needs the plugin variant of task_edit (preserves permittedExternalPaths — AISDLC-83) under the correct mcp__plugin_<plugin>_<server>__ namespace',
    );
    assert.ok(
      tools.includes('mcp__plugin_ai-sdlc_ai-sdlc__task_complete'),
      'execute-orchestrator needs the plugin variant of task_complete (preserves permittedExternalPaths — AISDLC-83) under the correct mcp__plugin_<plugin>_<server>__ namespace',
    );
  });

  it('does NOT declare the legacy mcp__ai-sdlc-plugin__* namespace (silently dropped — AISDLC-90)', () => {
    // Negative assertion: the previous (incorrect) namespace would cause the
    // tool entries to silently fail allowlist matching and be dropped from
    // the orchestrator's actual tool grant. Make sure we don't regress.
    const tools = agents['execute-orchestrator.md'].tools;
    for (const tool of tools) {
      assert.ok(
        !tool.startsWith('mcp__ai-sdlc-plugin__'),
        `execute-orchestrator must NOT declare legacy mcp__ai-sdlc-plugin__* namespace; found '${tool}'`,
      );
    }
  });

  it('body contains Step 0 marker (sweep merged worktrees)', () => {
    const body = readFileSync(join(__dirname, 'execute-orchestrator.md'), 'utf-8');
    assert.match(body, /## Step 0/, 'must contain Step 0 marker');
    assert.match(body, /Sweep merged worktrees/i, 'Step 0 must describe the sweep');
  });

  it('body contains Step 13 marker (cleanup sentinel + report)', () => {
    const body = readFileSync(join(__dirname, 'execute-orchestrator.md'), 'utf-8');
    assert.match(body, /## Step 13/, 'must contain Step 13 marker');
    assert.match(body, /Cleanup sentinel/i, 'Step 13 must describe the sentinel cleanup');
  });

  it('body embeds the hard governance rules (defense-in-depth)', () => {
    const body = readFileSync(join(__dirname, 'execute-orchestrator.md'), 'utf-8');
    assert.match(body, /Never merge any PR/i, 'must embed never-merge rule');
    assert.match(body, /Never force-push/i, 'must embed never-force-push rule');
    assert.match(body, /Never edit `\.ai-sdlc\/\*\*`/i, 'must embed never-edit-config rule');
  });

  it('body invokes all three reviewer subagents (code, test, security)', () => {
    const body = readFileSync(join(__dirname, 'execute-orchestrator.md'), 'utf-8');
    assert.match(body, /code-reviewer/, 'must invoke code-reviewer');
    assert.match(body, /test-reviewer/, 'must invoke test-reviewer');
    assert.match(body, /security-reviewer/, 'must invoke security-reviewer');
  });

  it('body documents the per-worktree sentinel hard dependency (AISDLC-81)', () => {
    const body = readFileSync(join(__dirname, 'execute-orchestrator.md'), 'utf-8');
    assert.match(body, /AISDLC-81/, 'must reference the per-worktree sentinel prerequisite');
    assert.match(
      body,
      /\$WORKTREE_PATH\/\.active-task/,
      'must write the per-worktree sentinel (not the project-level one)',
    );
  });

  it('body forbids spawning execute-orchestrator recursively (parallel design rule)', () => {
    const body = readFileSync(join(__dirname, 'execute-orchestrator.md'), 'utf-8');
    assert.match(
      body,
      /Never spawn the `execute-orchestrator` agent recursively/i,
      "orchestrator must not spawn another orchestrator — that is the main session's job",
    );
  });

  it('body uses outcome: aborted at "ask the user" sites (AC #10 — structured-failure pattern)', () => {
    // AISDLC-90 AC #10 reworded the previous "ask the user via
    // AskUserQuestion" wording into the structured-failure-return pattern
    // (outcome: aborted + populate notes for the spawning session to
    // escalate). This assertion guards the body wording against silent
    // regression to the interactive-ask phrasing.
    const body = readFileSync(join(__dirname, 'execute-orchestrator.md'), 'utf-8');
    assert.match(
      body,
      /outcome:\s*aborted/i,
      'orchestrator must signal failures via structured outcome:aborted, not interactive prompts',
    );
  });
});
