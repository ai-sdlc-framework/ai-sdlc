/**
 * @ai-sdlc/sdk — TypeScript SDK for building AI-SDLC implementations.
 *
 * Main entry point re-exports core types/validation and resource builders.
 * For domain-specific imports, use subpath exports:
 *   - @ai-sdlc/sdk/core
 *   - @ai-sdlc/sdk/builders
 *   - @ai-sdlc/sdk/policy
 *   - @ai-sdlc/sdk/adapters
 *   - @ai-sdlc/sdk/reconciler
 *   - @ai-sdlc/sdk/agents
 *   - @ai-sdlc/sdk/audit
 *   - @ai-sdlc/sdk/metrics
 *   - @ai-sdlc/sdk/telemetry
 *   - @ai-sdlc/sdk/security
 *   - @ai-sdlc/sdk/compliance
 */

export * from './core.js';
export * from './builders.js';
