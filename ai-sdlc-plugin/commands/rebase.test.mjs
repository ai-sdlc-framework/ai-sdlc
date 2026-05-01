/**
 * Tests for the /ai-sdlc rebase slash command (AISDLC-105).
 *
 * The command body spawns the rebase-resolver subagent, parses the
 * structured return JSON, and handles re-attestation only when
 * contentHash changed (using sign-attestation.mjs --print-content-hash
 * as the AISDLC-94/101 oracle).
 *
 * Run with: node --test ai-sdlc-plugin/commands/rebase.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cmdFile = join(__dirname, 'rebase.md');

let frontmatter;
let body;

before(() => {
  const content = readFileSync(cmdFile, 'utf-8');
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error('No frontmatter in rebase.md');

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

describe('/ai-sdlc rebase frontmatter', () => {
  it('declares the command name', () => {
    assert.equal(frontmatter.name, 'rebase');
  });

  it('argument-hint references PR number', () => {
    assert.ok(frontmatter['argument-hint'], 'argument-hint should be present');
    assert.match(frontmatter['argument-hint'], /pr-number/);
  });

  it('inherits model from session', () => {
    assert.equal(frontmatter.model, 'inherit');
  });

  it('declares Agent(rebase-resolver) — single subagent allowlist', () => {
    const tools = frontmatter['allowed-tools'];
    assert.ok(Array.isArray(tools), 'allowed-tools must be a list');
    const agentDecl = tools.find((t) => t.startsWith('Agent('));
    assert.ok(agentDecl, 'must declare Agent(<allowlist>) form');
    assert.match(agentDecl, /\brebase-resolver\b/, 'allowlist must include rebase-resolver');
  });

  it('declares Bash + Read for the wrapper logic', () => {
    const tools = frontmatter['allowed-tools'];
    assert.ok(tools.includes('Bash'), 'must grant Bash');
    assert.ok(tools.includes('Read'), 'must grant Read');
  });

  it('does NOT declare unused mcp__backlog__task_view tool (AISDLC-105 reviewer round 2)', () => {
    // The frontmatter previously declared this tool but the body never
    // exercised it — declared-but-unused tools are noise. Remove until
    // a concrete need lands.
    const tools = frontmatter['allowed-tools'];
    assert.ok(
      !tools.includes('mcp__backlog__task_view'),
      'must not declare unused mcp__backlog__task_view',
    );
  });

  it('does NOT declare the legacy bare Task tool', () => {
    const tools = frontmatter['allowed-tools'];
    const flat = Array.isArray(tools) ? tools.join(' ') : tools;
    assert.doesNotMatch(flat, /\bTask\b/, 'must not regress to legacy bare Task entry');
  });
});

describe('/ai-sdlc rebase body — pipeline contract', () => {
  it('takes $ARGUMENTS as the PR number', () => {
    assert.match(body, /PR=\$ARGUMENTS/);
  });

  it('explains why the command body is inline (not in a subagent middleman)', () => {
    // Same harness limitation as /ai-sdlc execute — surface it so future
    // readers don't try to factor this out into a wrapper subagent.
    assert.match(body, /plugin subagents cannot use the\s+`Agent` tool/i);
    assert.match(body, /AISDLC-69\.2|AISDLC-98/);
  });

  it('locates worktree via .worktrees/<task-id-lower>', () => {
    assert.match(body, /WORKTREE_PATH=".worktrees\/\$TASK_ID_LOWER"/);
  });

  it('recreates worktree if missing', () => {
    assert.match(body, /git worktree add/);
    assert.match(body, /\[ ! -d "\$WORKTREE_PATH" \]/);
  });

  it('invokes the rebase-resolver subagent', () => {
    assert.match(body, /subagent_type:\s*rebase-resolver/i);
  });

  it('parses subagent return value with outcome dispatch', () => {
    assert.match(body, /escalated/);
    assert.match(body, /failed/);
    assert.match(body, /success/);
  });
});

describe('/ai-sdlc rebase body — hard rules', () => {
  it('forbids `gh pr merge`', () => {
    assert.match(body, /Never merge a PR/i);
    assert.match(body, /gh pr merge/);
  });

  it('forbids plain `git push --force` / `-f`', () => {
    assert.match(body, /Never force-push with plain `--force`/i);
    assert.match(body, /--force-with-lease/);
  });

  it('refuses to push on main/master (Hard Rule 3)', () => {
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

describe('/ai-sdlc rebase body — re-attestation', () => {
  it('reads preContentHash + postContentHash from subagent output', () => {
    assert.match(body, /preContentHash/);
    assert.match(body, /postContentHash/);
  });

  it('skips re-attestation when contentHash is unchanged', () => {
    assert.match(body, /contentHash unchanged/);
    assert.match(body, /No re-signing needed/);
  });

  it('uses sign-attestation.mjs --print-content-hash as the oracle (AISDLC-102)', () => {
    assert.match(body, /sign-attestation\.mjs"?\s+--print-content-hash/);
  });

  it('cites AISDLC-94 dual-hash + AISDLC-101 per-file delta as predicate justification', () => {
    assert.match(body, /AISDLC-94/);
    assert.match(body, /AISDLC-101/);
  });

  it('refuses re-sign without ~/.ai-sdlc/signing-key.pem', () => {
    assert.match(body, /\$HOME\/\.ai-sdlc\/signing-key\.pem/);
    assert.match(body, /\/ai-sdlc init-signing-key/);
  });

  it('invokes sign-attestation.mjs with verdicts + iteration + harness-note (same as execute Step 10)', () => {
    assert.match(body, /scripts\/sign-attestation\.mjs/);
    assert.match(body, /--review-verdicts/);
    assert.match(body, /--iteration-count/);
    assert.match(body, /--harness-note/);
  });

  it('stages .ai-sdlc/attestations in the chore commit', () => {
    assert.match(body, /git add \.ai-sdlc\/attestations/);
  });

  it('chore commit body sanitises CI-skip magic tokens (AISDLC-88)', () => {
    assert.match(body, /\(skip ci marker\)/);
    assert.match(body, /\(ci skip marker\)/);
    assert.match(body, /\(no ci marker\)/);
    assert.match(body, /\(skip actions marker\)/);
    assert.match(body, /\(actions skip marker\)/);
    assert.match(body, /git commit -m "\$CHORE_BODY"/);
  });
});

describe('/ai-sdlc rebase body — push step', () => {
  it('uses --force-with-lease (never plain --force)', () => {
    assert.match(body, /git push --force-with-lease origin "\$BRANCH"/);
  });

  it('refuses to push when branch is main/master (defense-in-depth at Step 6)', () => {
    // The body must include the branch guard at the push step, not
    // just at Step 1 (input validation).
    const step6 = body.split('## Step 6')[1] || '';
    assert.match(step6, /BRANCH.*main.*master/);
    assert.match(step6, /refusing to force-push/);
  });

  it('does NOT escalate to plain --force on rejection', () => {
    assert.match(body, /do NOT escalate to plain `--force`/i);
  });
});

describe('/ai-sdlc rebase body — escalation handling', () => {
  it('on escalated outcome: prints reason, does NOT push', () => {
    assert.match(body, /escalated.*print.*escalationReason/s);
    assert.match(body, /Do NOT push/);
  });

  it('preserves worktree on escalation for manual inspection', () => {
    assert.match(body, /Worktree preserved/);
  });

  it('on failed outcome: surfaces failure reason', () => {
    assert.match(body, /failed.*failure reason/s);
  });
});

describe('/ai-sdlc rebase body — composition with /ai-sdlc execute', () => {
  it('mirrors execute Step 10 chore-commit sanitization pattern', () => {
    // The five sed replacements + the same git commit -m wiring as
    // execute.md Step 10 — defense-in-depth shared between the two
    // commands.
    assert.match(body, /sed -E/);
    assert.match(body, /'s\/\\\[\[Ss\]\[Kk\]\[Ii\]\[Pp\] \[Cc\]\[Ii\]\\\]\/\(skip ci marker\)\/g'/);
  });

  it('documents when operator should invoke this manually', () => {
    assert.match(body, /When the operator should invoke this manually/);
    assert.match(body, /verify-attestation\.yml/);
  });
});

describe('/ai-sdlc rebase body — operator output', () => {
  it('emits [ai-sdlc-progress] lines', () => {
    assert.match(body, /\[ai-sdlc-progress\]/);
  });

  it('prints a tight summary at end of run', () => {
    assert.match(body, /## Step 7.*Report/);
    assert.match(body, /Outcome:/);
    assert.match(body, /Re-attestation:/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// AISDLC-105 round-2 reviewer fixes — regression gates for the four
// load-bearing breakages flagged in the second code review:
//
//   1. CRITICAL — Step 1 sed regex was BSD-incompatible (`+?` rejected)
//      and even on GNU sed produced the wrong task ID.
//   2. MAJOR    — Step 5 `exit 0` killed the command before Step 6,
//      stranding the rebased commits unpushed.
//   3. MAJOR    — subagent + slash command both pushed (duplicate push).
//   4. MAJOR    — Step 5 read /tmp/rebase-resolver-${PR}.json but no step
//      ever wrote it.
// ──────────────────────────────────────────────────────────────────────

describe('/ai-sdlc rebase body — Step 1 task-id regex (BSD-portable)', () => {
  // Ground truth: the regex literal in commands/rebase.md MUST be
  // portable across BSD sed (macOS) AND GNU sed (linux). Reviewer round
  // 2 rejected the prior `+?` non-greedy form because BSD sed errors
  // with `RE error: repetition-operator operand invalid` and the slash
  // command died before the subagent spawned.
  function deriveTaskIdFromBranch(branch, regexFromBody) {
    // JS regex ≠ POSIX ERE 1:1 but `[a-z]+-[0-9.]+` translates faithfully.
    const m = branch.match(regexFromBody);
    return m ? m[1] : null;
  }
  // The regex in body shape: 's|^ai-sdlc/([a-z]+-[0-9.]+).*|\1|'
  const portable = /^ai-sdlc\/([a-z]+-[0-9.]+).*/;

  it('regex literal in body uses BSD-portable [a-z]+-[0-9.]+ pattern', () => {
    assert.match(body, /\[a-z\]\+-\[0-9\.\]\+/);
  });

  it('regex does NOT use the BSD-incompatible `+?` non-greedy quantifier', () => {
    // Find the TASK_ID_LOWER assignment line(s) and assert no `+?` appears.
    const sedLine = body.split('\n').find((l) => l.includes('TASK_ID_LOWER=') && l.includes('sed'));
    assert.ok(sedLine, 'TASK_ID_LOWER sed pipeline must exist');
    assert.doesNotMatch(sedLine, /\+\?/, 'must not use `+?` (BSD sed rejects it)');
  });

  it('captures aisdlc-105 from ai-sdlc/aisdlc-105-rebase-resolver-...', () => {
    assert.equal(
      deriveTaskIdFromBranch('ai-sdlc/aisdlc-105-rebase-resolver-subagent', portable),
      'aisdlc-105',
    );
  });

  it('captures aisdlc-100.2 from ai-sdlc/aisdlc-100.2-foo-bar (sub-IDs preserved)', () => {
    assert.equal(deriveTaskIdFromBranch('ai-sdlc/aisdlc-100.2-foo-bar', portable), 'aisdlc-100.2');
  });

  it('captures aisdlc-115 from ai-sdlc/aisdlc-115-something (no sub-ID)', () => {
    assert.equal(deriveTaskIdFromBranch('ai-sdlc/aisdlc-115-something', portable), 'aisdlc-115');
  });

  it('captures the bare prefix-N when there is no slug suffix', () => {
    assert.equal(deriveTaskIdFromBranch('ai-sdlc/aisdlc-115', portable), 'aisdlc-115');
  });

  it('documents BSD vs GNU sed portability inline so the rule is visible', () => {
    assert.match(body, /BSD sed/);
    assert.match(body, /portable/i);
  });
});

describe('/ai-sdlc rebase body — Step 5 falls through to Step 6 (no exit 0)', () => {
  // Ground truth: when contentHash is unchanged, Step 5 must SKIP the
  // signing logic but MUST NOT terminate the command — Step 6 still
  // needs to push the rebased commits. The prior `exit 0` left commits
  // stranded in the worktree while operators believed the rebase was
  // done. Round-2 reviewer flagged this as "concrete failure: PR shows
  // pre-rebase HEAD on GitHub".
  it('Step 5 skip-resign branch does NOT use `exit 0`', () => {
    const step5 = body.split('## Step 5')[1]?.split('## Step 6')[0] || '';
    assert.ok(step5.length > 0, 'Step 5 section must exist before Step 6');
    // Ban the literal `exit 0` from the skip-resign control flow.
    assert.doesNotMatch(
      step5,
      /^\s*exit 0\s*$/m,
      'Step 5 must not contain `exit 0` (would skip Step 6 push)',
    );
  });

  it('Step 5 uses if/else control flow (skip vs sign) rather than early-exit', () => {
    const step5 = body.split('## Step 5')[1]?.split('## Step 6')[0] || '';
    // Either an `if … then … else …` or an inverted-guard `if [ $PRE != $POST ]; then ... fi`
    // pattern is acceptable. We assert at least an `else` OR an `fi` exists in
    // the section to prove the skip path is wrapped, not exited.
    assert.match(step5, /\bfi\b/, 'Step 5 must close an if-block (control flow, not exit)');
  });

  it('Step 5 documents that skip-branch must fall through to Step 6', () => {
    const step5 = body.split('## Step 5')[1]?.split('## Step 6')[0] || '';
    assert.match(
      step5,
      /[Ff]all(s)? through to Step 6|MUST.*push|push.*MUST/,
      'Step 5 must explain that the skip branch still requires Step 6 to run',
    );
  });
});

describe('/ai-sdlc rebase body — push-owner consolidation (single push)', () => {
  // Ground truth: the slash command body owns the force-push (Step 6).
  // The subagent does NOT push. Round-2 reviewer caught duplicate-push
  // race (subagent pushed AND slash command pushed = 2 CI runs and
  // potentially the chore commit lost).
  it('Step 3 prompt instructs subagent NOT to push', () => {
    const step3 = body.split('## Step 3')[1]?.split('## Step 4')[0] || '';
    assert.match(
      step3,
      /Do NOT push from the subagent|subagent.*does NOT push|sole.*force-with-lease push/i,
      'Step 3 prompt must instruct the subagent not to push',
    );
  });

  it('Step 6 (in slash command) is the only `git push --force-with-lease` site', () => {
    // The body should contain at most one `git push --force-with-lease`
    // call site (Step 6). Reference shapes inside fenced documentation
    // blocks are allowed but the actually-executable push must be unique.
    const lines = body.split('\n');
    const pushSites = lines.filter(
      (l) => /git push --force-with-lease origin/.test(l) && !l.trim().startsWith('#'),
    );
    assert.equal(
      pushSites.length,
      1,
      `expected exactly one executable force-with-lease push site (Step 6); found ${pushSites.length}`,
    );
  });
});

describe('/ai-sdlc rebase body — subagent JSON written to /tmp before Step 5', () => {
  // Ground truth: Step 5's jq calls read /tmp/rebase-resolver-${PR}.json
  // but if no step writes it, the file is empty/missing and PRE_HASH /
  // POST_HASH always come back blank — the skip-resign branch never
  // fires and Step 5 always re-signs. Defeats the AISDLC-101 v3-leg
  // optimization.
  it('Step 4 (or between 4 and 5) writes /tmp/rebase-resolver-${PR}.json', () => {
    const upToStep5 = body.split('## Step 5')[0];
    assert.match(
      upToStep5,
      /\/tmp\/rebase-resolver-\$\{PR\}\.json/,
      'a step BEFORE Step 5 must reference the /tmp JSON path',
    );
    // And it must be a write (heredoc, redirection, or printf-into-file),
    // not just a mention.
    assert.match(
      upToStep5,
      /(cat\s*>\s*\/tmp\/rebase-resolver|>\s*\/tmp\/rebase-resolver-\$\{PR\}\.json)/,
      'must write to the file via heredoc or redirection',
    );
  });

  it('Step 4 documents WHY the persistence is needed (prevents skip-resign regression)', () => {
    const step4 = body.split('## Step 4')[1]?.split('## Step 5')[0] || '';
    assert.match(
      step4,
      /skip-resign|skip the.*signing|skip the.*sign|Step 5/i,
      'Step 4 must explain that Step 5 reads the persisted file',
    );
  });
});

describe('/ai-sdlc rebase body — re-attestation fidelity (iteration + harness)', () => {
  // Ground truth: when re-signing after rebase, carry the original
  // attestation's iterationCount + harnessNote forward instead of
  // hard-coding `1` and `""`. Falls back to defaults + documents the
  // loss in the chore commit body if the original envelope is missing.
  it('reads iterationCount from the pre-rebase DSSE envelope (not hard-coded 1)', () => {
    assert.match(
      body,
      /iterationCount.*?1|PRE_ITER/,
      'must read iterationCount from the pre-rebase attestation file',
    );
    // The body should reference the pre-rebase attestation file path.
    assert.match(body, /\.ai-sdlc\/attestations\/\$\{PRE_HEAD_SHA\}\.dsse\.json/);
  });

  it('reads harnessNote from the pre-rebase DSSE envelope (not hard-coded "")', () => {
    assert.match(body, /harnessNote/);
    assert.match(body, /PRE_HARNESS_NOTE/);
  });

  it('documents the fidelity-loss fallback path when pre-rebase envelope is missing', () => {
    assert.match(body, /FIDELITY_NOTE|reset to defaults|fidelity/i);
  });
});
