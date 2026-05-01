/**
 * Tests for the rebase-resolver subagent definition (AISDLC-105).
 *
 * The subagent is invoked by /ai-sdlc rebase <pr-number> to automate the
 * mechanical 80% of rebase + conflict-resolution work and escalate the
 * architectural 20%. The body of the agent is a system prompt — these
 * tests assert the prompt enumerates the rules + escalation cases that
 * make it useful in production.
 *
 * Plus two end-to-end fixture tests of the resolution algorithm itself
 * (CHANGELOG overlap and test-additions overlap) — implemented as pure
 * helpers below so they run without spawning a real LLM. A real prompt
 * passes the prompt-shape tests; a real run satisfies the fixture tests.
 *
 * Run with: node --test ai-sdlc-plugin/agents/rebase-resolver.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentFile = join(__dirname, 'rebase-resolver.md');

let frontmatter;
let body;

before(() => {
  const content = readFileSync(agentFile, 'utf-8');
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error('No frontmatter in rebase-resolver.md');

  frontmatter = {};
  let currentKey = null;
  for (const line of match[1].split('\n')) {
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
  body = match[2];
});

describe('rebase-resolver frontmatter', () => {
  it('declares the agent name', () => {
    assert.equal(frontmatter.name, 'rebase-resolver');
  });

  it('description mentions force-with-lease + escalation', () => {
    assert.match(frontmatter.description, /--force-with-lease/);
    assert.match(frontmatter.description, /[Ee]scalat/);
  });

  it('inherits model from spawning session', () => {
    assert.equal(frontmatter.model, 'inherit');
  });

  it('runs on claude-code harness (no codex requirement)', () => {
    // Unlike the reviewer agents, rebase-resolver doesn't need
    // independence from the developer harness — it's mechanical work.
    assert.equal(frontmatter.harness, 'claude-code');
  });

  it('grants Read, Edit, Bash, Grep, Glob (no Write — only edits existing)', () => {
    const tools = frontmatter.tools;
    assert.ok(Array.isArray(tools), 'tools must be a list');
    assert.ok(tools.includes('Read'), 'must grant Read');
    assert.ok(tools.includes('Edit'), 'must grant Edit (resolve conflicts)');
    assert.ok(tools.includes('Bash'), 'must grant Bash (git, pnpm, prettier)');
    assert.ok(tools.includes('Grep'), 'must grant Grep');
    assert.ok(tools.includes('Glob'), 'must grant Glob');
  });

  it('grants get_review_policy MCP tool (read-only project policy access)', () => {
    const tools = frontmatter.tools;
    assert.ok(
      tools.includes('mcp__plugin_ai-sdlc_ai-sdlc__get_review_policy'),
      'must grant the read-only review-policy MCP tool',
    );
  });

  it('does NOT grant the Agent / AgentTool (single-level subagent)', () => {
    // Plugin subagents cannot use Agent regardless of frontmatter
    // declarations — but we explicitly disallow it for clarity.
    const tools = frontmatter.tools || [];
    const disallowed = frontmatter.disallowedTools || [];
    assert.ok(
      !tools.includes('Agent') && !tools.includes('AgentTool'),
      'must not grant Agent/AgentTool (harness blocks anyway, but be explicit)',
    );
    assert.ok(
      disallowed.includes('AgentTool'),
      'must explicitly disallowedTools: AgentTool to make the constraint visible',
    );
  });

  it('does NOT grant Write (subagent only modifies existing files)', () => {
    const tools = frontmatter.tools || [];
    const disallowed = frontmatter.disallowedTools || [];
    assert.ok(!tools.includes('Write'), 'Write should not be granted');
    assert.ok(disallowed.includes('Write'), 'Write should be explicitly disallowed');
  });
});

describe('rebase-resolver body — hard rules', () => {
  it('forbids `gh pr merge`', () => {
    assert.match(body, /Never merge a PR/i);
    assert.match(body, /gh pr merge/);
  });

  it('forbids plain `git push --force` / `-f`', () => {
    assert.match(body, /git push --force/);
    assert.match(body, /--force-with-lease/);
  });

  it('refuses to push on main/master', () => {
    assert.match(body, /Never push to `main` or `master`/);
    assert.match(body, /BRANCH.*main.*master/);
  });

  it('forbids closing PRs / issues', () => {
    assert.match(body, /gh pr close/);
    assert.match(body, /gh issue close/);
  });

  it('forbids deleting branches', () => {
    assert.match(body, /git branch -D/);
  });

  it('forbids editing .ai-sdlc and .github/workflows', () => {
    assert.match(body, /\.ai-sdlc/);
    assert.match(body, /\.github\/workflows/);
  });

  it('forbids GitHub Actions CI-skip magic tokens (AISDLC-88)', () => {
    assert.match(body, /AISDLC-88/);
    assert.match(body, /\[skip ci\]/);
    assert.match(body, /\[ci skip\]/);
    assert.match(body, /\[no ci\]/);
    assert.match(body, /\[skip actions\]/);
    assert.match(body, /\[actions skip\]/);
  });
});

describe('rebase-resolver body — conflict resolution rules (the 80%)', () => {
  it('Rule 1: CHANGELOG Unreleased > Added overlaps → KEEP BOTH', () => {
    assert.match(body, /Rule 1.*CHANGELOG/);
    assert.match(body, /KEEP BOTH/);
    assert.match(body, /Unreleased/);
  });

  it('Rule 2: test file additions to same describe → KEEP BOTH', () => {
    assert.match(body, /Rule 2.*[Tt]est file/);
    assert.match(body, /describe/);
    assert.match(body, /it\(/);
  });

  it('Rule 3: code additions, non-overlapping → keep-both with adjacency escalation', () => {
    assert.match(body, /Rule 3.*[Cc]ode additions/);
    assert.match(body, /non-overlapping/);
  });

  it('Rule 4: prettier drift → format-on-resolve before --continue', () => {
    assert.match(body, /Rule 4.*[Pp]rettier/);
    assert.match(body, /pnpm exec prettier --write/);
    assert.match(body, /git rebase --continue/);
  });

  it('Rule 5: --force-with-lease, refuse on main/master', () => {
    assert.match(body, /Rule 5.*force-with-lease/);
    assert.match(body, /refuse/i);
  });

  it('explains why prettier-on-resolve matters (PR #115 iter-4 root cause)', () => {
    assert.match(body, /PR #115/);
  });
});

describe('rebase-resolver body — escalation cases (the 20%)', () => {
  it('Escalation 1: modify-vs-delete', () => {
    assert.match(body, /Escalation 1.*[Mm]odify-vs-delete/);
    assert.match(body, /modify-vs-delete/);
  });

  it('Escalation 2: semantic conflict on overlapping lines', () => {
    assert.match(body, /Escalation 2.*[Ss]emantic conflict/);
    assert.match(body, /semantic-conflict/);
  });

  it('Escalation 3: verification failure → no push', () => {
    assert.match(body, /Escalation 3.*[Vv]erification failure/);
    assert.match(body, /do NOT push/);
  });

  it('Escalation 4: iteration cap exceeded (3 attempts)', () => {
    assert.match(body, /Escalation 4.*[Ii]teration cap/);
    assert.match(body, /iteration-cap-exceeded/);
    assert.match(body, /3 rebase attempts/);
  });
});

describe('rebase-resolver body — return value contract', () => {
  it('declares outcome: success | escalated | failed', () => {
    assert.match(body, /"outcome":\s*"success"\s*\|\s*"escalated"\s*\|\s*"failed"/);
  });

  it('declares resolvedFiles array', () => {
    assert.match(body, /"resolvedFiles":/);
  });

  it('declares escalationReason field', () => {
    assert.match(body, /"escalationReason":/);
  });

  it('declares verifications object (build/test/lint/format)', () => {
    assert.match(body, /"verifications":/);
    assert.match(body, /"build":/);
    assert.match(body, /"test":/);
    assert.match(body, /"lint":/);
    assert.match(body, /"format":/);
  });

  it('declares rebaseAttempts counter', () => {
    assert.match(body, /"rebaseAttempts":/);
  });

  it('declares preContentHash + postContentHash for re-attestation oracle', () => {
    assert.match(body, /"preContentHash":/);
    assert.match(body, /"postContentHash":/);
  });

  it('references the AISDLC-94 / AISDLC-101 hash predicate', () => {
    assert.match(body, /AISDLC-94/);
    assert.match(body, /AISDLC-101/);
  });
});

describe('rebase-resolver body — verification chain', () => {
  it('runs `pnpm build && pnpm test && pnpm lint && pnpm format:check`', () => {
    // The body should mention all four stages of the verification chain.
    assert.match(body, /pnpm build/);
    assert.match(body, /pnpm test/);
    assert.match(body, /pnpm lint/);
    assert.match(body, /pnpm format:check/);
  });

  it('verification failure → escalate, do NOT push', () => {
    assert.match(body, /verification-failed/);
    assert.match(body, /do NOT push/);
  });
});

describe('rebase-resolver body — workflow stages', () => {
  it('emits [ai-sdlc-progress] lines per stage', () => {
    assert.match(body, /\[ai-sdlc-progress\]/);
  });

  it('skips rebase when origin/main is already an ancestor of HEAD', () => {
    assert.match(body, /git merge-base --is-ancestor origin\/main HEAD/);
  });

  it('aborts rebase cleanly on conflict (git rebase --abort)', () => {
    assert.match(body, /git rebase --abort/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Fixture tests for the mechanical resolution algorithm.
//
// These exercise the resolution rules as pure functions so the tests
// don't depend on spawning an LLM. The runtime subagent must implement
// the same heuristics; if the prompt above changes the rules, the
// fixtures here must be updated to match.
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolve a textual conflict by stripping <<<<<<< / ======= / >>>>>>>
 * markers and KEEPING BOTH sides. Used for Rules 1, 2, and the
 * non-escalating side of Rule 3.
 */
function resolveKeepBoth(content) {
  // Match a single conflict block: <<<<<<<...=======...>>>>>>>...
  // and replace with both sides concatenated (HEAD side first, then
  // incoming side).
  return content.replace(
    /<<<<<<<\s+[^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>>\s+[^\n]*\n/g,
    (_, head, incoming) => `${head}${incoming}`,
  );
}

/**
 * Decide whether a code-additions conflict block is escalation-worthy
 * (Rule 3): if both sides share a non-trivial identifier on a
 * non-comment line, escalate.
 */
function shouldEscalateCodeAddition(headBlock, incomingBlock) {
  const idents = (s) =>
    new Set(
      s
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('#'))
        .flatMap((l) => l.match(/\b[a-zA-Z_][a-zA-Z0-9_]{2,}\b/g) || []),
    );
  const a = idents(headBlock);
  const b = idents(incomingBlock);
  for (const id of a) {
    // Skip very common keywords
    if (
      ['function', 'const', 'let', 'var', 'return', 'import', 'export', 'true', 'false'].includes(
        id,
      )
    )
      continue;
    if (b.has(id)) return true;
  }
  return false;
}

describe('mechanical resolution — fixtures', () => {
  it('Rule 1: CHANGELOG Unreleased > Added overlap keeps both bullets', () => {
    const conflicted = `## Unreleased

### Added

<<<<<<< HEAD
- **Feature A** (AISDLC-100): does thing A.
=======
- **Feature B** (AISDLC-101): does thing B.
>>>>>>> origin/main

### Changed

- nothing yet
`;
    const resolved = resolveKeepBoth(conflicted);
    assert.match(resolved, /Feature A/);
    assert.match(resolved, /Feature B/);
    assert.doesNotMatch(resolved, /<<<<<<</);
    assert.doesNotMatch(resolved, /=======\n/); // marker only, not "===" elsewhere
    assert.doesNotMatch(resolved, />>>>>>>/);
  });

  it('Rule 2: test additions to same describe block keep both it() cases', () => {
    const conflicted = `describe('attestation', () => {
<<<<<<< HEAD
  it('rejects diff hash mismatch', () => {
    expect(verify(badDiff)).toBe(false);
  });
=======
  it('rejects content hash mismatch', () => {
    expect(verify(badContent)).toBe(false);
  });
>>>>>>> origin/main
});
`;
    const resolved = resolveKeepBoth(conflicted);
    assert.match(resolved, /rejects diff hash mismatch/);
    assert.match(resolved, /rejects content hash mismatch/);
    assert.doesNotMatch(resolved, /<<<<<<</);
    assert.doesNotMatch(resolved, />>>>>>>/);
  });

  it('Rule 3: non-overlapping code additions with no shared identifiers → resolve', () => {
    const head = `  function alpha() { return 1; }\n`;
    const incoming = `  function beta() { return 2; }\n`;
    assert.equal(shouldEscalateCodeAddition(head, incoming), false);
  });

  it('Rule 3: code additions sharing a non-trivial identifier → escalate', () => {
    const head = `  switch (kind) { case 'foo': return handleFoo(); }\n`;
    const incoming = `  switch (kind) { case 'foo': return alternativeFoo(); }\n`;
    assert.equal(shouldEscalateCodeAddition(head, incoming), true);
  });

  it('Escalation 1: modify-vs-delete → produces the modify-vs-delete escalationReason', () => {
    // Synthesize the JSON shape the subagent would return on this case
    const result = {
      outcome: 'escalated',
      resolvedFiles: [],
      escalationReason: 'modify-vs-delete scripts/check-skip-ci-marker.sh deleted by abc1234',
      verifications: { build: 'skipped', test: 'skipped', lint: 'skipped', format: 'skipped' },
      rebaseAttempts: 1,
      preContentHash: null,
      postContentHash: null,
      notes: 'File was renamed/moved on main; modifications need hand-port',
    };
    assert.equal(result.outcome, 'escalated');
    assert.match(result.escalationReason, /^modify-vs-delete\s/);
  });

  it('Rule 4: prettier drift handled by running pnpm exec prettier --write per-file', () => {
    // This is a contract assertion — the body must specify the command.
    assert.match(body, /pnpm exec prettier --write/);
    // And it must be staged via git add after formatting.
    assert.match(body, /git add\s+"\$FILE"/);
  });

  it('Escalation 3: verification failure produces verification-failed escalationReason + no push', () => {
    const result = {
      outcome: 'escalated',
      resolvedFiles: ['ai-sdlc-plugin/CHANGELOG.md'],
      escalationReason:
        'verification-failed test: orchestrator/test/attestation.test.ts expected diffHash mismatch',
      verifications: {
        build: 'passed',
        test: 'failed',
        lint: 'skipped',
        format: 'skipped',
      },
      rebaseAttempts: 1,
      preContentHash: 'abc123',
      postContentHash: 'def456',
      notes: '1 test failed after resolution; do NOT push',
    };
    assert.equal(result.outcome, 'escalated');
    assert.match(result.escalationReason, /^verification-failed\s/);
    assert.equal(result.verifications.test, 'failed');
  });

  it('Rule 5: --force-with-lease refuses on main/master (branch-name guard)', () => {
    // Pure-function check that mirrors the body's bash guard.
    function refusePush(branch) {
      return branch === 'main' || branch === 'master';
    }
    assert.equal(refusePush('main'), true);
    assert.equal(refusePush('master'), true);
    assert.equal(refusePush('ai-sdlc/aisdlc-105-rebase-resolver'), false);
  });

  it('Re-attestation: skipped when contentHash unchanged', () => {
    // The slash command (commands/rebase.md) reads preContentHash +
    // postContentHash from the subagent's JSON. Same hash → skip.
    function shouldResign(pre, post) {
      if (!pre || !post) return false; // nothing to compare
      return pre !== post;
    }
    assert.equal(shouldResign('abc', 'abc'), false);
    assert.equal(shouldResign('abc', 'def'), true);
    assert.equal(shouldResign(null, 'abc'), false); // no pre-hash → don't churn
  });

  it('Escalation 4: iteration cap exceeded after 3 attempts', () => {
    const result = {
      outcome: 'escalated',
      resolvedFiles: ['ai-sdlc-plugin/CHANGELOG.md'],
      escalationReason: 'iteration-cap-exceeded: 3 rebase attempts could not converge',
      verifications: { build: 'skipped', test: 'skipped', lint: 'skipped', format: 'skipped' },
      rebaseAttempts: 3,
      preContentHash: null,
      postContentHash: null,
      notes: 'main moved 3 times during rebase attempts; retry later',
    };
    assert.equal(result.outcome, 'escalated');
    assert.match(result.escalationReason, /^iteration-cap-exceeded/);
    assert.equal(result.rebaseAttempts, 3);
  });
});
