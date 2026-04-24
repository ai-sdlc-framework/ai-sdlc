import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { StateStore } from './state/store.js';
import { checkHasFrontendComponents, matchesFrontendHeuristic } from './code-area-classifier.js';

describe('matchesFrontendHeuristic', () => {
  it.each([
    ['src/components/Button.tsx', true],
    ['apps/web/pages/index.tsx', true],
    ['ui/primitives/Modal.jsx', true],
    ['frontend/src/app.ts', true],
    ['src/routes/login.svelte', true],
    ['dashboard/views/CostPage.vue', true],
    ['packages/core/src/parser.ts', false],
    ['orchestrator/src/priority.ts', false],
    ['backend/api/handlers.go', false],
    ['', false],
  ])('returns %j → %j', (area, expected) => {
    expect(matchesFrontendHeuristic(area)).toBe(expected);
  });

  it('is case-insensitive on directory markers', () => {
    expect(matchesFrontendHeuristic('src/Components/Button.ts')).toBe(true);
  });
});

describe('checkHasFrontendComponents', () => {
  let store: StateStore;
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    store = StateStore.open(db);
  });

  afterEach(() => {
    store.close();
  });

  it('falls back to heuristic when no state store is provided', () => {
    expect(checkHasFrontendComponents('ui/Button.tsx')).toBe(true);
    expect(checkHasFrontendComponents('core/parser.ts')).toBe(false);
  });

  it('prefers state-store classification over heuristic (overrides false→true)', () => {
    store.insertCodeAreaMetrics({
      codeArea: 'core/parser.ts',
      hasFrontendComponents: true,
      dataPointCount: 20,
    });
    expect(checkHasFrontendComponents('core/parser.ts', store)).toBe(true);
  });

  it('prefers state-store classification (overrides true→false)', () => {
    store.insertCodeAreaMetrics({
      codeArea: 'components/admin/ServerAction.ts',
      hasFrontendComponents: false,
      dataPointCount: 20,
    });
    // heuristic would say true (components/), but operator marked it false
    expect(checkHasFrontendComponents('components/admin/ServerAction.ts', store)).toBe(false);
  });

  it('falls back to heuristic when the store has no row for the area', () => {
    expect(checkHasFrontendComponents('ui/Toggle.tsx', store)).toBe(true);
  });
});
