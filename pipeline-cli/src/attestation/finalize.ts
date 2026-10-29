/**
 * `cli-attestation finalize` (AISDLC-615, LOW-7): collapse the manual
 * persist -> emit-leaf (per reviewer) -> sign-v6 -> verify sequence for a
 * main-session dispatch into one idempotent call.
 *
 * Every step shells back into the same CLI through an injected `run` function, so
 * emit and sign share one patch-id (AISDLC-610) and the unit tests stay hermetic.
 *
 * @module attestation/finalize
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const DEFAULT_FINALIZE_REVIEWERS = [
  'code-reviewer',
  'test-reviewer',
  'security-reviewer',
] as const;

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run one `cli-attestation` subcommand with the given argv (subcommand first). */
export type RunFn = (args: string[]) => RunResult;

export interface FinalizeOptions {
  repoRoot: string;
  taskId: string;
  headSha: string;
  /** 40-hex patch-id used verbatim for emit-leaf and sign-v6. */
  patchId: string;
  /** 40-hex base commit passed to `verify --base`. */
  baseSha: string;
  reviewers: readonly string[];
  /** Directory holding `<reviewer>.jsonl` and `<reviewer>.verdict.json`. */
  transcriptsDir: string;
  harness: string;
  model: string;
  nonce?: string;
  projectDir?: string;
  claudeSessionId?: string;
  keyPath?: string;
  run: RunFn;
}

export interface FinalizeResult {
  ok: boolean;
  patchId: string;
  status?: string;
  errors: string[];
}

/** Where the persisted transcript for a reviewer lives under the repo. */
export function persistedTranscriptPath(
  repoRoot: string,
  taskId: string,
  reviewer: string,
): string {
  return join(repoRoot, '.ai-sdlc', 'transcripts', taskId, `${reviewer}.jsonl`);
}

/** Missing inputs, as one message per gap (empty when all are present). */
export function missingInputs(
  opts: Pick<FinalizeOptions, 'transcriptsDir' | 'reviewers'>,
): string[] {
  const out: string[] = [];
  for (const r of opts.reviewers) {
    const t = join(opts.transcriptsDir, `${r}.jsonl`);
    const v = join(opts.transcriptsDir, `${r}.verdict.json`);
    if (!existsSync(t)) out.push(`missing transcript for ${r}: ${t}`);
    if (!existsSync(v)) out.push(`missing verdict for ${r}: ${v}`);
  }
  return out;
}

function pushIf(args: string[], flag: string, value: string | undefined): void {
  if (value) args.push(flag, value);
}

export function finalizeAttestation(opts: FinalizeOptions): FinalizeResult {
  const base: FinalizeResult = { ok: false, patchId: opts.patchId, errors: [] };
  const gaps = missingInputs(opts);
  if (gaps.length > 0) return { ...base, errors: gaps };

  const repoRoot = resolve(opts.repoRoot);
  const srcDir = resolve(opts.transcriptsDir);

  // 1. persist: copy into the canonical per-task location (no-op when already there).
  for (const r of opts.reviewers) {
    const dest = persistedTranscriptPath(repoRoot, opts.taskId, r);
    const src = join(srcDir, `${r}.jsonl`);
    if (resolve(src) !== resolve(dest)) {
      mkdirSync(join(repoRoot, '.ai-sdlc', 'transcripts', opts.taskId), { recursive: true });
      copyFileSync(src, dest);
      const sidecar = join(srcDir, `${r}.agent-id`);
      if (existsSync(sidecar)) copyFileSync(sidecar, dest.replace(/\.jsonl$/, '.agent-id'));
    }
  }

  // 2. emit-leaf per reviewer (idempotent on taskId + reviewer + transcript hash).
  for (const r of opts.reviewers) {
    const args = [
      'emit-leaf',
      '--repo-root',
      repoRoot,
      '--task-id',
      opts.taskId,
      '--reviewer',
      r,
      '--transcript-path',
      persistedTranscriptPath(repoRoot, opts.taskId, r),
      '--verdict-path',
      join(srcDir, `${r}.verdict.json`),
      '--head-sha',
      opts.headSha,
      '--harness',
      opts.harness,
      '--model',
      opts.model,
      '--patch-id',
      opts.patchId,
    ];
    pushIf(args, '--nonce', opts.nonce);
    pushIf(args, '--project-dir', opts.projectDir);
    pushIf(args, '--claude-session-id', opts.claudeSessionId);
    const res = opts.run(args);
    if (res.status !== 0) {
      return {
        ...base,
        errors: [`emit-leaf failed for ${r}: ${res.stderr.trim() || res.stdout.trim()}`],
      };
    }
  }

  // 3. sign-v6 with the same patch-id.
  const sign = [
    'sign-v6',
    '--repo-root',
    repoRoot,
    '--task-id',
    opts.taskId,
    '--head-sha',
    opts.headSha,
    '--patch-id',
    opts.patchId,
  ];
  pushIf(sign, '--key-path', opts.keyPath);
  const signed = opts.run(sign);
  if (signed.status !== 0) {
    return { ...base, errors: [`sign-v6 failed: ${signed.stderr.trim() || signed.stdout.trim()}`] };
  }

  // 4. verify.
  const verified = opts.run([
    'verify',
    '--repo-root',
    repoRoot,
    '--head',
    opts.headSha,
    '--base',
    opts.baseSha,
  ]);
  const status = /^status=(\S+)/m.exec(verified.stdout)?.[1];
  if (verified.status !== 0 || status !== 'valid') {
    const reason = /^reason=(.*)$/m.exec(verified.stdout)?.[1] ?? verified.stderr.trim();
    return {
      ...base,
      status,
      errors: [`verify failed (status=${status ?? 'unknown'}): ${reason}`],
    };
  }
  return { ok: true, patchId: opts.patchId, status, errors: [] };
}

/** Exposed for the CLI wiring and tests. */
export function defaultTranscriptsDir(repoRoot: string, taskId: string): string {
  return join(repoRoot, '.ai-sdlc', 'transcripts', taskId);
}
