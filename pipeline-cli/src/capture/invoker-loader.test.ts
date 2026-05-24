/**
 * Tests for `loadConfiguredInvoker()` — the env-var module-shim for
 * wiring a classifier `LlmInvoker` into the `cli-capture` CLI (AISDLC-275).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfiguredInvoker, resetInvokerCache } from './invoker-loader.js';

const ORIGINAL_ENV = process.env.AI_SDLC_CLASSIFIER_INVOKER_MODULE;
let tmpRoot = '';

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'aisdlc-275-invoker-loader-'));
  resetInvokerCache();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (ORIGINAL_ENV === undefined) {
    delete process.env.AI_SDLC_CLASSIFIER_INVOKER_MODULE;
  } else {
    process.env.AI_SDLC_CLASSIFIER_INVOKER_MODULE = ORIGINAL_ENV;
  }
  resetInvokerCache();
});

describe('loadConfiguredInvoker', () => {
  it('returns null when env var is unset', async () => {
    delete process.env.AI_SDLC_CLASSIFIER_INVOKER_MODULE;
    expect(await loadConfiguredInvoker()).toBeNull();
  });

  it('returns null when module path does not exist', async () => {
    process.env.AI_SDLC_CLASSIFIER_INVOKER_MODULE = join(tmpRoot, 'nope.mjs');
    expect(await loadConfiguredInvoker()).toBeNull();
  });

  it('loads a default-export invoker', async () => {
    const modPath = join(tmpRoot, 'invoker.mjs');
    writeFileSync(
      modPath,
      `export default {
         async invoke(req) {
           return {
             classification: 'tbd',
             confidence: 0.42,
             reasoning: 'mock',
             inputTokens: 1,
             outputTokens: 1,
           };
         }
       };
       `,
    );
    process.env.AI_SDLC_CLASSIFIER_INVOKER_MODULE = modPath;
    const invoker = await loadConfiguredInvoker();
    expect(invoker).not.toBeNull();
    const result = await invoker!.invoke({
      model: 'm',
      prompt: 'p',
      taskType: 'capture-triage',
    });
    expect(result.classification).toBe('tbd');
  });

  it('loads a named-export `invoker` symbol', async () => {
    const modPath = join(tmpRoot, 'invoker.mjs');
    writeFileSync(
      modPath,
      `export const invoker = {
         async invoke(req) {
           return {
             classification: 'is-capture',
             confidence: 0.71,
             reasoning: 'named',
             inputTokens: 1,
             outputTokens: 1,
           };
         }
       };
       `,
    );
    process.env.AI_SDLC_CLASSIFIER_INVOKER_MODULE = modPath;
    const invoker = await loadConfiguredInvoker();
    expect(invoker).not.toBeNull();
    const result = await invoker!.invoke({
      model: 'm',
      prompt: 'p',
      taskType: 'pr-comment-is-capture',
    });
    expect(result.classification).toBe('is-capture');
  });

  it('returns null when the module shape is unexpected', async () => {
    const modPath = join(tmpRoot, 'bad.mjs');
    writeFileSync(modPath, 'export const notAnInvoker = 42;');
    process.env.AI_SDLC_CLASSIFIER_INVOKER_MODULE = modPath;
    expect(await loadConfiguredInvoker()).toBeNull();
  });

  it('caches the resolution per process', async () => {
    const modPath = join(tmpRoot, 'invoker.mjs');
    writeFileSync(
      modPath,
      `export default { async invoke() { return { classification:'tbd', confidence:0, reasoning:'', inputTokens:0, outputTokens:0 }; } };`,
    );
    process.env.AI_SDLC_CLASSIFIER_INVOKER_MODULE = modPath;
    const first = await loadConfiguredInvoker();
    // Delete env to confirm caching short-circuits on second call.
    delete process.env.AI_SDLC_CLASSIFIER_INVOKER_MODULE;
    const second = await loadConfiguredInvoker();
    expect(second).toBe(first);
  });

  it('resolves relative paths against repoRoot', async () => {
    const modPath = join(tmpRoot, 'rel.mjs');
    writeFileSync(
      modPath,
      `export default { async invoke() { return { classification:'tbd', confidence:0, reasoning:'', inputTokens:0, outputTokens:0 }; } };`,
    );
    process.env.AI_SDLC_CLASSIFIER_INVOKER_MODULE = 'rel.mjs';
    const invoker = await loadConfiguredInvoker({ repoRoot: tmpRoot });
    expect(invoker).not.toBeNull();
  });
});
