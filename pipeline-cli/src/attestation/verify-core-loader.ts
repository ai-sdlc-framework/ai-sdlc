/**
 * AISDLC-575 — loader for the single-sourced v6/v5/v4/v3 verification core.
 *
 * The verifier logic lives at `<pipeline-cli>/attestation-core/verify-core.mjs`
 * — a plain, dependency-free ESM module shipped alongside (not inside)
 * `dist/`, so the SAME bytes can be imported by this package's own CLI,
 * `ai-sdlc-plugin/scripts/verify-attestation.mjs` (via trusted candidate
 * walk), and `scripts/verify-attestation.mjs` (repo CI, monorepo-relative
 * import) — one implementation, three drivers. See the file header of
 * `verify-core.mjs` for the full rationale.
 *
 * Since this package COLOCATES the module (no cross-package trust
 * resolution needed — it's shipped in the same npm tarball as this CLI),
 * loading it is a plain relative import. It is done via a runtime-built
 * `URL`, not a string-literal `import()` specifier, so TypeScript does not
 * attempt static module resolution against a plain-JS sibling file that
 * carries no `.d.ts`/`.d.mts` declaration — resolution happens at runtime,
 * exactly like the trusted orchestrator-runtime loader in
 * `verify-runtime.ts` uses `import(pathToFileURL(found).href)`.
 */

export interface VerifyCoreModule {
  bindRuntime(mod: unknown): void;
  runVerifier(args: {
    headSha: string;
    baseSha: string;
    repoRoot?: string;
    /**
     * AISDLC-583 — driver-resolved installed-plugin `agents/` dir (see
     * `resolveInstalledPluginAgentDir` in `agent-dir-resolver.ts`).
     * Falls back to the repo-relative monorepo path, then a guarded
     * downgrade, when omitted or unresolved.
     */
    agentDir?: string;
  }): {
    status: 'valid' | 'invalid';
    reason: string;
    overallVerdictClass?: string;
    /** RFC-0046 Phase 1 (AISDLC-588) — weakest-link independence tier. */
    overallIndependenceTier?: string;
  };
}

/**
 * Resolve + import the colocated verify-core module.
 *
 * Path depth is load-bearing: this file compiles to
 * `pipeline-cli/dist/attestation/verify-core-loader.js`, two directories
 * below the package root, matching `pipeline-cli/attestation-core/` (also
 * reached via two `..` segments) from BOTH the compiled `dist/` location and
 * the uncompiled `src/` location used when tests import this module
 * directly — the relative depth is identical either way.
 */
export async function loadVerifyCore(): Promise<VerifyCoreModule> {
  const moduleUrl = new URL('../../attestation-core/verify-core.mjs', import.meta.url);
  return (await import(moduleUrl.href)) as unknown as VerifyCoreModule;
}
