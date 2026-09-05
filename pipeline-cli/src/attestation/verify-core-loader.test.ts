/**
 * AISDLC-575 — unit test for the colocated verify-core loader.
 *
 * Confirms `loadVerifyCore()` actually resolves and imports the real
 * `<pipeline-cli>/attestation-core/verify-core.mjs` file (not a stub), and
 * that the returned module exposes the `bindRuntime`/`runVerifier` surface
 * the `verify` subcommand depends on.
 */
import { describe, expect, it } from 'vitest';
import { loadVerifyCore } from './verify-core-loader.js';

describe('verify-core-loader (AISDLC-575)', () => {
  it('resolves the colocated attestation-core/verify-core.mjs module', async () => {
    const core = await loadVerifyCore();
    expect(typeof core.bindRuntime).toBe('function');
    expect(typeof core.runVerifier).toBe('function');
  });

  it('runVerifier throws before bindRuntime is called (unbound runtime symbols)', async () => {
    const core = await loadVerifyCore();
    // A fresh dynamic import() of the same URL is cached by the module
    // registry, so this only demonstrates the module loaded successfully
    // and its exports are callable — actual bind/verify behavior is covered
    // end-to-end by ai-sdlc-plugin/scripts/verify-attestation.test.mjs and
    // scripts/verify-attestation.test.mjs (subprocess-level, real sign+verify
    // round trips against the same file).
    expect(() => core.runVerifier({ headSha: '0'.repeat(40), baseSha: '0'.repeat(40) })).toThrow();
  });
});
