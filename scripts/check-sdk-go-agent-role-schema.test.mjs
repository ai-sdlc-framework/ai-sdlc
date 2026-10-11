/**
 * AISDLC-604 drift gate: the Go SDK mirror of the AgentRole schema must be
 * byte-identical to the canonical spec schema (single source of truth).
 *
 * Fix: copy spec/schemas/agent-role.schema.json over
 * sdk-go/core/schemas/agent-role.schema.json.
 *
 * Run with: node --test scripts/check-sdk-go-agent-role-schema.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const canonicalPath = join(root, 'spec/schemas/agent-role.schema.json');
const mirrorPath = join(root, 'sdk-go/core/schemas/agent-role.schema.json');

describe('sdk-go agent-role schema mirror', () => {
  it('parses to the same validation surface as the canonical schema', () => {
    const a = JSON.parse(readFileSync(canonicalPath, 'utf8'));
    const b = JSON.parse(readFileSync(mirrorPath, 'utf8'));
    assert.deepEqual(b, a);
  });

  it('is byte-identical to the canonical schema', () => {
    assert.equal(
      readFileSync(mirrorPath, 'utf8'),
      readFileSync(canonicalPath, 'utf8'),
      'sdk-go mirror drifted: cp spec/schemas/agent-role.schema.json sdk-go/core/schemas/agent-role.schema.json',
    );
  });
});
