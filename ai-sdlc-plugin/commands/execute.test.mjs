/**
 * Tests for the /ai-sdlc execute slash command.
 *
 * AISDLC-98 put the Step 0-13 recipe in the slash command body (plugin
 * subagents cannot use the `Agent` tool, only the main session can). AISDLC-762
 * then turned that body into a thin loop over
 * `ai-sdlc-pipeline next-step`: every deterministic step runs in tested
 * TypeScript (`pipeline-cli/src/next-step/`), and the body only teaches the
 * session to perform ONE instruction at a time. The behavioural coverage of the
 * moved steps (CI-skip scrubbing, signing-key check, pre-sign rebase, nonce
 * binding, draft PR ordering, ...) lives in the pipeline-cli vitest suites; this
 * file pins the body contract: size, loop shape, the governance rules the body
 * must still carry, path resolution and the wiring to the CLI.
 *
 * Run with: node --test ai-sdlc-plugin/commands/execute.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cmdFile = join(__dirname, 'execute.md');
const orchestratorFile = join(__dirname, '..', 'agents', 'execute-orchestrator.md');
const repoRoot = join(__dirname, '..', '..');

let frontmatter;
let cmdBody;
let cmdContent;

before(() => {
  cmdContent = readFileSync(cmdFile, 'utf-8');
  const cmdMatch = cmdContent.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!cmdMatch) throw new Error('No frontmatter in execute.md');

  // Frontmatter parser supports both scalar (`key: value`) and list
  // (`key:` followed by `  - item` lines) forms.
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

describe('AISDLC-98: execute-orchestrator subagent removed', () => {
  it('ai-sdlc-plugin/agents/execute-orchestrator.md no longer exists', () => {
    assert.equal(
      existsSync(orchestratorFile),
      false,
      'execute-orchestrator.md must be deleted (reverted in AISDLC-98 because plugin subagents cannot use the Agent tool)',
    );
  });
});

describe('/ai-sdlc execute frontmatter', () => {
  it('declares the command name', () => {
    assert.equal(frontmatter.name, 'execute');
  });

  it('declares an argument hint', () => {
    assert.ok(frontmatter['argument-hint'], 'argument-hint should be present');
    assert.match(frontmatter['argument-hint'], /task-id/, 'should reference task-id');
  });

  it('pins the sonnet model (AISDLC-761)', () => {
    assert.equal(frontmatter.model, 'sonnet');
  });

  it('declares Agent(<allowlist>) restricted to the four spawnable subagents (AISDLC-98)', () => {
    const tools = frontmatter['allowed-tools'];
    assert.ok(Array.isArray(tools), 'allowed-tools must be a list');
    const agentDecl = tools.find((t) => t.startsWith('Agent('));
    assert.ok(
      agentDecl,
      'execute.md must declare Agent(<allowlist>) to spawn developer + reviewers',
    );
    assert.match(agentDecl, /\bdeveloper\b/, 'allowlist must include developer');
    assert.match(agentDecl, /\bcode-reviewer\b/, 'allowlist must include code-reviewer');
    assert.match(agentDecl, /\btest-reviewer\b/, 'allowlist must include test-reviewer');
    assert.match(agentDecl, /\bsecurity-reviewer\b/, 'allowlist must include security-reviewer');
  });

  it('does NOT regress to Agent(execute-orchestrator) (the deleted middleman)', () => {
    const tools = frontmatter['allowed-tools'];
    const flat = Array.isArray(tools) ? tools.join(' ') : tools;
    assert.doesNotMatch(flat, /Agent\(execute-orchestrator\)/);
  });

  it('does NOT declare the legacy bare Task tool (renamed to Agent in v2.1.63)', () => {
    const tools = frontmatter['allowed-tools'];
    const flat = Array.isArray(tools) ? tools.join(' ') : tools;
    assert.doesNotMatch(flat, /\bTask\b/);
  });

  it('keeps the plugin task_edit + task_complete tools (AISDLC-83 namespace)', () => {
    const tools = frontmatter['allowed-tools'];
    assert.ok(tools.includes('mcp__plugin_ai-sdlc_ai-sdlc__task_edit'));
    assert.ok(tools.includes('mcp__plugin_ai-sdlc_ai-sdlc__task_complete'));
  });

  it('does NOT declare the legacy mcp__ai-sdlc-plugin__* namespace', () => {
    const tools = frontmatter['allowed-tools'];
    const list = Array.isArray(tools) ? tools : [tools];
    for (const tool of list) {
      assert.ok(!tool.startsWith('mcp__ai-sdlc-plugin__'), `legacy namespace: '${tool}'`);
    }
  });
});

describe('/ai-sdlc execute body is a thin next-step loop (AISDLC-762)', () => {
  it('AC-1: is 250 lines or fewer', () => {
    const lines = cmdContent.replace(/\n$/, '').split('\n').length;
    assert.ok(lines <= 250, `execute.md is ${lines} lines; the budget is 250`);
  });

  it('drives the pipeline through `next-step` with --task, --state and --fresh', () => {
    assert.match(
      cmdBody,
      /ai-sdlc-pipeline\.mjs" next-step --task "\$ARGUMENTS" --state "\$STATE" --fresh/,
    );
  });

  it('teaches every instruction the CLI can return', () => {
    for (const action of ['spawn-developer', 'spawn-reviewers', 'fix-report', 'done', 'stop']) {
      assert.match(cmdBody, new RegExp(`### \`${action}\``), `missing section for ${action}`);
    }
  });

  it('reports results back through the instruction reply command with a quoted heredoc', () => {
    assert.match(cmdBody, /<reply command from the instruction> <<'AISDLC_RESULT'/);
    assert.match(cmdBody, /`reply` command/);
    assert.match(cmdBody, /<\/dev\/null/, 'must say how to re-read the pending instruction');
  });

  it('spawns all reviewers in a single message and never edits the nonce-bearing prompt', () => {
    assert.match(cmdBody, /Issue ALL of them in a single message/);
    assert.match(cmdBody, /agentId/);
    assert.match(cmdBody, /never edit or drop it/);
  });

  it('does not narrate the pipeline steps any more', () => {
    assert.doesNotMatch(
      cmdBody,
      /^## Step \d/m,
      'no "## Step N" sections: the steps live in TypeScript',
    );
    assert.doesNotMatch(cmdBody, /^### Step \d/m);
  });

  it('does not re-implement deterministic work in its shell blocks', () => {
    // Prose may DESCRIBE what next-step does; the executable blocks may not do it.
    const blocks = [...cmdBody.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
    assert.ok(blocks.length > 0, 'expected bash blocks');
    for (const forbidden of [
      /git worktree add/,
      /git push/,
      /gh pr (create|ready)/,
      /cli-classify-pr/,
      /cli-incremental-decide/,
      /generate-nonce/,
      /emit-leaf/,
      /persist-reviewer-artifacts/,
      /sign-attestation\.mjs/,
    ]) {
      assert.doesNotMatch(
        blocks,
        forbidden,
        `deterministic step leaked into a shell block: ${forbidden}`,
      );
    }
  });

  it('points maintainers at the code that now owns each step', () => {
    for (const file of ['init', 'review-prepare', 'review-finalize', 'ship', 'next-step']) {
      assert.ok(
        existsSync(join(repoRoot, 'pipeline-cli', 'src', 'next-step', `${file}.ts`)),
        `pipeline-cli/src/next-step/${file}.ts must exist`,
      );
    }
    assert.match(cmdBody, /pipeline-cli\/src\/next-step\//);
    assert.match(cmdBody, /pipeline-cli\/src\/cli\/next-step\.ts/);
  });

  it('wires `next-step` into the pipeline CLI router', () => {
    const router = readFileSync(join(repoRoot, 'pipeline-cli', 'src', 'cli', 'index.ts'), 'utf-8');
    assert.match(router, /nextStepCommand\(\)/);
  });

  it('explains why the loop lives in the slash body (plugin subagents cannot use Agent)', () => {
    assert.match(cmdBody, /Plugin subagents cannot use the `Agent` tool/);
    assert.match(cmdBody, /AISDLC-69\.2/);
    assert.match(cmdBody, /AISDLC-98/);
  });

  it('documents `/loop` compatibility and per-run isolation', () => {
    assert.match(cmdBody, /\/loop \/ai-sdlc execute/);
    assert.match(cmdBody, /own worktree, state file and `\.active-task` sentinel/);
  });

  it('passes $ARGUMENTS through (the task ID input)', () => {
    assert.match(cmdBody, /\$ARGUMENTS/);
  });

  it('states the orchestration budget (AC-2)', () => {
    assert.match(cmdBody, /3-7 `next-step` calls/);
    assert.match(cmdBody, /AC-2 allows 15/);
  });

  it('keeps the return-value contract for wrapping /loop drivers', () => {
    for (const key of [
      '"taskId"',
      '"outcome"',
      '"prUrl"',
      '"siblingPrUrls"',
      '"reviews"',
      '"developer"',
    ]) {
      assert.ok(cmdBody.includes(key), `return JSON must document ${key}`);
    }
    for (const outcome of ['approved', 'needs-human-attention', 'developer-failed', 'aborted']) {
      assert.ok(cmdBody.includes(outcome), `outcome ${outcome} must stay documented`);
    }
  });
});

describe('/ai-sdlc execute — argument forms (AISDLC-393)', () => {
  it('documents the three regex shapes in precedence order', () => {
    const gh = cmdBody.indexOf('^gh:\\d+$');
    const task = cmdBody.indexOf('^[A-Za-z][A-Za-z0-9]*-\\d+(\\.\\d+)*$');
    const bare = cmdBody.indexOf('^#?\\d+$');
    assert.ok(gh > 0 && task > gh && bare > task, 'gh: first, then task id, then bare number');
  });

  it('points at the reference parser and refuses unknown forms', () => {
    assert.match(cmdBody, /parseExecuteArg/);
    assert.match(cmdBody, /dogfood\/src\/dispatch-execute-arg\.ts/);
    assert.match(cmdBody, /refuses anything else/);
  });

  it('requires an untrusted session for the GH-issue path (AISDLC-720) and forbids API-key fallback', () => {
    assert.match(cmdBody, /AISDLC-720/);
    assert.match(cmdBody, /AI_SDLC_UNTRUSTED_RUN=1/);
    assert.match(cmdBody, /AI_SDLC_UNTRUSTED_REASON='gh-issue source'/);
    assert.match(cmdBody, /never falls back to `ANTHROPIC_API_KEY`/);
  });
});

describe('/ai-sdlc execute — hard governance rules stay in the body', () => {
  it('embeds the config-driven merge rule and the only sanctioned merge path', () => {
    assert.match(cmdBody, /Merging follows `governance\.allowMerge`/);
    assert.match(cmdBody, /only path is `cli-merge-if-eligible`/);
    assert.match(cmdBody, /never run the raw merge command/);
    assert.match(cmdBody, /cli-merge-if-eligible\.mjs <pr> --source-kind backlog/);
  });

  it('forbids a plain force-push and prescribes only the explicit lease spelling', () => {
    assert.match(cmdBody, /Never plain force-push/i);
    assert.match(cmdBody, /allowForcePush: leaseOnOwnBranch/);
    assert.match(
      cmdBody,
      /git push --force-with-lease origin HEAD:refs\/heads\/<this task's own branch>/,
    );
    assert.doesNotMatch(cmdBody, /git push --force-with-lease -u/);
  });

  it('forbids closing PRs/issues and deleting branches unless the rendered rules allow it', () => {
    assert.match(cmdBody, /Never close PRs or issues/);
    assert.match(cmdBody, /allowClosePrIssue: true/);
    assert.match(cmdBody, /Never delete branches/);
    assert.match(cmdBody, /allowBranchDelete: true/);
  });

  it('keeps the governance-config edit rule and the untrusted-run block (AISDLC-720)', () => {
    assert.match(cmdBody, /Edit governance config \(`\.ai-sdlc\/\*\*`\) only when the task names/i);
    assert.match(cmdBody, /AI_SDLC_UNTRUSTED_RUN/);
  });

  it('keeps the ad-hoc git reset --hard rule (AISDLC-450)', () => {
    assert.match(cmdBody, /Never run `git reset --hard` ad-hoc/);
    assert.match(cmdBody, /allowResetHard: true/);
    assert.match(cmdBody, /check-orchestrator-state\.sh/);
    assert.match(cmdBody, /`git checkout -- \.` and `git restore \.` are always forbidden/);
  });

  it('renders the resolved policy with render-governance-hard-rules.mjs (AISDLC-601)', () => {
    assert.match(cmdBody, /render-governance-hard-rules\.mjs/);
    assert.match(cmdBody, /RFC-0048/);
  });

  it('forbids GH Actions CI-skip magic tokens in commit messages (AISDLC-88)', () => {
    assert.ok(cmdBody.includes('AISDLC-88'), 'reference AISDLC-88 task ID');
    assert.match(cmdBody, /\[skip ci\]/);
    assert.match(cmdBody, /\[ci skip\]/);
    assert.match(cmdBody, /\[no ci\]/);
    assert.match(cmdBody, /\[skip actions\]/);
    assert.match(cmdBody, /\[actions skip\]/);
    assert.match(cmdBody, /\(skip ci marker\)/, 'show the paren-quoted example');
    assert.match(cmdBody, /backtick-wrapping does NOT defeat/i);
    assert.match(cmdBody, /(github-actions|ai-sdlc-ci-attestor)\[bot\]/);
    assert.match(cmdBody, /chore\(ci\): sign review attestation/);
    assert.match(cmdBody, /sanitizeCiSkipTokens/, 'names the code that scrubs the chore commit');
  });

  it('marks the integrity floors as not configurable (RFC-0048 OQ-3)', () => {
    assert.match(cmdBody, /Items 5 and 7 are \*\*fixed integrity floors\*\*/);
  });
});

describe('/ai-sdlc execute — floors enforced by next-step are still documented', () => {
  it('CCR remote-sandbox refusal (AISDLC-442) and its test override', () => {
    assert.match(cmdBody, /CCR remote-sandbox refusal \(AISDLC-442/);
    assert.match(cmdBody, /AI_SDLC_SKIP_CCR_GUARD=1/);
  });

  it('hooks-directory check on the new worktree, scripts never disabled (AISDLC-693)', () => {
    assert.match(cmdBody, /fail-closed hooks-directory check/);
    assert.match(cmdBody, /AISDLC-693/);
    assert.match(cmdBody, /install scripts are never disabled/);
    assert.ok(!cmdBody.includes('--ignore-scripts'));
  });

  it('per-worktree .active-task sentinel written at Step 4 and removed on every exit (AISDLC-81)', () => {
    assert.match(cmdBody, /per-worktree `\.active-task` sentinel \(AISDLC-81/);
    assert.match(cmdBody, /removed on every exit path/);
  });

  it('sibling PRs, no auto-resolved rebase conflicts, DRAFT PR (AISDLC-218)', () => {
    assert.match(cmdBody, /`permittedExternalPaths` sibling PRs/);
    assert.match(cmdBody, /never auto-resolving a rebase conflict/);
    assert.match(cmdBody, /opening the PR as a DRAFT \(AISDLC-218\)/);
  });

  it('a needs-human-attention run is not flipped ready', () => {
    assert.match(cmdBody, /NOT flipped ready/);
  });

  it('explicitly lists what the command does not do', () => {
    assert.match(cmdBody, /## What this command DOES NOT do/);
    assert.match(cmdBody, /Never runs `git push --force`/);
    assert.match(cmdBody, /Never auto-resolves rebase conflicts/);
  });
});

describe('/ai-sdlc execute — path resolution (AISDLC-245.4, AISDLC-272)', () => {
  it('establishes PLUGIN_SCRIPTS_DIR from CLAUDE_PLUGIN_DIR, then CLAUDE_PLUGIN_ROOT, then the dogfood dir', () => {
    assert.match(
      cmdBody,
      /PLUGIN_SCRIPTS_DIR="\$\{CLAUDE_PLUGIN_DIR:-\$\{CLAUDE_PLUGIN_ROOT:-\$\(pwd\)\/ai-sdlc-plugin\}\}\/scripts"/,
    );
  });

  it('delegates PIPELINE_CLI_BIN resolution to resolve-pipeline-cli.sh', () => {
    assert.match(cmdBody, /resolve-pipeline-cli\.sh/);
    assert.match(
      cmdBody,
      /PIPELINE_CLI_BIN=\$\(bash "\$PLUGIN_SCRIPTS_DIR\/resolve-pipeline-cli\.sh"\)/,
    );
  });

  it('lets the operator override PIPELINE_CLI_BIN and fails with an actionable message', () => {
    assert.match(cmdBody, /if \[ -z "\$\{PIPELINE_CLI_BIN:-\}" \]/);
    assert.match(cmdBody, /export PIPELINE_CLI_BIN=\/path\/to\/pipeline-cli\/bin/);
    assert.match(cmdBody, /@ai-sdlc\/pipeline-cli not found/);
  });

  it('falls back to the repo build when the resolver script is not shipped (upgrade in place)', () => {
    assert.match(cmdBody, /PIPELINE_CLI_BIN="\$\(pwd\)\/pipeline-cli\/bin"/);
  });

  it('invokes pipeline-cli only through $PIPELINE_CLI_BIN (no bare relative paths)', () => {
    const offenders = cmdBody
      .split('\n')
      .filter((l) => /node\s+(?:\.\/)?pipeline-cli\/bin\//.test(l))
      // The rendered-rules line names the sanctioned merge CLI in prose; it is not a shell block.
      .filter((l) => !/cli-merge-if-eligible/.test(l));
    assert.deepEqual(offenders, [], 'bare pipeline-cli paths found');
  });

  it('keeps the state file under TMPDIR, never inside the parent checkout', () => {
    assert.match(cmdBody, /STATE="\$\{TMPDIR:-\/tmp\}\/ai-sdlc-next-step\//);
  });
});

describe('/ai-sdlc execute — next-step implements what the body used to narrate', () => {
  const src = (rel) =>
    readFileSync(join(repoRoot, 'pipeline-cli', 'src', 'next-step', rel), 'utf-8');

  it('the CCR guard keeps its three heuristics and the override (AISDLC-442)', () => {
    const args = src('args.ts');
    assert.match(args, /CLAUDE_CODE_ENV === 'ccr'/);
    assert.match(args, /CLAUDE_REMOTE_EXECUTION === '1'/);
    assert.match(args, /signing-key\.pem/);
    assert.match(args, /AI_SDLC_SKIP_CCR_GUARD/);
    assert.match(args, /mcp__backlog__task_create/);
    assert.match(args, /mcp__github__create_issue/);
    assert.match(args, /docs\/operations\/remote-agents-readonly\.md/);
  });

  it('the reviewer nonce is generated before the spawn and reused for the leaf (AISDLC-573)', () => {
    const prepare = src('review-prepare.ts');
    const finalize = src('review-finalize.ts');
    assert.ok(prepare.indexOf('generate-nonce') > 0 && prepare.indexOf('nonce-marker') > 0);
    assert.match(prepare, /Diff-binding token/);
    assert.match(finalize, /'--nonce',\s*review\.nonce/);
  });

  it('transcripts are persisted by the coordinator script, never by reviewers (AISDLC-599)', () => {
    assert.match(src('review-finalize.ts'), /persist-reviewer-artifacts\.sh/);
  });

  it('the pre-sign rebase, signing and push stay on the sanctioned paths', () => {
    const ship = src('ship.ts');
    assert.match(ship, /print-content-hash/);
    assert.match(ship, /sign-attestation-if-consumer\.sh/);
    assert.match(ship, /sanitizeCiSkipTokens/);
    assert.doesNotMatch(ship, /'--force|'push',\s*'-f'/, 'ship.ts must never force-push');
    assert.doesNotMatch(ship, /'pr',\s*'merge'/, 'ship.ts must never merge');
  });

  it('model routing is resolved for the developer and for every reviewer agent', () => {
    assert.match(src('review-prepare.ts'), /resolveModel\(\{\s*role: agent/);
    assert.match(src('next-step.ts'), /buildDeveloperPrompt/);
  });
});
