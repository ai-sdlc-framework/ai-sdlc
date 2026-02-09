/**
 * @ai-sdlc/conformance — Conformance test runner.
 *
 * Validates YAML test fixtures against AI-SDLC JSON Schemas
 * to verify implementation conformance.
 */

export { validate, validateResource, type ValidationResult } from '@ai-sdlc/reference';
export {
  runConformanceTests,
  expectedValidity,
  classifyFixtureLevel,
  type ConformanceLevel,
  type ConformanceLevelReport,
  type FixtureResult,
  type RunnerReport,
} from './runner.js';

export {
  isBehavioralFixture,
  runBehavioralTest,
  runBehavioralTestAsync,
  type BehavioralFixture,
  type BehavioralResult,
} from './behavioral.js';
