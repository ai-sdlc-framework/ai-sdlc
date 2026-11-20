#!/usr/bin/env node
/**
 * Bootstrap smoke (AISDLC-1361): one test takes a scratch repository from `ai-sdlc setup`
 * to a merged pull request and fails when any stage is skipped.
 *
 * Operator requirement (2026-11-19): bootstrap a repository once and have everything
 * configured and running; anything not working says so loudly. Each stage prints
 * `[bootstrap-smoke] stage <n> <name>` and `ok`; a final check compares the stages that ran
 * with STAGES and fails naming each one that did not.
 *
 * The `gh` on PATH is a stateful fake (scripts/bootstrap-smoke-gh.mjs) that records every
 * call and fails any call it does not know. It proves the CLIs' own logic: the scaffolded
 * files agree with each other and the merge gate and landing pass accept a green pull request
 * under the scaffolded settings. It cannot prove real branch protection, repository secrets,
 * the "Allow auto-merge" setting, that GitHub posts the checks the scaffold requires, or that
 * the canned answers match the live API.
 *
 * Operator inputs (the webhook secret, and the three merge keys when the scaffold default is
 * merging off) are first left out, the line naming the missing piece and its fix is asserted,
 * then they are supplied as an operator would. The run holds for either scaffold default.
 *
 * Prerequisite: `pnpm build`. Usage: node scripts/bootstrap-smoke.mjs
 *
 * Test seams (used by scripts/bootstrap-smoke.test.mjs):
 *   BOOTSTRAP_SKIP_STAGE   stage number or name to skip
 *   BOOTSTRAP_REMOVE       comma-separated paths removed from the repository before stage 2
 *   BOOTSTRAP_DOCTOR_DROP  doctor check id removed from the report (a check that returned nothing)
 *   BOOTSTRAP_DOCTOR_FAIL  doctor check id whose result is turned into a `fail`
 *   BOOTSTRAP_SKIP_SECRET  1: the operator never sets the webhook secret (stage 4 must fail)
 *   BOOTSTRAP_SKIP_MERGE_KEYS  1: the operator never sets the merge keys (stage 4 must fail)
 *   BOOTSTRAP_LAND_EMPTY   1: the landing pass reads an empty merge-author list (stage 9 must fail)
 *   BOOTSTRAP_KEEP        1 keeps the scratch directory for inspection
 *   BOOTSTRAP_UP_WARNING   a `warning:` line appended to the output of `up`
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSandbox, commitAll } from './first-run-smoke.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET_MS = 5 * 60 * 1000;
const STEP_TIMEOUT_MS = 120_000;
const SLUG = 'smoke/bootstrap';
const AUTHOR = 'smoke-bot';

export const STAGES = [
  'setup',
  'prerequisites',
  'doctor',
  'up',
  'task picked up',
  'pull request opened',
  'review verdict record',
  'merge gate',
  'landing',
];

/** Every file and folder `setup` is meant to create. */
export const PREREQUISITES = [
  '.ai-sdlc/agent-role.yaml',
  '.ai-sdlc/pipeline.yaml',
  '.github/workflows/ai-sdlc-gate.yml',
  'backlog/tasks',
  'backlog/completed',
];

/** The merge settings `setup` writes into the agent role (AISDLC-1351). */
export const MERGE_KEYS = ['allowMerge', 'mergeAuthors', 'operational'];

// ── Pure checks (exported for the hermetic test) ────────────────────────

/** Stage names in STAGES that are not in `ran`, in list order. */
export function missingStages(ran) {
  return STAGES.filter((s) => !ran.includes(s));
}

/** Problems with the scaffold: a missing file or folder, or a missing merge setting. */
export function prerequisiteProblems(work) {
  const problems = [];
  for (const rel of PREREQUISITES) {
    if (!existsSync(join(work, rel))) problems.push(`setup did not create ${rel}`);
  }
  const role = join(work, '.ai-sdlc', 'agent-role.yaml');
  if (existsSync(role)) {
    const text = readFileSync(role, 'utf8');
    for (const key of MERGE_KEYS) {
      if (!new RegExp(`^\\s*${key}:`, 'm').test(text)) {
        problems.push(`agent-role.yaml has no ${key} merge setting`);
      }
    }
  }
  return problems;
}

/** Problems with a doctor report: any `fail`, and any registry check with no result. */
export function doctorProblems(report, registryIds) {
  const problems = [];
  for (const r of report.results.filter((x) => x.severity === 'fail')) {
    problems.push(`doctor reported fail: ${r.id}: ${r.title}`);
  }
  const seen = new Set(report.results.map((r) => r.id));
  for (const id of registryIds) {
    if (!seen.has(id)) problems.push(`doctor check ${id} returned no result (silent skip)`);
  }
  return problems;
}

/** Lines of `up` output that name a problem or a missing piece. */
export function upProblemLines(lines) {
  return lines.filter((l) => /^warning:/.test(l) || /^webhook: off/.test(l));
}

/** Calls the fake gh did not know. */
export function unknownCalls(calls) {
  return calls.filter((c) => !c.known).map((c) => `gh ${c.args.join(' ')}`);
}

// ── Run ─────────────────────────────────────────────────────────────────

function fail(msg) {
  throw new Error(msg);
}

function seamMatches(value, n, name) {
  return value !== undefined && value !== '' && (value === String(n) || value === name);
}

export async function runBootstrap() {
  const started = Date.now();
  for (const built of [
    'orchestrator/dist/cli/index.js',
    'pipeline-cli/dist/index.js',
    'pipeline-cli/dist/cli/hierarchy.js',
  ]) {
    if (!existsSync(join(ROOT, built))) fail(`${built} missing - run \`pnpm build\` first`);
  }
  const ghScript = `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, 'scripts', 'bootstrap-smoke-gh.mjs')}" "$@"\n`;
  const sb = buildSandbox({ ghScript, prefix: 'ai-sdlc-bootstrap-' });
  const origin = join(sb.base, 'origin.git');
  const statePath = join(sb.base, 'gh-state.json');
  const callsPath = join(sb.base, 'gh-calls.jsonl');
  const boardDir = join(sb.base, 'board');
  const policyRoot = join(sb.base, 'scaffold-policy');
  const pipelineDist = join(ROOT, 'pipeline-cli', 'dist');
  const ran = [];
  let callsSeen = 0;
  const env = {
    ...sb.env,
    BOOTSTRAP_GH_STATE: statePath,
    BOOTSTRAP_GH_CALLS: callsPath,
    AI_SDLC_EPHEMERAL_EXECUTORS: '0',
  };
  for (const k of ['AI_SDLC_WEBHOOK_SECRET', 'GH_TOKEN', 'GITHUB_TOKEN', 'CLAUDE_PROJECT_DIR']) {
    delete env[k];
  }
  const sbx = { ...sb, env };

  writeFileSync(
    statePath,
    JSON.stringify({
      slug: SLUG,
      origin,
      base: 'main',
      author: AUTHOR,
      autoMerge: false,
      protection: null,
      prs: [],
      secrets: ['AI_SDLC_PAT'],
      // CI has not finished when a pull request opens; stage 8 flips this once it has.
      checks: 'PENDING',
    }),
  );
  writeFileSync(callsPath, '');
  mkdirSync(boardDir, { recursive: true });
  const node = (args, extra = {}) =>
    spawnSync(process.execPath, args, {
      cwd: sb.work,
      env,
      encoding: 'utf8',
      timeout: STEP_TIMEOUT_MS,
      ...extra,
    });
  const git = (...a) => execFileSync('git', ['-C', sb.work, ...a], { env, encoding: 'utf8' });
  const readState = () => JSON.parse(readFileSync(statePath, 'utf8'));
  const readCalls = () =>
    readFileSync(callsPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const hierarchy = (mode, extraEnv = {}, extraArgs = []) =>
    node(
      [
        join(ROOT, 'scripts', 'bootstrap-smoke-hierarchy.mjs'),
        pipelineDist,
        mode,
        boardDir,
        ...extraArgs,
      ],
      { env: { ...env, ...extraEnv } },
    );
  const parseHierarchy = (r, { allowRefusal = false } = {}) => {
    const lines = r.stdout.split('\n').filter(Boolean);
    const last = lines.filter((l) => l.startsWith('RESULT ')).pop();
    if ((r.status !== 0 && !allowRefusal) || !last) {
      fail(`hierarchy helper failed (exit ${r.status})\n${r.stdout}\n${r.stderr}`);
    }
    const out = lines.filter((l) => !l.startsWith('RESULT '));
    // The CLI reports a refusal on stderr; keep it with the lines so a failure names it.
    out.push(
      ...r.stderr
        .split('\n')
        .filter(Boolean)
        .map((l) => `stderr: ${l}`),
    );
    return { lines: out, result: JSON.parse(last.slice(7)) };
  };

  const { parseOperationalPolicy, mergeOffLines } = await import(
    pathToFileURL(join(pipelineDist, 'hierarchy', 'operational.js')).href
  );
  const { DOCTOR_CHECKS } = await import(
    pathToFileURL(join(ROOT, 'orchestrator', 'dist', 'cli', 'commands', 'doctor-checks.js')).href
  );

  /** Worktree path a branch is checked out in. */
  const worktreeOf = (branch) => {
    const list = git('worktree', 'list', '--porcelain').split('\n\n');
    const block = list.find((b) => b.includes(`branch refs/heads/${branch}`));
    const path = /^worktree (.+)$/m.exec(block ?? '')?.[1];
    if (!path) fail(`no worktree holds branch ${branch}`);
    return path;
  };
  const ctx = { taskId: '', branch: '', commit: '', pr: 0 };
  const rolePath = join(sb.work, '.ai-sdlc', 'agent-role.yaml');

  const stages = [
    // 1
    () => {
      const r = node([join(ROOT, 'orchestrator', 'dist', 'cli', 'index.js'), 'setup']);
      if (r.status !== 0) fail(`ai-sdlc setup exited ${r.status}\n${r.stdout}\n${r.stderr}`);
      mkdirSync(policyRoot, { recursive: true });
      commitAll(sbx, 'chore: ai-sdlc setup');
    },
    // 2
    () => {
      for (const rel of (process.env.BOOTSTRAP_REMOVE ?? '').split(',').filter(Boolean)) {
        rmSync(join(sb.work, rel), { recursive: true, force: true });
      }
      const problems = prerequisiteProblems(sb.work);
      const protection = readState().protection;
      const gate = join(sb.work, '.github', 'workflows', 'ai-sdlc-gate.yml');
      if (existsSync(gate)) {
        const text = readFileSync(gate, 'utf8');
        for (const ctxName of protection?.required_status_checks?.contexts ?? []) {
          if (!text.includes(ctxName)) {
            problems.push(
              `branch protection requires ${ctxName} but the gate workflow never posts it`,
            );
          }
        }
      }
      if (problems.length) fail(problems.join('\n'));
    },
    // 3
    () => {
      const r = node([
        join(ROOT, 'orchestrator', 'dist', 'cli', 'index.js'),
        '--format',
        'json',
        'doctor',
      ]);
      let report;
      try {
        report = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
      } catch {
        fail(`ai-sdlc doctor printed no JSON report (exit ${r.status})\n${r.stdout}\n${r.stderr}`);
      }
      const drop = process.env.BOOTSTRAP_DOCTOR_DROP;
      const force = process.env.BOOTSTRAP_DOCTOR_FAIL;
      if (drop) report.results = report.results.filter((x) => x.id !== drop);
      if (force) {
        report.results = report.results.map((x) =>
          x.id === force ? { ...x, severity: 'fail' } : x,
        );
      }
      const problems = doctorProblems(
        report,
        DOCTOR_CHECKS.map((c) => c.id),
      );
      if (problems.length) fail(problems.join('\n'));
      console.log(`    doctor: ${report.results.length} results, 0 fail`);
    },
    // 4
    () => {
      const policy = parseOperationalPolicy(readFileSync(rolePath, 'utf8'));
      const expectedOff = mergeOffLines(policy);
      writeFileSync(join(policyRoot, 'agent-role.yaml'), readFileSync(rolePath, 'utf8'));
      // Operator input 1: the harness must accept messages between the sessions. Without it `up`
      // refuses and names the setting and the file to put it in.
      const refused = parseHierarchy(hierarchy('up'), { allowRefusal: true });
      const refusal = refused.lines.join('\n');
      if (
        refused.result.code === 0 ||
        !refusal.includes('crossSessionInbound') ||
        !refusal.includes('settings')
      ) {
        fail(
          `up without crossSessionInbound did not refuse naming the setting and its file\n${refusal}`,
        );
      }
      const settingsFile = join(sb.home, '.claude', 'settings.json');
      mkdirSync(dirname(settingsFile), { recursive: true });
      writeFileSync(settingsFile, JSON.stringify({ crossSessionInbound: 'accept' }));
      // Without the other operator inputs: the lines name each missing piece and its fix.
      const first = parseHierarchy(hierarchy('up'));
      const firstProblems = upProblemLines(first.lines);
      if (
        !firstProblems.some(
          (l) => l.startsWith('webhook: off') && l.includes('AI_SDLC_WEBHOOK_SECRET'),
        )
      ) {
        fail(
          `up without AI_SDLC_WEBHOOK_SECRET did not print the webhook: off line\n${first.lines.join('\n')}`,
        );
      }
      for (const line of expectedOff) {
        if (!first.lines.includes(`warning: ${line}`)) {
          fail(`up did not name the missing merge piece: ${line}\n${first.lines.join('\n')}`);
        }
      }
      console.log(
        `    without operator inputs: ${firstProblems.length} line(s) name the missing piece`,
      );
      for (const l of firstProblems) console.log(`      ${l.slice(0, 110)}`);
      // Operator inputs: the merge keys (only when the scaffold default is merging off) and the secret.
      if (expectedOff.length > 0 && process.env.BOOTSTRAP_SKIP_MERGE_KEYS !== '1') {
        let text = readFileSync(rolePath, 'utf8');
        text = text
          .replace(/^(\s*)allowMerge:.*$/m, '$1allowMerge: onGreenClean')
          .replace(/^(\s*)mergeAuthors:.*$/m, `$1mergeAuthors: [${AUTHOR}]`)
          .replace(/^(\s*)operational:.*$/m, '$1operational: [land-eligible-prs]');
        writeFileSync(rolePath, text);
        const after = mergeOffLines(parseOperationalPolicy(text));
        if (after.length)
          fail(`the merge keys are still off after the operator edit: ${after.join('; ')}`);
        commitAll(sbx, 'chore: operator turns merging on');
      } else if (expectedOff.length === 0) {
        console.log('    scaffold default is merging on: merge keys need no edit');
      }
      const second = parseHierarchy(
        hierarchy(
          'up',
          process.env.BOOTSTRAP_SKIP_SECRET === '1'
            ? {}
            : { AI_SDLC_WEBHOOK_SECRET: 'bootstrap-secret' },
        ),
      );
      const extra = process.env.BOOTSTRAP_UP_WARNING;
      const lines = extra ? [...second.lines, extra] : second.lines;
      const problems = upProblemLines(lines);
      if (problems.length)
        fail(`up with the operator inputs still printed:\n${problems.join('\n')}`);
    },
    // 5
    async () => {
      const configText = existsSync(join(sb.work, 'backlog', 'config.yml'))
        ? readFileSync(join(sb.work, 'backlog', 'config.yml'), 'utf8')
        : '';
      const prefix =
        /^task_prefix:\s*['"]?([A-Za-z][A-Za-z0-9]*)['"]?\s*$/m.exec(configText)?.[1] ?? 'AISDLC';
      ctx.taskId = `${prefix.toUpperCase()}-1`;
      mkdirSync(join(sb.work, 'backlog', 'tasks'), { recursive: true });
      writeFileSync(
        join(sb.work, 'backlog', 'tasks', `${ctx.taskId.toLowerCase()} - add greeting.md`),
        `---\nid: ${ctx.taskId}\ntitle: add greeting\nstatus: To Do\nassignee: []\ncreated_date: '2026-11-19'\nlabels: []\ndependencies: []\npriority: low\n---\n\n## Description\n\nAdd a greet function to index.js.\n\n## Acceptance Criteria\n\n- [ ] index.js exports greet()\n`,
      );
      commitAll(sbx, `chore: file task ${ctx.taskId}`);
      const tick = node([
        join(ROOT, 'pipeline-cli', 'bin', 'cli-orchestrator.mjs'),
        'tick',
        '--spawner',
        'mock',
        '--dry-run',
        '--work-dir',
        sb.work,
      ]);
      let candidates = 0;
      try {
        candidates = JSON.parse(tick.stdout.slice(tick.stdout.indexOf('{'))).tick.candidates;
      } catch {
        // reported below
      }
      if (tick.status !== 0 || candidates < 1) {
        fail(`cli-orchestrator tick found no frontier task\n${tick.stdout}\n${tick.stderr}`);
      }
      // `cli-file task --pr` writes this one-entry brief (AISDLC-930); the tick ingests it.
      const { writeAutoBrief } = await import(
        pathToFileURL(join(pipelineDist, 'hierarchy', 'auto-brief.js')).href
      );
      const taskFile = join(
        sb.work,
        'backlog',
        'tasks',
        `${ctx.taskId.toLowerCase()} - add greeting.md`,
      );
      if (!writeAutoBrief(sb.work, taskFile, boardDir))
        fail(`no brief was written for ${ctx.taskId}`);
      const h = parseHierarchy(hierarchy('tick'));
      if (h.result.code !== 0)
        fail(`cli-hierarchy tick exited ${h.result.code}\n${h.lines.join('\n')}`);
      const tickJson = h.lines.find((l) => l.startsWith('{"blockers"'));
      const ingested = tickJson
        ? (JSON.parse(tickJson).ingested ?? []).flatMap((i) => i.tasks)
        : [];
      if (!ingested.includes(ctx.taskId)) {
        fail(
          `cli-hierarchy tick did not ingest ${ctx.taskId} into the board queue\n${h.lines.join('\n')}`,
        );
      }
    },
    // 6
    () => {
      const run = node(
        [join(ROOT, 'scripts', 'first-run-smoke-pipeline.mjs'), sb.work, ctx.taskId, pipelineDist],
        { env: { ...env, BOOTSTRAP_SMOKE_GH: '1' } },
      );
      if (run.status !== 0) fail(`offline pipeline run failed\n${run.stdout}\n${run.stderr}`);
      const result = JSON.parse(run.stdout.trim().split('\n').pop());
      if (!result.branch || !result.commit)
        fail(`pipeline produced no committed branch: ${run.stdout}`);
      ctx.branch = result.branch;
      ctx.commit = result.commit;
      const remote = git('ls-remote', '--heads', 'origin', ctx.branch);
      if (!remote.includes(ctx.commit)) fail(`branch ${ctx.branch} was not pushed to origin`);
      const create = readCalls().find(
        (c) => c.args[0] === 'pr' && c.args[1] === 'create' && c.args.includes(ctx.branch),
      );
      if (!create) fail(`the fake gh recorded no \`pr create\` for ${ctx.branch}`);
      ctx.pr = readState().prs.find((p) => p.headRefName === ctx.branch)?.number ?? 0;
      if (!ctx.pr) fail(`the fake gh holds no pull request for ${ctx.branch}`);
    },
    // 7
    async () => {
      // The next-step writer (verdict-ref-push.ts) builds the record from Step 8's draft; this
      // run keeps the ref in the scratch repository and never pushes it anywhere.
      const { buildVerdictRefspec } = await import(
        pathToFileURL(join(pipelineDist, 'next-step', 'verdict-ref-push.js')).href
      );
      // Step 8's own draft builder, fed the approvals the mock reviewers gave in the pipeline leg.
      const { buildVerdictRecordDraft } = await import(
        pathToFileURL(join(pipelineDist, 'steps', '08-aggregate-verdicts.js')).href
      );
      const approvals = ['correctness-reviewer', 'security-reviewer'].map((agentId) => ({
        agentId,
        harness: 'claude-code',
        approved: true,
        findings: [],
      }));
      const draft = buildVerdictRecordDraft(
        { approved: true, verdicts: approvals },
        { changedPaths: ['index.js'] },
      );
      if (!draft) fail('Step 8 built no verdict record draft for an approved verdict');
      const { defaultRunner } = await import(pathToFileURL(join(pipelineDist, 'index.js')).href);
      const wt = worktreeOf(ctx.branch);
      // The writer parses owner/name from a GitHub remote URL; the scratch remote is a local
      // path, so only that one read is answered with the repository's GitHub address.
      const runner = (cmd, args, opts) =>
        cmd === 'git' && args.join(' ') === 'config --get remote.origin.url'
          ? Promise.resolve({ stdout: `https://github.com/${SLUG}.git\n`, stderr: '', code: 0 })
          : defaultRunner(cmd, args, { ...opts, env });
      const built = await buildVerdictRefspec(runner, wt, draft, 'origin/main', new Date(), ctx.pr);
      if (!built.refspec) fail(`the verdict writer wrote no record: ${built.note}`);
      const [commit, ref] = built.refspec.split(':');
      git('update-ref', ref, commit);
      const refs = git('for-each-ref', '--format=%(refname)', 'refs/ai-sdlc/verdicts/');
      if (!refs.split('\n').includes(`refs/ai-sdlc/verdicts/${ctx.commit}`)) {
        fail(`no verdict record under refs/ai-sdlc/verdicts/ for head ${ctx.commit}\n${refs}`);
      }
    },
    // 8
    () => {
      // CI posts the required checks, and the pull request is marked ready after the reviewers sign.
      writeFileSync(statePath, JSON.stringify({ ...readState(), checks: 'SUCCESS' }, null, 2));
      const ready = spawnSync('gh', ['pr', 'ready', String(ctx.pr)], {
        cwd: sb.work,
        env,
        encoding: 'utf8',
      });
      if (ready.status !== 0) fail(`gh pr ready failed: ${ready.stderr}`);
      const r = node([
        join(ROOT, 'pipeline-cli', 'bin', 'cli-merge-if-eligible.mjs'),
        String(ctx.pr),
        '--source-kind',
        'backlog',
        '--dry-run',
      ]);
      if (
        r.status !== 0 ||
        !/eligible/i.test(r.stdout + r.stderr) ||
        /not eligible|refus/i.test(r.stdout + r.stderr)
      ) {
        fail(
          `cli-merge-if-eligible did not report the pull request eligible (exit ${r.status})\n${r.stdout}\n${r.stderr}`,
        );
      }
    },
    // 9
    () => {
      const scaffoldEmpty = mergeOffLines(
        parseOperationalPolicy(readFileSync(join(policyRoot, 'agent-role.yaml'), 'utf8')),
      ).some((l) => l.includes('mergeAuthors'));
      if (scaffoldEmpty) {
        const empty = parseHierarchy(hierarchy('land', {}, ['--policy-root', policyRoot])).result;
        if (!empty.disabled || !empty.disabled.includes('mergeAuthors')) {
          fail(
            `landing with an empty merge-author list did not name mergeAuthors: ${JSON.stringify(empty)}`,
          );
        }
        if (empty.landed.length)
          fail('landing landed a pull request with an empty merge-author list');
        console.log(`    landing note: ${empty.disabled.slice(0, 90)}`);
      }
      if (process.env.BOOTSTRAP_LAND_EMPTY === '1') {
        writeFileSync(
          join(policyRoot, 'agent-role.yaml'),
          'spec:\n  governance:\n    mergeAuthors: []\n',
        );
      }
      const landArgs =
        process.env.BOOTSTRAP_LAND_EMPTY === '1' ? ['--policy-root', policyRoot] : [];
      const report = parseHierarchy(hierarchy('land', {}, landArgs)).result;
      if (!report.landed?.some((l) => l.pr === ctx.pr)) {
        fail(`the landing pass did not land pull request ${ctx.pr}: ${JSON.stringify(report)}`);
      }
      const merged = readCalls().some(
        (c) => c.args[0] === 'pr' && c.args[1] === 'merge' && c.args[2] === String(ctx.pr),
      );
      if (!merged || readState().prs.find((p) => p.number === ctx.pr)?.state !== 'MERGED') {
        fail(`the fake gh recorded no merge of pull request ${ctx.pr}`);
      }
    },
  ];

  let failure;
  try {
    for (const [i, run] of stages.entries()) {
      const n = i + 1;
      const name = STAGES[i];
      if (seamMatches(process.env.BOOTSTRAP_SKIP_STAGE, n, name)) continue;
      console.log(`[bootstrap-smoke] stage ${n} ${name}`);
      await run();
      const unknown = unknownCalls(readCalls().slice(callsSeen));
      callsSeen = readCalls().length;
      if (unknown.length) fail(`the fake gh does not know: ${unknown.join('; ')}`);
      ran.push(name);
      console.log('[bootstrap-smoke]   ok');
    }
  } catch (err) {
    failure = err;
  } finally {
    if (process.env.BOOTSTRAP_KEEP === '1') console.log(`[bootstrap-smoke] kept ${sb.base}`);
    else rmSync(sb.base, { recursive: true, force: true });
  }
  const missing = missingStages(ran);
  if (failure) {
    const note = missing.length ? `\nstages that did not run: ${missing.join(', ')}` : '';
    throw new Error(`${failure.message}${note}`);
  }
  if (missing.length) throw new Error(`stages that did not run: ${missing.join(', ')}`);
  const elapsed = Date.now() - started;
  if (elapsed > BUDGET_MS)
    fail(`bootstrap smoke took ${Math.round(elapsed / 1000)}s, over the 5 minute budget`);
  console.log(`[bootstrap-smoke] PASS in ${(elapsed / 1000).toFixed(1)}s`);
}

function listFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBootstrap().catch((err) => {
    console.error(`[bootstrap-smoke] FAIL: ${err.message}`);
    process.exit(1);
  });
}
