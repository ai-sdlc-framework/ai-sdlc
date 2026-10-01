/**
 * Claude Code transcript ingester.
 *
 * Walks the harness's projects directory and turns every model call found in a
 * session or subagent transcript into a usage-ledger record, through the
 * ledger store (dedup by message id, byte-offset cursors).
 *
 * The ledger holds counts, ids and attribution only. Message text is never
 * read into a record, logged or returned; a synthetic limit notice yields only
 * a timestamp, a session id and a short fixed category.
 *
 * Untrusted-input rules: file names are validated before use, symlinks are not
 * followed, lines and per-run bytes are capped, and a failure in one file never
 * stops the run.
 */

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  lstatSync,
  type Stats,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  readSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BillingPool, ModelCallRecord, UsageStoreOptions } from '@ai-sdlc/reference';
import { AttributionResolver } from './attribution.js';
import {
  billingPoolFor,
  parseTranscriptLine,
  peekCwd,
  type LimitCategory,
  type ParsedCall,
} from './claude-transcript.js';
import { readLines } from './line-reader.js';
import { isReplayWorktreeCwd } from './replay-git.js';

const SESSION_FILE = /^([A-Za-z0-9_-]{1,128})\.jsonl$/;
const SUBAGENT_FILE = /^agent-([A-Za-z0-9_-]{1,128})\.jsonl$/;
const AGENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,99}$/;
const SIDECAR_MAX_BYTES = 64 * 1024;
const BATCH_LIMIT = 2000;
const NORMAL_RUN_BYTES_PER_FILE = 256 * 1024 * 1024;
const BACKFILL_BYTES_PER_FILE = 8 * 1024 * 1024 * 1024;
const LIMIT_EVENTS_FILE = 'limit-events.jsonl';
const LIMIT_EVENTS_READ_CAP = 8 * 1024 * 1024;
const DEADLINE_CHECK_EVERY = 256;

export const DEFAULT_MAX_SECONDS = 30;

export type IngestDisabledReason = 'remote-sandbox' | 'switched-off';

export interface IngestOptions {
  /** Projects directory to walk. Defaults to the harness's standard location. */
  projectsDir?: string;
  /** Ignore stored cursors and read every file from the start. */
  backfill?: boolean;
  /** Stop starting new work after this many seconds. */
  maxSeconds?: number;
  /** Usage directory override (otherwise `AI_SDLC_USAGE_DIR`, then the home default). */
  usageDir?: string;
  /** Environment to read switches from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Home directory used for defaults and never treated as a repository root. */
  homeDir?: string;
  /** Clock, for tests. */
  now?: () => number;
}

export interface IngestResult {
  filesScanned: number;
  callsWritten: number;
  repeatsSkipped: number;
  errors: number;
  limitEvents: number;
  /** Calls and whole transcripts skipped because `AI_SDLC_USAGE_SCOPE=framework-only` excludes them. */
  otherScopeSkipped: number;
  /**
   * Whole transcripts skipped because they ran inside a reviewer-replay checkout.
   * The replay records its usage directly, so ingesting the transcript would count it twice.
   */
  replayTranscriptsSkipped: number;
  timedOut: boolean;
  disabled?: IngestDisabledReason;
}

function emptyResult(): IngestResult {
  return {
    filesScanned: 0,
    callsWritten: 0,
    repeatsSkipped: 0,
    errors: 0,
    limitEvents: 0,
    otherScopeSkipped: 0,
    replayTranscriptsSkipped: 0,
    timedOut: false,
  };
}

/** True inside a remote sandbox, where the ingester must do nothing. */
export function isRemoteSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['CLAUDE_CODE_ENV'] === 'ccr' || env['CLAUDE_REMOTE_EXECUTION'] === '1';
}

/** True when the operator switched ingestion off. */
export function isIngestSwitchedOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['off', '0', 'false', 'no', 'disabled'].includes(
    (env['AI_SDLC_USAGE_INGEST'] ?? '').toLowerCase(),
  );
}

/** Default projects directory of the harness. */
export function defaultProjectsDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configDir = env['CLAUDE_CONFIG_DIR'];
  return join(configDir && configDir.length > 0 ? configDir : join(home, '.claude'), 'projects');
}

interface TranscriptFile {
  path: string;
  /** Session id taken from the file or directory name. */
  sessionStem: string;
  /** Present for a subagent transcript. */
  agentId?: string;
  /** Sidecar path for a subagent transcript. */
  sidecarPath?: string;
}

function realStat(path: string): Stats | undefined {
  try {
    const st = lstatSync(path);
    return st.isSymbolicLink() ? undefined : st;
  } catch {
    return undefined;
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

/** Every session and subagent transcript under `projectsDir`, symlinks excluded. */
function* walkTranscripts(projectsDir: string): Generator<TranscriptFile> {
  const root = realStat(projectsDir);
  if (!root?.isDirectory()) return;
  for (const projectName of listDir(projectsDir)) {
    const projectDir = join(projectsDir, projectName);
    if (!realStat(projectDir)?.isDirectory()) continue;
    for (const entry of listDir(projectDir)) {
      const entryPath = join(projectDir, entry);
      const st = realStat(entryPath);
      if (!st) continue;
      const session = SESSION_FILE.exec(entry);
      if (st.isFile() && session) {
        yield { path: entryPath, sessionStem: session[1]! };
        continue;
      }
      if (!st.isDirectory() || !/^[A-Za-z0-9_-]{1,128}$/.test(entry)) continue;
      const subDir = join(entryPath, 'subagents');
      if (!realStat(subDir)?.isDirectory()) continue;
      for (const name of listDir(subDir)) {
        const m = SUBAGENT_FILE.exec(name);
        const filePath = join(subDir, name);
        if (!m || !realStat(filePath)?.isFile()) continue;
        yield {
          path: filePath,
          sessionStem: entry,
          agentId: m[1]!,
          sidecarPath: join(subDir, `agent-${m[1]!}.meta.json`),
        };
      }
    }
  }
}

/** Agent role from the sidecar's `agentType`; the description is never read out. */
function readAgentRole(sidecarPath: string | undefined): string {
  const unknown = 'subagent-unknown';
  if (!sidecarPath) return unknown;
  const st = realStat(sidecarPath);
  if (!st?.isFile() || st.size === 0 || st.size > SIDECAR_MAX_BYTES) return unknown;
  try {
    const parsed: unknown = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
    const type =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)['agentType']
        : undefined;
    return typeof type === 'string' && AGENT_TYPE.test(type) ? type : unknown;
  } catch {
    return unknown;
  }
}

function cursorKey(path: string): string {
  return `claude-code:${createHash('sha256').update(path).digest('hex').slice(0, 32)}`;
}

interface LimitEvent {
  ts: string;
  sessionId: string;
  category: LimitCategory;
}

class LimitEventLog {
  constructor(
    private readonly dir: string,
    private readonly withLock: <T>(dir: string, fn: () => T) => T,
  ) {}

  private static key(e: LimitEvent): string {
    return `${e.ts}|${e.sessionId}|${e.category}`;
  }

  private load(): Set<string> {
    const known = new Set<string>();
    const path = join(this.dir, LIMIT_EVENTS_FILE);
    try {
      const fd = openSync(path, 'r');
      try {
        const buf = Buffer.alloc(LIMIT_EVENTS_READ_CAP);
        const n = readSync(fd, buf, 0, LIMIT_EVENTS_READ_CAP, 0);
        for (const line of buf.subarray(0, n).toString('utf-8').split('\n')) {
          try {
            const e = JSON.parse(line) as LimitEvent;
            known.add(LimitEventLog.key(e));
          } catch {
            // skip a corrupt line
          }
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      // no file yet
    }
    return known;
  }

  /**
   * Append the events not already recorded; returns how many were new. The
   * read-check-append runs under the usage directory lock, so concurrent
   * ingesters never duplicate an event.
   */
  append(events: LimitEvent[]): number {
    if (events.length === 0) return 0;
    return this.withLock(this.dir, () => {
      const known = this.load();
      const fresh: LimitEvent[] = [];
      for (const e of events) {
        const k = LimitEventLog.key(e);
        if (known.has(k)) continue;
        known.add(k);
        fresh.push({ ts: e.ts, sessionId: e.sessionId, category: e.category });
      }
      if (fresh.length === 0) return 0;
      appendFileSync(
        join(this.dir, LIMIT_EVENTS_FILE),
        fresh.map((e) => `${JSON.stringify(e)}\n`).join(''),
        { encoding: 'utf-8', mode: 0o600 },
      );
      return fresh.length;
    });
  }
}

function buildRecord(
  call: ParsedCall,
  file: TranscriptFile,
  agentRole: string,
  lineStart: number,
  resolver: AttributionResolver,
): ModelCallRecord | undefined {
  const framework = resolver.frameworkFor(call.cwd);
  const billingPool: BillingPool = billingPoolFor(call.entrypoint);
  const base: ModelCallRecord = {
    schemaVersion: 'v1',
    callId: call.callId,
    ...(call.requestId ? { requestId: call.requestId } : {}),
    ts: call.ts,
    harness: 'claude-code',
    provider: 'anthropic',
    model: call.model,
    tokens: call.tokens,
    billingPool,
    sessionId: call.sessionId ?? file.sessionStem,
    ...(file.agentId ? { agentId: file.agentId } : {}),
    agentRole,
    scope: framework ? 'framework' : 'other',
  };
  if (!framework) return base;
  const taskId = resolver.taskFor(framework, call.cwd, call.gitBranch);
  return {
    ...base,
    repo: framework.repo,
    ...(taskId ? { taskId } : {}),
    source: { file: file.path, offset: lineStart },
  };
}

/** Read new calls from every transcript and append them to the usage ledger. */
export async function ingestClaudeTranscripts(opts: IngestOptions = {}): Promise<IngestResult> {
  const env = opts.env ?? process.env;
  const result = emptyResult();
  if (isRemoteSandbox(env)) return { ...result, disabled: 'remote-sandbox' };
  if (isIngestSwitchedOff(env)) return { ...result, disabled: 'switched-off' };

  const { appendModelCalls, readCursor, writeCursor, resolveUsageDir, withUsageLock } =
    await import('@ai-sdlc/reference');

  const now = opts.now ?? Date.now;
  const seconds =
    typeof opts.maxSeconds === 'number' && Number.isFinite(opts.maxSeconds) && opts.maxSeconds > 0
      ? opts.maxSeconds
      : DEFAULT_MAX_SECONDS;
  const deadline = now() + seconds * 1000;
  const expired = (): boolean => now() >= deadline;
  const home = opts.homeDir ?? homedir();
  const storeOpts: UsageStoreOptions = opts.usageDir ? { dir: opts.usageDir } : {};
  const usageDir = resolveUsageDir(storeOpts);
  const projectsDir = opts.projectsDir ?? defaultProjectsDir(env, home);
  const frameworkOnly = (env['AI_SDLC_USAGE_SCOPE'] ?? '').toLowerCase() === 'framework-only';
  const resolver = new AttributionResolver({ homeDir: home });
  const limitLog = new LimitEventLog(usageDir, withUsageLock);
  const bytesPerFile = opts.backfill ? BACKFILL_BYTES_PER_FILE : NORMAL_RUN_BYTES_PER_FILE;

  for (const file of walkTranscripts(projectsDir)) {
    if (expired()) {
      result.timedOut = true;
      break;
    }
    const st = realStat(file.path);
    if (!st?.isFile()) continue;
    result.filesScanned++;

    try {
      const key = cursorKey(file.path);
      let start = opts.backfill ? 0 : readCursor(key, storeOpts);
      if (st.size < start) start = 0; // file shrank or was rotated
      if (start >= st.size) continue;

      const agentRole = file.sidecarPath ? readAgentRole(file.sidecarPath) : 'main-session';
      const batch = new Map<string, ModelCallRecord>();
      const limits: LimitEvent[] = [];
      let scopeDecided = !frameworkOnly;
      let cwdChecked = false;
      let skipFile = false;
      let replayFile = false;
      let lines = 0;
      let timedOutHere = false;

      const flush = (consumed: number): void => {
        if (batch.size > 0) {
          const res = appendModelCalls([...batch.values()], storeOpts);
          result.callsWritten += res.written;
          result.repeatsSkipped += res.skipped;
          result.errors += res.invalid;
          batch.clear();
        }
        result.limitEvents += limitLog.append(limits.splice(0));
        if (consumed > start || opts.backfill) writeCursor(key, consumed, storeOpts);
      };

      const read = readLines(file.path, {
        start,
        maxBytes: bytesPerFile,
        onLine: (line, lineStart, endOffset) => {
          if (++lines % DEADLINE_CHECK_EVERY === 0 && expired()) {
            timedOutHere = true;
            return false;
          }
          if (!cwdChecked || !scopeDecided) {
            const cwd = peekCwd(line);
            if (cwd !== undefined) {
              cwdChecked = true;
              if (isReplayWorktreeCwd(cwd)) {
                skipFile = true;
                replayFile = true;
                return false;
              }
              if (!scopeDecided) {
                scopeDecided = true;
                if (!resolver.frameworkFor(cwd)) {
                  skipFile = true;
                  return false;
                }
              }
            }
          }
          const parsed = parseTranscriptLine(line);
          if (parsed.kind === 'error') {
            result.errors++;
          } else if (parsed.kind === 'limit') {
            limits.push({
              ts: parsed.ts,
              sessionId: parsed.sessionId ?? file.sessionStem,
              category: parsed.category,
            });
          } else if (parsed.kind === 'call') {
            const record = buildRecord(parsed.call, file, agentRole, lineStart, resolver);
            if (record && frameworkOnly && record.scope === 'other') {
              result.otherScopeSkipped++;
            } else if (record) {
              const prior = batch.get(record.callId);
              if (prior) {
                result.repeatsSkipped++;
                // repeats of one message can carry a growing output count; keep the largest
                if (record.tokens.output > prior.tokens.output) batch.set(record.callId, record);
              } else {
                batch.set(record.callId, record);
              }
            }
          }
          if (batch.size >= BATCH_LIMIT) flush(endOffset);
          return true;
        },
      });

      result.errors += read.oversizeLines;
      if (skipFile) {
        if (replayFile) result.replayTranscriptsSkipped++;
        else result.otherScopeSkipped++;
        continue;
      }
      flush(read.consumed);
      if (timedOutHere) {
        result.timedOut = true;
        break;
      }
    } catch {
      // one unreadable file or failed write must not stop the run; it is retried next time
      result.errors++;
    }
  }
  return result;
}
