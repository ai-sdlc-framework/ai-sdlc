/**
 * Content-addressed cache for judgment answers. One file per key under
 * `<artifactsDir>/_judgment/cache/`. The cache holds answers only (never the
 * state or the question text). Every read is validated; a corrupt, oversized,
 * symlinked or tampered file is a miss, never an error.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonicalJson, sha256Hex } from './question-hash.js';
import type { JudgmentAnswer, JudgmentQuestion } from './types.js';

const MAX_CACHE_FILE_BYTES = 1_000_000;
const KEY_RE = /^[0-9a-f]{64}$/;
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

export interface JudgmentCacheEntry {
  modelVersion: string;
  answers: Record<string, JudgmentAnswer>;
}

export interface JudgmentCache {
  /** Returns the stored entry when present and valid; otherwise undefined. Never throws. */
  get(
    key: string,
    validate: (answers: Record<string, JudgmentAnswer>) => boolean,
  ): JudgmentCacheEntry | undefined;
  /** Stores an entry. A failure is swallowed. */
  put(key: string, entry: JudgmentCacheEntry): void;
}

export interface JudgmentCacheKeyParts {
  provider: string;
  /** The pinned (exact) model version from config. */
  model: string;
  questionSetHash: string;
  questions: Record<string, JudgmentQuestion>;
  stateHash: string;
}

/** SHA-256 over provider name, pinned model, question-set hash, canonical questions and state hash. */
export function judgmentCacheKey(parts: JudgmentCacheKeyParts): string {
  return sha256Hex(
    canonicalJson({
      provider: parts.provider,
      model: parts.model,
      questionSetHash: parts.questionSetHash,
      questions: parts.questions,
      stateHash: parts.stateHash,
    }),
  );
}

/** Make a directory (mode 0700) and refuse a symlinked or non-directory path. */
export function ensurePrivateDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function readSmallFile(path: string): string | undefined {
  let fd: number | undefined;
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_CACHE_FILE_BYTES) return undefined;
    fd = openSync(path, fsConstants.O_RDONLY | NOFOLLOW);
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.size > MAX_CACHE_FILE_BYTES) return undefined;
    const buf = Buffer.alloc(fst.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/** File-backed cache rooted at `<artifactsDir>/_judgment/cache`. */
export function createJudgmentCache(artifactsDir: string): JudgmentCache {
  const judgmentDir = join(artifactsDir, '_judgment');
  const dir = join(judgmentDir, 'cache');
  return {
    get(key, validate) {
      try {
        if (!KEY_RE.test(key)) return undefined;
        const raw = readSmallFile(join(dir, `${key}.json`));
        if (raw === undefined) return undefined;
        const parsed = JSON.parse(raw) as Partial<JudgmentCacheEntry> & { key?: unknown };
        if (
          parsed === null ||
          typeof parsed !== 'object' ||
          parsed.key !== key ||
          typeof parsed.modelVersion !== 'string' ||
          !parsed.answers ||
          typeof parsed.answers !== 'object' ||
          Array.isArray(parsed.answers)
        ) {
          return undefined;
        }
        if (!validate(parsed.answers)) return undefined;
        return { modelVersion: parsed.modelVersion, answers: parsed.answers };
      } catch {
        return undefined;
      }
    },
    put(key, entry) {
      let tmp: string | undefined;
      try {
        if (!KEY_RE.test(key)) return;
        if (!ensurePrivateDir(judgmentDir) || !ensurePrivateDir(dir)) return;
        tmp = join(dir, `.${key}.${randomBytes(6).toString('hex')}.tmp`);
        const fd = openSync(
          tmp,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
          0o600,
        );
        try {
          writeSync(fd, JSON.stringify({ v: 1, key, ...entry }));
        } finally {
          closeSync(fd);
        }
        renameSync(tmp, join(dir, `${key}.json`));
        tmp = undefined;
      } catch {
        // a cache write failure never affects the evaluation
      } finally {
        if (tmp) {
          try {
            unlinkSync(tmp);
          } catch {
            // ignore
          }
        }
      }
    },
  };
}
