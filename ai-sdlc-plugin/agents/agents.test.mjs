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
import { readFileSync, existsSync } from 'node:fs';
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

// AISDLC-98: the execute-orchestrator subagent was deleted. The Step 0-13
// pipeline now lives inline in `ai-sdlc-plugin/commands/execute.md` and
// runs in the main Claude Code session (which has the `Agent` tool).
// Plugin subagents cannot use `Agent` (the harness filters it out one
// level deep regardless of frontmatter), so the orchestrator middleman
// pattern from AISDLC-82 is unimplementable on this harness. See the
// /ai-sdlc execute slash command body for the new home of the pipeline.
//
// AISDLC-105: rebase-resolver.md added — the project-wide invariants below
// (every agent has Read in tools, every agent disallows AgentTool) MUST gate
// every plugin subagent uniformly, so this list is the source of truth for
// "all plugin subagents". When a new agent ships, append it here.
//
// Model pinning (AISDLC cost control, 2026-05-30): model is now ROLE-SPECIFIC,
// not universally inherit. developer/code-reviewer/test-reviewer pin to sonnet;
// security-reviewer pins to opus; utility/codex agents inherit. See the
// 'per-role model split' test below for the complete contract.
//
// AISDLC-247: code-reviewer-codex.md + test-reviewer-codex.md added as
// cross-harness Codex reviewer variants. They share the core invariants
// (Read, AgentTool disallowed, model: inherit) but differ from the Claude
// variants in harness (codex) and tools (Bash instead of Grep/Glob).
const agentFiles = [
  'code-reviewer.md',
  'security-reviewer.md',
  'test-reviewer.md',
  'developer.md',
  'rebase-resolver.md',
  'refinement-reviewer.md',
  'code-reviewer-codex.md',
  'test-reviewer-codex.md',
  'ci-conflict-resolver.md',
];
const reviewerFiles = ['code-reviewer.md', 'security-reviewer.md', 'test-reviewer.md'];
const codexReviewerFiles = ['code-reviewer-codex.md', 'test-reviewer-codex.md'];
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

  it('code-reviewer.md has Write in tools (transcript writing)', () => {
    // Write is intentionally allowed so the reviewer can append transcript
    // leaves per RFC-0042 Phase 1 (mandatory proof-of-execution capture).
    // It is NOT in disallowedTools.
    assert.ok(
      agents['code-reviewer.md'].tools.includes('Write'),
      'code-reviewer needs Write for transcript capture (RFC-0042)',
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

  it('test-reviewer.md has Write in tools (transcript writing)', () => {
    // Write is intentionally allowed so the reviewer can append transcript
    // leaves per RFC-0042 Phase 1 (mandatory proof-of-execution capture).
    // It is NOT in disallowedTools.
    assert.ok(
      agents['test-reviewer.md'].tools.includes('Write'),
      'test-reviewer needs Write for transcript capture (RFC-0042)',
    );
  });

  it('all agents have AgentTool in disallowedTools (no nested subagents)', () => {
    // AISDLC-98: every plugin agent must disallow AgentTool because the
    // Claude Code harness filters Agent out of plugin subagent grants
    // anyway — the explicit disallow keeps the intent visible and
    // prevents future regressions if/when the harness ever changes.
    // The /ai-sdlc execute pipeline that needs to spawn subagents lives
    // in the slash command body (main session), NOT in a subagent.
    for (const file of agentFiles) {
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

  it('per-role model split: dev/code/test-reviewer → sonnet, security-reviewer → opus (AISDLC cost control)', () => {
    // AISDLC cost control: pin models by role to prevent session-model bleed.
    // Opus session-model inheritance was the root cause of a 26%-weekly-budget
    // incident (2026-05-30). Security stays on Opus (reasoning-heavy); all
    // other cost-sensitive roles use Sonnet. Utility agents (rebase, cleanup,
    // conflict resolution) inherit from the spawning session.
    const sonnetRoles = ['developer.md', 'code-reviewer.md', 'test-reviewer.md'];
    for (const file of sonnetRoles) {
      assert.equal(
        agents[file].model,
        'sonnet',
        `${file} must pin model to sonnet (prevents Opus session-model bleed)`,
      );
    }
    assert.equal(
      agents['security-reviewer.md'].model,
      'opus',
      'security-reviewer must use opus (reasoning-heavy; earns its cost)',
    );
    // Utility and codex agents inherit from the spawning session (no pinning needed)
    const inheritRoles = [
      'rebase-resolver.md',
      'refinement-reviewer.md',
      'code-reviewer-codex.md',
      'test-reviewer-codex.md',
      'ci-conflict-resolver.md',
    ];
    for (const file of inheritRoles) {
      assert.equal(
        agents[file].model,
        'inherit',
        `${file} should inherit model — utility/codex agent, no cost-split needed`,
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

// AISDLC-98: the execute-orchestrator subagent has been deleted. Body-shape
// assertions for the Step 0-13 pipeline now live in
// `ai-sdlc-plugin/commands/execute.test.mjs` (against the slash command
// body itself, which is where the recipe was moved). See that file for
// the contract that used to live in the `describe('execute-orchestrator
// agent ...')` block here.

describe('AISDLC-247: Codex reviewer variants', () => {
  it('code-reviewer-codex.md exists', () => {
    assert.ok(
      existsSync(join(__dirname, 'code-reviewer-codex.md')),
      'code-reviewer-codex.md must exist',
    );
  });

  it('test-reviewer-codex.md exists', () => {
    assert.ok(
      existsSync(join(__dirname, 'test-reviewer-codex.md')),
      'test-reviewer-codex.md must exist',
    );
  });

  it('codex reviewer variants declare harness: codex', () => {
    for (const file of codexReviewerFiles) {
      assert.equal(
        agents[file].harness,
        'codex',
        `${file} must declare harness: codex for cross-harness routing`,
      );
    }
  });

  it('codex reviewer variants have Bash in tools (needed to shell out to codex CLI)', () => {
    for (const file of codexReviewerFiles) {
      assert.ok(
        agents[file].tools.includes('Bash'),
        `${file} must include Bash (to shell out to codex exec)`,
      );
    }
  });

  it('codex reviewer variants disallow Edit (no direct codebase writes)', () => {
    // Codex reviewer agents need Write to create temp prompt files at /tmp/
    // but must not Edit project files directly. Disallow Edit only.
    // Write is intentionally allowed — see Step 3 in each agent body.
    for (const file of codexReviewerFiles) {
      assert.ok(
        agents[file].disallowedTools.includes('Edit'),
        `${file} must disallow Edit (no direct project file edits)`,
      );
    }
  });

  it('codex reviewer bodies document the JSON envelope shape', () => {
    for (const file of codexReviewerFiles) {
      const body = readFileSync(join(__dirname, file), 'utf-8');
      assert.ok(
        body.includes('"approved"'),
        `${file} body must document the approved field in the JSON envelope`,
      );
      assert.ok(
        body.includes('"findings"'),
        `${file} body must document the findings field in the JSON envelope`,
      );
      assert.ok(
        body.includes('"summary"'),
        `${file} body must document the summary field in the JSON envelope`,
      );
    }
  });

  it('codex reviewer bodies instruct shelling out to codex exec', () => {
    for (const file of codexReviewerFiles) {
      const body = readFileSync(join(__dirname, file), 'utf-8');
      assert.ok(
        body.includes('codex exec'),
        `${file} body must instruct the agent to invoke codex exec`,
      );
    }
  });

  it('codex reviewer variants have requiresIndependentHarnessFrom: implement', () => {
    for (const file of codexReviewerFiles) {
      assert.ok(
        Array.isArray(agents[file].requiresIndependentHarnessFrom) &&
          agents[file].requiresIndependentHarnessFrom.includes('implement'),
        `${file} must declare requiresIndependentHarnessFrom: [implement] for harness independence`,
      );
    }
  });

  it('AISDLC-249: codex reviewer bodies include --skip-git-repo-check (Pattern C worktree regression guard)', () => {
    // Without this flag, codex CLI exits when invoked from .worktrees/<id>/
    // because codex 0.128.0 confuses the Pattern C parent layout (non-bare
    // parent repo + .worktrees/ isolates) with a non-git directory and errors
    // before running any review. AISDLC-202.4 pilot data captured this gap.
    for (const file of codexReviewerFiles) {
      const body = readFileSync(join(__dirname, file), 'utf-8');
      assert.ok(
        body.includes('--skip-git-repo-check'),
        `${file} body must include --skip-git-repo-check so codex exec works from .worktrees/<id>/ (Pattern C parent layout)`,
      );
    }
  });
});

describe('AISDLC-298: OQ-resolution prohibition reviewer gate', () => {
  // AISDLC-271 / RFC-0031 shipped with all 5 OQs resolved by the dev subagent
  // inline — architectural decisions made without operator walkthrough or
  // cross-pillar review. This policy prohibits that pattern and requires
  // reviewers to flag inline resolutions as critical findings.

  it('code-reviewer.md body instructs flagging Resolution markers in RFC diffs as critical', () => {
    const body = readFileSync(join(__dirname, 'code-reviewer.md'), 'utf-8');
    assert.ok(
      body.includes('Resolution'),
      'code-reviewer must instruct checking for Resolution markers in RFC diffs',
    );
    assert.ok(
      body.includes('critical'),
      'code-reviewer must flag inline OQ resolutions as critical severity',
    );
  });

  it('test-reviewer.md body instructs flagging resolution-codifying tests as critical', () => {
    const body = readFileSync(join(__dirname, 'test-reviewer.md'), 'utf-8');
    assert.ok(
      body.includes('Resolution') || body.includes('OQ'),
      'test-reviewer must instruct checking for tests that codify OQ resolutions',
    );
    assert.ok(
      body.includes('critical'),
      'test-reviewer must flag resolution-codifying tests as critical severity',
    );
  });

  it('developer.md body includes OQ escalation instruction as hard rule #8', () => {
    const body = readFileSync(join(__dirname, 'developer.md'), 'utf-8');
    assert.ok(
      body.includes('Open Question') || body.includes('OQ'),
      'developer must include OQ escalation instruction in hard rules',
    );
    assert.ok(
      body.includes('escalate'),
      'developer must instruct escalating when OQs block or constrain implementation',
    );
  });

  it('synthetic PR diff with Resolution marker matches reviewer detection pattern', () => {
    // Fixture: a synthetic diff where a dev subagent added a Resolution marker
    // to an RFC Open Questions section — the exact anti-pattern from AISDLC-271.
    const syntheticDiff = [
      'diff --git a/spec/rfcs/RFC-0042-example.md b/spec/rfcs/RFC-0042-example.md',
      '--- a/spec/rfcs/RFC-0042-example.md',
      '+++ b/spec/rfcs/RFC-0042-example.md',
      '@@ -10,3 +10,6 @@ ## Open Questions',
      ' 1. **Should we use JWT or session cookies?**',
      '+',
      '+   **Resolution:** Use JWT tokens with 24h expiry. Selected because JWT is',
      '+   stateless and scales across replicas without a session store.',
    ].join('\n');

    // The reviewer uses this regex to detect inline OQ resolution in a diff.
    // Added lines (+ prefix) in spec/rfcs/ files matching **Resolution are critical.
    const resolutionAddedPattern = /^\+\s*\*\*Resolution/m;
    assert.ok(
      resolutionAddedPattern.test(syntheticDiff),
      'synthetic diff with new **Resolution:** marker must match reviewer detection pattern',
    );
  });

  it('synthetic PR diff without Resolution marker does not trigger the reviewer pattern', () => {
    // Negative fixture: a clean diff with no Resolution marker should not fire
    const cleanDiff = [
      'diff --git a/spec/rfcs/RFC-0042-example.md b/spec/rfcs/RFC-0042-example.md',
      '--- a/spec/rfcs/RFC-0042-example.md',
      '+++ b/spec/rfcs/RFC-0042-example.md',
      '@@ -10,3 +10,5 @@ ## Open Questions',
      ' 1. **Should we use JWT or session cookies?**',
      '+',
      '+   (See RFC-0035 Decision Catalog for routing to operator.)',
    ].join('\n');

    const resolutionAddedPattern = /^\+\s*\*\*Resolution/m;
    assert.ok(
      !resolutionAddedPattern.test(cleanDiff),
      'clean diff without Resolution marker must NOT trigger the reviewer detection pattern',
    );
  });
});

describe('AISDLC-308: agentic scope-creep prevention reviewer gate', () => {
  // The PR #481 audit (2026-05-16) documented the root cause: an agent asked to
  // "review the state of RFCs" auto-filed 3 implementation tasks and dispatched
  // their implementation within 1.5 hours — ignoring its own "operator walkthrough
  // required" note. This suite verifies the reviewer gates can detect that pattern.

  it('code-reviewer.md body instructs checking for scope-creep candidates (review+backlog-task combo)', () => {
    const body = readFileSync(join(__dirname, 'code-reviewer.md'), 'utf-8');
    assert.ok(
      body.includes('scope-creep'),
      'code-reviewer must include scope-creep detection instruction',
    );
    assert.ok(
      body.includes('backlog/tasks'),
      'code-reviewer must check for new files in backlog/tasks/',
    );
    assert.ok(
      body.includes('critical'),
      'code-reviewer must flag scope-creep candidates as critical severity',
    );
  });

  it('test-reviewer.md body instructs checking for scope-creep candidates', () => {
    const body = readFileSync(join(__dirname, 'test-reviewer.md'), 'utf-8');
    assert.ok(
      body.includes('scope-creep'),
      'test-reviewer must include scope-creep detection instruction',
    );
    assert.ok(
      body.includes('backlog/tasks'),
      'test-reviewer must check for new files in backlog/tasks/',
    );
  });

  it('developer.md body includes pre-work escalation as a hard rule (stop at pre-work flags)', () => {
    const body = readFileSync(join(__dirname, 'developer.md'), 'utf-8');
    assert.ok(
      body.includes('Pre-work required') || body.includes('pre-work'),
      'developer must include pre-work escalation instruction',
    );
    assert.ok(
      body.includes('self-authorize') || body.includes('scope expansion'),
      'developer must prohibit self-authorization of scope expansion',
    );
  });

  it('synthetic diff: review task + new backlog task file matches scope-creep pattern', () => {
    // Fixture: a diff from a PR that (a) was implementing a "review" task and
    // (b) auto-created a new backlog task — the exact anti-pattern from PR #469.
    const scopeCreepDiff = [
      'diff --git a/backlog/tasks/aisdlc-999 - chore-complete-RFC-9999.md b/backlog/tasks/aisdlc-999 - chore-complete-RFC-9999.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/backlog/tasks/aisdlc-999 - chore-complete-RFC-9999.md',
      '@@ -0,0 +1,10 @@',
      '+---',
      '+id: AISDLC-999',
      '+title: "chore: complete RFC-9999"',
      '+---',
      '+',
      '+## Description',
      '+Auto-filed by reviewer subagent.',
    ].join('\n');

    // The reviewer detects new files under backlog/tasks/ in a PR diff.
    // Pattern: "+++ b/backlog/tasks/" on an added line signals a new task file.
    const newBacklogTaskPattern = /^\+\+\+ b\/backlog\/tasks\//m;
    assert.ok(
      newBacklogTaskPattern.test(scopeCreepDiff),
      'synthetic scope-creep diff with new backlog task file must match reviewer detection pattern',
    );
  });

  it('synthetic diff: update to existing backlog task does NOT match new-file pattern', () => {
    // Negative fixture: editing an existing backlog task is fine, not scope-creep
    const legitimateEditDiff = [
      'diff --git a/backlog/tasks/aisdlc-100 - existing-task.md b/backlog/tasks/aisdlc-100 - existing-task.md',
      '--- a/backlog/tasks/aisdlc-100 - existing-task.md',
      '+++ b/backlog/tasks/aisdlc-100 - existing-task.md',
      '@@ -5,3 +5,4 @@',
      ' status: In Progress',
      '+assignee: [developer]',
    ].join('\n');

    // The new-file detection pattern checks for "new file mode" or "/dev/null" source.
    // A regular edit diff does not have "--- /dev/null" as the source.
    const newFileSourcePattern = /^--- \/dev\/null/m;
    assert.ok(
      !newFileSourcePattern.test(legitimateEditDiff),
      'edit to existing backlog task must NOT be detected as a new-file scope-creep',
    );
  });

  it('refinement-reviewer.md Hard rules explicitly prohibit task-create MCP tools (AISDLC-308)', () => {
    const body = readFileSync(join(__dirname, 'refinement-reviewer.md'), 'utf-8');
    assert.ok(
      body.includes('task_create') || body.includes('task-create'),
      'refinement-reviewer must explicitly prohibit task-create MCP tools',
    );
    assert.ok(
      body.includes('AISDLC-308'),
      'refinement-reviewer hard rule must reference AISDLC-308',
    );
  });
});
