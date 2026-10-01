import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readModelCalls, type ModelCallRecord } from '@ai-sdlc/reference';
import {
  defaultProjectsDir,
  ingestClaudeTranscripts,
  isIngestSwitchedOff,
} from './ingest-claude.js';

const BODY = 'SENTINEL-BODY-TEXT-MUST-NEVER-BE-STORED';
const DESCRIPTION = 'SENTINEL-DESCRIPTION-MUST-NEVER-BE-STORED';

let root: string;
let projects: string;
let usage: string;
let home: string;

function mkRepo(path: string): string {
  mkdirSync(join(path, '.ai-sdlc'), { recursive: true });
  mkdirSync(join(path, '.git'), { recursive: true });
  return path;
}

interface LineOpts {
  id: string;
  ts?: string;
  cwd?: string;
  branch?: string;
  sessionId?: string;
  agentId?: string;
  out?: number;
  entrypoint?: string | null;
  usage?: Record<string, unknown>;
  model?: string;
}

function assistant(o: LineOpts): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: o.ts ?? '2026-09-02T10:00:00.000Z',
    sessionId: o.sessionId ?? 'sess1',
    requestId: `req-${o.id}`,
    cwd: o.cwd,
    gitBranch: o.branch,
    agentId: o.agentId,
    isSidechain: o.agentId !== undefined,
    ...(o.entrypoint === null ? {} : { entrypoint: o.entrypoint ?? 'cli' }),
    message: {
      id: o.id,
      model: o.model ?? 'claude-sonnet-4-5',
      content: [{ type: 'text', text: BODY }],
      usage: o.usage ?? {
        input_tokens: 5,
        output_tokens: o.out ?? 10,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 7,
        cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 3 },
        output_tokens_details: { thinking_tokens: 2 },
      },
    },
    futureUnknownField: { nested: true },
  });
}

function writeSession(project: string, session: string, lines: string[]): string {
  const dir = join(projects, project);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${session}.jsonl`);
  writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
  return file;
}

function writeSubagent(
  project: string,
  session: string,
  agentId: string,
  lines: string[],
  sidecar?: unknown,
): string {
  const dir = join(projects, project, session, 'subagents');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `agent-${agentId}.jsonl`);
  writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
  if (sidecar !== undefined) {
    writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(sidecar));
  }
  return file;
}

async function ledger(): Promise<ModelCallRecord[]> {
  const out: ModelCallRecord[] = [];
  for await (const r of readModelCalls({}, { dir: usage })) out.push(r);
  return out;
}

function ingest(extra: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) {
  return ingestClaudeTranscripts({
    projectsDir: projects,
    usageDir: usage,
    homeDir: home,
    env,
    ...extra,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'usage-ingest-'));
  projects = join(root, 'projects');
  usage = join(root, 'usage');
  home = join(root, 'home');
  mkdirSync(projects, { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('ingestClaudeTranscripts', () => {
  it('ingests a session and two subagent transcripts with roles from sidecars', async () => {
    const repo = mkRepo(join(root, 'work', 'myrepo'));
    writeSession('p1', 'sess1', [
      assistant({ id: 'm1', cwd: repo }),
      assistant({ id: 'm2', cwd: repo }),
    ]);
    writeSubagent('p1', 'sess1', 'aaa', [assistant({ id: 's1', cwd: repo, agentId: 'aaa' })], {
      agentType: 'ai-sdlc:developer',
      description: DESCRIPTION,
    });
    writeSubagent('p1', 'sess1', 'bbb', [assistant({ id: 's2', cwd: repo, agentId: 'bbb' })]);

    const res = await ingest();
    expect(res).toMatchObject({ filesScanned: 3, callsWritten: 4, repeatsSkipped: 0, errors: 0 });

    const byId = new Map((await ledger()).map((r) => [r.callId, r]));
    expect(byId.get('m1')?.agentRole).toBe('main-session');
    expect(byId.get('m1')?.agentId).toBeUndefined();
    expect(byId.get('s1')?.agentRole).toBe('ai-sdlc:developer');
    expect(byId.get('s1')?.agentId).toBe('aaa');
    expect(byId.get('s2')?.agentRole).toBe('subagent-unknown');
    expect(byId.get('m1')?.tokens).toEqual({
      input: 5,
      cacheWrite5m: 4,
      cacheWrite1h: 3,
      cacheRead: 3,
      output: 10,
      reasoning: 2,
    });
    expect(byId.get('m1')).toMatchObject({
      harness: 'claude-code',
      provider: 'anthropic',
      billingPool: 'subscription-interactive',
      requestId: 'req-m1',
      sessionId: 'sess1',
    });
  });

  it('never writes, prints or logs message text, tool output or sidecar descriptions', async () => {
    const repo = mkRepo(join(root, 'work', 'myrepo'));
    const out: string[] = [];
    const sinks = [
      vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
        out.push(String(c));
        return true;
      }),
      vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
        out.push(String(c));
        return true;
      }),
      ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
          out.push(a.map(String).join(' '));
        }),
      ),
    ];
    const toolOutput = JSON.stringify({
      type: 'user',
      cwd: repo,
      message: { content: [{ type: 'tool_result', content: `${BODY} tool output` }] },
    });
    writeSession('p1', 'sess1', [
      assistant({ id: 'm1', cwd: repo }),
      toolOutput,
      `{"type":"assistant","note":"${BODY} truncated-then-bad`,
    ]);
    // hostile oversized line carrying the canary
    appendFileSync(
      join(projects, 'p1', 'sess1.jsonl'),
      `${JSON.stringify({ type: 'user', cwd: repo, pad: `${BODY}${'x'.repeat(5 * 1024 * 1024)}` })}\n`,
    );
    writeSubagent('p1', 'sess1', 'aaa', [assistant({ id: 's1', cwd: repo, agentId: 'aaa' })], {
      agentType: 'ai-sdlc:developer',
      description: DESCRIPTION,
    });
    // missing sidecar, truncated final line
    const sub = writeSubagent('p1', 'sess1', 'bbb', [
      assistant({ id: 's2', cwd: repo, agentId: 'bbb' }),
    ]);
    appendFileSync(sub, `{"type":"assistant","message":{"content":"${BODY}`);
    writeSession('p2', 'sess2', [
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-09-02T10:00:00.000Z',
        sessionId: 'sess2',
        cwd: join(root, 'elsewhere'),
        message: {
          id: 'syn',
          model: '<synthetic>',
          content: [{ type: 'text', text: `${BODY} usage limit reached` }],
        },
      }),
    ]);
    let res;
    try {
      res = await ingest();
      await ingest({ backfill: true });
    } finally {
      for (const s of sinks) s.mockRestore();
    }
    expect(res.errors).toBeGreaterThan(0);
    expect(JSON.stringify(res)).not.toContain('SENTINEL');
    expect(out.join('\n')).not.toContain('SENTINEL');
    for (const rel of readdirSync(usage, { recursive: true }) as string[]) {
      const full = join(usage, rel);
      if (!statSync(full).isFile()) continue;
      expect(readFileSync(full, 'utf-8'), rel).not.toContain('SENTINEL');
    }
  });

  it('collapses a message repeated on three lines into one record and keeps the largest output', async () => {
    const repo = mkRepo(join(root, 'work', 'myrepo'));
    writeSession('p1', 'sess1', [
      assistant({ id: 'dup', cwd: repo, out: 1 }),
      assistant({ id: 'dup', cwd: repo, out: 50 }),
      assistant({ id: 'dup', cwd: repo, out: 20 }),
    ]);
    const res = await ingest();
    expect(res.callsWritten).toBe(1);
    expect(res.repeatsSkipped).toBe(2);
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokens.output).toBe(50);
  });

  it('writes nothing on a second run and ingests only appended calls after that', async () => {
    const repo = mkRepo(join(root, 'work', 'myrepo'));
    const file = writeSession('p1', 'sess1', [assistant({ id: 'm1', cwd: repo })]);
    expect((await ingest()).callsWritten).toBe(1);
    const again = await ingest();
    expect(again).toMatchObject({ callsWritten: 0, repeatsSkipped: 0, errors: 0 });
    appendFileSync(file, `${assistant({ id: 'm2', cwd: repo })}\n`);
    const third = await ingest();
    expect(third.callsWritten).toBe(1);
    expect((await ledger()).map((r) => r.callId).sort()).toEqual(['m1', 'm2']);
  });

  it('tolerates a truncated last line and retries it once complete', async () => {
    const repo = mkRepo(join(root, 'work', 'myrepo'));
    const file = writeSession('p1', 'sess1', [assistant({ id: 'm1', cwd: repo })]);
    const full = assistant({ id: 'm2', cwd: repo });
    appendFileSync(file, full.slice(0, 40));
    const first = await ingest();
    expect(first).toMatchObject({ callsWritten: 1, errors: 0 });
    appendFileSync(file, `${full.slice(40)}\n`);
    const second = await ingest();
    expect(second).toMatchObject({ callsWritten: 1, errors: 0 });
    expect((await ledger()).map((r) => r.callId).sort()).toEqual(['m1', 'm2']);
  });

  it('counts a corrupt complete line as an error and keeps going', async () => {
    const repo = mkRepo(join(root, 'work', 'myrepo'));
    writeSession('p1', 'sess1', ['{not json', assistant({ id: 'm1', cwd: repo })]);
    const res = await ingest();
    expect(res).toMatchObject({ callsWritten: 1, errors: 1 });
  });

  it('resets the cursor when a file shrinks', async () => {
    const repo = mkRepo(join(root, 'work', 'myrepo'));
    const file = writeSession('p1', 'sess1', [
      assistant({ id: 'm1', cwd: repo }),
      assistant({ id: 'm2', cwd: repo }),
    ]);
    await ingest();
    // rotate: replace with a shorter file holding a new call
    writeFileSync(file, `${assistant({ id: 'm3', cwd: repo })}\n`);
    truncateSync(file, readFileSync(file).length);
    const res = await ingest();
    expect(res.callsWritten).toBe(1);
    expect((await ledger()).map((r) => r.callId).sort()).toEqual(['m1', 'm2', 'm3']);
  });

  it('--backfill re-reads from the start but dedup keeps the ledger unchanged', async () => {
    const repo = mkRepo(join(root, 'work', 'myrepo'));
    writeSession('p1', 'sess1', [assistant({ id: 'm1', cwd: repo })]);
    await ingest();
    const res = await ingest({ backfill: true });
    expect(res).toMatchObject({ callsWritten: 0, repeatsSkipped: 1 });
  });

  it('attributes framework calls with repo and a task from the worktree segment', async () => {
    const repo = mkRepo(join(root, 'work', 'myrepo'));
    const wt = mkRepo(join(repo, '.worktrees', 'aisdlc-649'));
    writeSession('p1', 'sess1', [
      assistant({ id: 'f1', cwd: join(wt, 'pipeline-cli') }),
      assistant({ id: 'f2', cwd: repo }),
    ]);
    await ingest();
    const byId = new Map((await ledger()).map((r) => [r.callId, r]));
    expect(byId.get('f1')).toMatchObject({
      scope: 'framework',
      repo: 'myrepo',
      taskId: 'AISDLC-649',
    });
    expect(byId.get('f1')?.source?.file).toContain('sess1.jsonl');
    expect(byId.get('f2')).toMatchObject({ scope: 'framework', repo: 'myrepo' });
    expect(byId.get('f2')?.taskId).toBeUndefined();
  });

  it('resolves a task from the branch name (known id) and from the sentinel', async () => {
    const repo = mkRepo(join(root, 'work', 'myrepo'));
    mkdirSync(join(repo, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(join(repo, 'backlog', 'tasks', 'aisdlc-12 - thing.md'), 'x');
    writeFileSync(join(repo, '.active-task'), 'AISDLC-77\n');
    writeSession('p1', 'sess1', [
      assistant({ id: 'b1', cwd: repo, branch: 'feat/rfc-0050-aisdlc-12-thing' }),
      assistant({ id: 'b2', cwd: repo, branch: 'main' }),
    ]);
    await ingest();
    const byId = new Map((await ledger()).map((r) => [r.callId, r]));
    expect(byId.get('b1')?.taskId).toBe('AISDLC-12');
    expect(byId.get('b2')?.taskId).toBe('AISDLC-77');
  });

  it('writes other-scope records with none of repo, task, source, cwd, branch or description', async () => {
    const other = join(root, 'elsewhere', 'secret-project-dir');
    mkdirSync(other, { recursive: true });
    writeSession('p9', 'sess9', [
      assistant({ id: 'o1', cwd: other, branch: 'feat/aisdlc-5-private' }),
    ]);
    writeSubagent('p9', 'sess9', 'ccc', [assistant({ id: 'o2', cwd: other, agentId: 'ccc' })], {
      agentType: 'x:y',
      description: DESCRIPTION,
    });
    await ingest();
    const rows = await ledger();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.scope).toBe('other');
      for (const field of [
        'repo',
        'taskId',
        'source',
        'cwd',
        'gitBranch',
        'branch',
        'description',
      ]) {
        expect(Object.keys(r), field).not.toContain(field);
      }
      const json = JSON.stringify(r);
      expect(json).not.toContain(other);
      expect(json).not.toContain('secret-project-dir');
      expect(json).not.toContain('aisdlc-5-private');
      expect(json).not.toContain(DESCRIPTION);
    }
    const raw = readFileSync(join(usage, 'ledger-2026-09.jsonl'), 'utf-8');
    expect(raw).not.toContain('secret-project-dir');
    // every file written under the usage dir, including limit events
    for (const name of readdirSync(usage)) {
      const text = readFileSync(join(usage, name), 'utf-8');
      for (const literal of [other, 'secret-project-dir', 'feat/aisdlc-5-private', DESCRIPTION]) {
        expect(text, `${name} leaks ${literal}`).not.toContain(literal);
      }
    }
    // cursors must not leak the transcript path either
    expect(readFileSync(join(usage, 'cursors.json'), 'utf-8')).not.toContain('p9');
  });

  it('framework-only skips other-scope transcripts entirely', async () => {
    const repo = mkRepo(join(root, 'work', 'myrepo'));
    const other = join(root, 'elsewhere');
    mkdirSync(other, { recursive: true });
    writeSession('p1', 'sess1', [assistant({ id: 'f1', cwd: repo })]);
    writeSession('p2', 'sess2', [
      JSON.stringify({ type: 'user', cwd: other, message: { content: BODY } }),
      assistant({ id: 'o1', cwd: other }),
    ]);
    const res = await ingest({}, { AI_SDLC_USAGE_SCOPE: 'framework-only' });
    expect(res.callsWritten).toBe(1);
    expect((await ledger()).every((r) => r.scope === 'framework')).toBe(true);
    expect(res.otherScopeSkipped).toBeGreaterThan(0);
  });

  it('framework-only skips an other-scope call inside an otherwise framework transcript', async () => {
    const repo = mkRepo(join(root, 'work', 'myrepo'));
    writeSession('p1', 'sess1', [
      assistant({ id: 'f1', cwd: repo }),
      assistant({ id: 'o1', cwd: join(root, 'elsewhere') }),
    ]);
    const res = await ingest({}, { AI_SDLC_USAGE_SCOPE: 'framework-only' });
    expect(res).toMatchObject({ callsWritten: 1, otherScopeSkipped: 1 });
  });

  it('does not treat the home directory as a repository root', async () => {
    mkRepo(home); // home holds .ai-sdlc and .git, like a real operator machine
    const proj = join(home, 'proj');
    mkdirSync(proj, { recursive: true });
    writeSession('p1', 'sess1', [assistant({ id: 'h1', cwd: proj })]);
    await ingest();
    expect((await ledger())[0]!.scope).toBe('other');
  });

  it('produces no record for synthetic lines and a text-free limit event for a limit notice', async () => {
    const repo = mkRepo(join(root, 'work', 'myrepo'));
    const synthetic = (id: string, text: string): string =>
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-09-02T11:00:00.000Z',
        sessionId: 'sess1',
        cwd: repo,
        message: {
          id,
          model: '<synthetic>',
          content: [{ type: 'text', text }],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    writeSession('p1', 'sess1', [
      synthetic('x1', `${BODY} Claude usage limit reached`),
      synthetic('x2', `${BODY} some other error`),
      synthetic('x3', `${BODY} rate limit exceeded`),
    ]);
    const res = await ingest();
    expect(res.callsWritten).toBe(0);
    expect(res.limitEvents).toBe(2);
    const events = readFileSync(join(usage, 'limit-events.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(events).toEqual([
      { ts: '2026-09-02T11:00:00.000Z', sessionId: 'sess1', category: 'usage-limit' },
      { ts: '2026-09-02T11:00:00.000Z', sessionId: 'sess1', category: 'rate-limit' },
    ]);
    expect(readFileSync(join(usage, 'limit-events.jsonl'), 'utf-8')).not.toContain('SENTINEL');
    // a backfill does not duplicate the events
    expect((await ingest({ backfill: true })).limitEvents).toBe(0);
    expect(await ledger()).toHaveLength(0);
  });

  it('maps billing pool from the entrypoint and never guesses', async () => {
    const repo = mkRepo(join(root, 'work', 'myrepo'));
    writeSession('p1', 'sess1', [
      assistant({ id: 'e1', cwd: repo, entrypoint: 'cli' }),
      assistant({ id: 'e2', cwd: repo, entrypoint: 'sdk-cli' }),
      assistant({ id: 'e3', cwd: repo, entrypoint: null }),
      assistant({ id: 'e4', cwd: repo, entrypoint: 'something-new' }),
    ]);
    await ingest();
    const pools = Object.fromEntries((await ledger()).map((r) => [r.callId, r.billingPool]));
    expect(pools).toEqual({
      e1: 'subscription-interactive',
      e2: 'agent-sdk-credit',
      e3: 'unknown',
      e4: 'unknown',
    });
  });

  it('puts the combined cache-creation count in the 5m class when no split is given', async () => {
    const repo = mkRepo(join(root, 'work', 'myrepo'));
    writeSession('p1', 'sess1', [
      assistant({
        id: 'c1',
        cwd: repo,
        usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 9 },
      }),
    ]);
    await ingest();
    expect((await ledger())[0]!.tokens).toEqual({
      input: 1,
      cacheWrite5m: 9,
      cacheWrite1h: 0,
      cacheRead: 0,
      output: 2,
    });
  });

  it('does nothing in a remote sandbox and when switched off', async () => {
    const repo = mkRepo(join(root, 'work', 'myrepo'));
    writeSession('p1', 'sess1', [assistant({ id: 'm1', cwd: repo })]);
    for (const env of [
      { CLAUDE_CODE_ENV: 'ccr' },
      { CLAUDE_REMOTE_EXECUTION: '1' },
      { AI_SDLC_USAGE_INGEST: 'off' },
    ]) {
      const res = await ingest({}, env);
      expect(res.callsWritten).toBe(0);
      expect(res.filesScanned).toBe(0);
      expect(res.disabled).toBeDefined();
    }
    expect(await ledger()).toHaveLength(0);
    expect(isIngestSwitchedOff({ AI_SDLC_USAGE_INGEST: 'Off' })).toBe(true);
    expect(isIngestSwitchedOff({})).toBe(false);
  });

  it('does not follow symlinked projects, session files or subagent dirs', async () => {
    const repo = mkRepo(join(root, 'work', 'myrepo'));
    const outside = join(root, 'outside');
    mkdirSync(join(outside, 'sess', 'subagents'), { recursive: true });
    writeFileSync(join(outside, 'x.jsonl'), `${assistant({ id: 'leak1', cwd: repo })}\n`);
    writeFileSync(
      join(outside, 'sess', 'subagents', 'agent-zzz.jsonl'),
      `${assistant({ id: 'leak2', cwd: repo })}\n`,
    );
    symlinkSync(outside, join(projects, 'linked-project'));
    mkdirSync(join(projects, 'real'), { recursive: true });
    symlinkSync(join(outside, 'x.jsonl'), join(projects, 'real', 'linkedfile.jsonl'));
    symlinkSync(join(outside, 'sess'), join(projects, 'real', 'sess'));
    const res = await ingest();
    expect(res.filesScanned).toBe(0);
    expect(await ledger()).toHaveLength(0);
  });

  it('ignores files and sidecars with unsafe names or values', async () => {
    const repo = mkRepo(join(root, 'work', 'myrepo'));
    const dir = join(projects, 'p1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad name!.jsonl'), `${assistant({ id: 'bad', cwd: repo })}\n`);
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeSubagent('p1', 'sess1', 'ddd', [assistant({ id: 'u1', cwd: repo, agentId: 'ddd' })], {
      agentType: '../../etc/passwd',
    });
    writeSubagent('p1', 'sess1', 'eee', [assistant({ id: 'u2', cwd: repo, agentId: 'eee' })]);
    writeFileSync(join(projects, 'p1', 'sess1', 'subagents', 'agent-eee.meta.json'), '{broken');
    await ingest();
    const byId = new Map((await ledger()).map((r) => [r.callId, r]));
    expect(byId.has('bad')).toBe(false);
    expect(byId.get('u1')?.agentRole).toBe('subagent-unknown');
    expect(byId.get('u2')?.agentRole).toBe('subagent-unknown');
  });

  it('drops oversized lines as errors without exhausting memory', async () => {
    const repo = mkRepo(join(root, 'work', 'myrepo'));
    const huge = JSON.stringify({ type: 'user', cwd: repo, pad: 'x'.repeat(5 * 1024 * 1024) });
    writeSession('p1', 'sess1', [huge, assistant({ id: 'm1', cwd: repo })]);
    const res = await ingest();
    expect(res).toMatchObject({ callsWritten: 1, errors: 1 });
  });

  it('rejects records with unusable ids or timestamps as errors', async () => {
    const repo = mkRepo(join(root, 'work', 'myrepo'));
    const bad = JSON.parse(assistant({ id: 'x', cwd: repo })) as {
      message: { id: string };
      timestamp: string;
    };
    bad.message.id = 'has\nnewline';
    const badTs = JSON.parse(assistant({ id: 'y', cwd: repo })) as {
      message: { id: string };
      timestamp: string;
    };
    badTs.timestamp = 'not a date';
    writeSession('p1', 'sess1', [JSON.stringify(bad), JSON.stringify(badTs)]);
    const res = await ingest();
    expect(res).toMatchObject({ callsWritten: 0, errors: 2 });
  });

  it('stops at the time limit and resumes on the next run', async () => {
    const repo = mkRepo(join(root, 'work', 'myrepo'));
    for (let i = 0; i < 5; i++) {
      writeSession(`p${i}`, `s${i}`, [assistant({ id: `t${i}`, cwd: repo })]);
    }
    let t = 0;
    const first = await ingest({ maxSeconds: 1, now: () => (t += 600) });
    expect(first.timedOut).toBe(true);
    expect(first.filesScanned).toBeLessThan(5);
    const second = await ingest();
    expect(second.timedOut).toBe(false);
    expect((await ledger()).length).toBe(5);
  });

  it('falls back to the default time limit when max-seconds is not a usable number', async () => {
    const repo = mkRepo(join(root, 'work', 'myrepo'));
    writeSession('p1', 'sess1', [assistant({ id: 'm1', cwd: repo })]);
    let t = 0;
    // a NaN limit must not disable the limit: with a 1ms-per-read clock the default (30s) is not hit
    const res = await ingest({ maxSeconds: Number.NaN, now: () => (t += 1) });
    expect(res.timedOut).toBe(false);
    expect(res.callsWritten).toBe(1);
    // a limit of 0 or negative also falls back to the default instead of expiring at once
    expect((await ingest({ maxSeconds: -5, backfill: true, now: () => (t += 1) })).timedOut).toBe(
      false,
    );
    // and an enormous clock jump still stops a NaN-limited run at the default limit
    let jump = 0;
    const stopped = await ingest({
      maxSeconds: Number.NaN,
      backfill: true,
      now: () => (jump += 60_000),
    });
    expect(stopped.timedOut).toBe(true);
  });

  it('handles an absent projects directory', async () => {
    const res = await ingest({ projectsDir: join(root, 'nope') });
    expect(res).toMatchObject({ filesScanned: 0, callsWritten: 0 });
  });

  it('keeps going when the ledger cannot be written', async () => {
    const repo = mkRepo(join(root, 'work', 'myrepo'));
    writeSession('p1', 'sess1', [assistant({ id: 'm1', cwd: repo })]);
    // a regular file where the usage dir should be makes every write fail
    writeFileSync(usage, 'not a directory');
    const res = await ingest();
    expect(res.callsWritten).toBe(0);
    expect(res.errors).toBeGreaterThan(0);
  });
});

describe('defaultProjectsDir', () => {
  it('honours CLAUDE_CONFIG_DIR and falls back to the home default', () => {
    expect(defaultProjectsDir({ CLAUDE_CONFIG_DIR: '/cfg' }, '/h')).toBe(join('/cfg', 'projects'));
    expect(defaultProjectsDir({}, '/h')).toBe(join('/h', '.claude', 'projects'));
  });
});

describe('large projects directory', () => {
  it('ingests 500 synthetic transcripts within the time limit and then has nothing new', async () => {
    const repo = mkRepo(join(root, 'work', 'myrepo'));
    for (let i = 0; i < 500; i++) {
      writeSession(`p${i % 25}`, `s${i}`, [
        assistant({ id: `big-${i}-a`, cwd: repo, sessionId: `s${i}` }),
        assistant({ id: `big-${i}-b`, cwd: repo, sessionId: `s${i}` }),
      ]);
    }
    const started = Date.now();
    const first = await ingest({ maxSeconds: 20 });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(first).toMatchObject({ filesScanned: 500, callsWritten: 1000, timedOut: false });
    const second = await ingest({ maxSeconds: 20 });
    expect(second).toMatchObject({ filesScanned: 500, callsWritten: 0 });
  }, 60_000);
});
