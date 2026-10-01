/**
 * Secret redaction now lives in `@ai-sdlc/reference` so the judgment layer can
 * share it. This module re-exports it so existing imports keep working.
 */
export { SECRET_PATTERNS, redactSecrets, type SecretPattern } from '@ai-sdlc/reference';
