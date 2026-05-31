#!/usr/bin/env node
/**
 * check-rfc-lifecycle-transitions.test.mjs — node:test coverage for the
 * RFC lifecycle-transition gate (AISDLC-297 library + AISDLC-350 hardening).
 *
 * Run with: `node --test scripts/check-rfc-lifecycle-transitions.test.mjs`
 *
 * Why node:test: same rationale as `scripts/check-rfc-docs.test.mjs` —
 * the script lives at workspace root, has no package.json, and node:test
 * ships with Node >=22 which we already require.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIFECYCLE_STATES,
  FORBIDDEN_TRANSITIONS,
  TERMINAL_STATES,
  OVERRIDE_MARKER_REGEX,
  extractLifecycle,
  extractRfcListField,
  parseOverrideMarker,
  sanitizeReason,
  loadLifecycleApprovers,
  appendAuditEntry,
  checkLifecycleTransition,
  checkRequiresShipped,
  checkAllTransitions,
  reportTransitionsAndExit,
  checkAllowlistMutationGuard,
  checkAuditLogIntegrity,
} from './check-rfc-lifecycle-transitions.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'check-rfc-lifecycle-transitions.mjs');

// ----------------------------------------------------------------- helpers

function rfcWithLifecycle(lifecycle) {
  return `---\nid: RFC-9999\nlifecycle: ${lifecycle}\nstatus: Draft\n---\n# Body\n`;
}

function rfcWithoutLifecycle() {
  return `---\nid: RFC-9999\nstatus: Draft\n---\n# Body\n`;
}

/** Canonical override marker for use in both PR body and RFC body. */
function overrideMarker(operator = 'deefactorial', reason = 'emergency-skip') {
  return `<!-- ai-sdlc:lifecycle-jump-approved-by:${operator} reason:${reason} -->`;
}

function makeApprovers(...identities) {
  return new Set(identities);
}

// --------------------------------------------------------- LIFECYCLE_STATES

describe('LIFECYCLE_STATES', () => {
  it('exports the four-step ladder in order', () => {
    assert.deepEqual(LIFECYCLE_STATES, ['Draft', 'Ready for Review', 'Signed Off', 'Implemented']);
  });
});

// ------------------------------------------------------ FORBIDDEN_TRANSITIONS

describe('FORBIDDEN_TRANSITIONS', () => {
  it('contains Draft → Signed Off (skips Ready for Review)', () => {
    assert.ok(FORBIDDEN_TRANSITIONS.has('Draft->Signed Off'));
  });

  it('contains Draft → Implemented (skips two steps)', () => {
    assert.ok(FORBIDDEN_TRANSITIONS.has('Draft->Implemented'));
  });

  it('contains Ready for Review → Implemented (skips Signed Off)', () => {
    assert.ok(FORBIDDEN_TRANSITIONS.has('Ready for Review->Implemented'));
  });

  it('does NOT contain sequential transitions', () => {
    assert.ok(!FORBIDDEN_TRANSITIONS.has('Draft->Ready for Review'));
    assert.ok(!FORBIDDEN_TRANSITIONS.has('Ready for Review->Signed Off'));
    assert.ok(!FORBIDDEN_TRANSITIONS.has('Signed Off->Implemented'));
  });

  it('does NOT contain same-state keys', () => {
    for (const s of LIFECYCLE_STATES) {
      assert.ok(!FORBIDDEN_TRANSITIONS.has(`${s}->${s}`));
    }
  });
});

// --------------------------------------------------------- TERMINAL_STATES

describe('TERMINAL_STATES', () => {
  it('contains Superseded', () => {
    assert.ok(TERMINAL_STATES.has('Superseded'));
  });
});

// ---------------------------------------------------- extractLifecycle

describe('extractLifecycle', () => {
  it('returns null for empty/falsy input', () => {
    assert.equal(extractLifecycle(''), null);
    assert.equal(extractLifecycle(null), null);
    assert.equal(extractLifecycle(undefined), null);
  });

  it('returns null when no lifecycle key in frontmatter', () => {
    assert.equal(extractLifecycle(rfcWithoutLifecycle()), null);
  });

  it('returns null when no frontmatter block present', () => {
    assert.equal(extractLifecycle('# Just a body'), null);
  });

  it('extracts unquoted lifecycle value', () => {
    assert.equal(extractLifecycle(rfcWithLifecycle('Draft')), 'Draft');
  });

  it('extracts multi-word lifecycle value', () => {
    assert.equal(extractLifecycle(rfcWithLifecycle('Ready for Review')), 'Ready for Review');
    assert.equal(extractLifecycle(rfcWithLifecycle('Signed Off')), 'Signed Off');
  });

  it('extracts Implemented', () => {
    assert.equal(extractLifecycle(rfcWithLifecycle('Implemented')), 'Implemented');
  });

  it('strips surrounding double quotes', () => {
    assert.equal(extractLifecycle('---\nlifecycle: "Signed Off"\n---\nbody\n'), 'Signed Off');
  });

  it('strips surrounding single quotes', () => {
    assert.equal(extractLifecycle("---\nlifecycle: 'Draft'\n---\nbody\n"), 'Draft');
  });

  it('handles CRLF line endings', () => {
    const src = '---\r\nlifecycle: Draft\r\n---\r\nbody\r\n';
    assert.equal(extractLifecycle(src), 'Draft');
  });

  it('returns null when frontmatter has no closing fence', () => {
    // Malformed frontmatter — gracefully return null.
    assert.equal(extractLifecycle('---\nlifecycle: Draft\n# missing closing fence\n'), null);
  });

  it('does NOT extract indented lifecycle (nested-key bypass prevention — AISDLC-350)', () => {
    // An indented lifecycle key (nested inside another object) must not be treated
    // as the top-level lifecycle field.
    const src = '---\nparent:\n  lifecycle: Implemented\nid: RFC-9999\n---\nbody\n';
    // With js-yaml: parsed.lifecycle is undefined (it's under 'parent').
    // With fallback: the indented line is skipped (col 0 check).
    assert.equal(extractLifecycle(src), null);
  });

  it('does NOT extract lifecycle appearing in a YAML comment — AISDLC-350', () => {
    // A YAML comment line must not provide the lifecycle value.
    const src = '---\n# lifecycle: Draft\nid: RFC-9999\nstatus: Active\n---\nbody\n';
    assert.equal(extractLifecycle(src), null);
  });
});

// ---------------------------------------------------- sanitizeReason (AISDLC-350)

describe('sanitizeReason', () => {
  it('returns unchanged string for normal text', () => {
    assert.equal(sanitizeReason('normal reason text'), 'normal reason text');
  });

  it('strips ASCII control chars', () => {
    assert.equal(sanitizeReason('bad\x07char\x1Bhere'), 'badcharhere');
  });

  it('strips C1 control chars', () => {
    assert.equal(sanitizeReason('text\x80\x9Fend'), 'textend');
  });

  it('preserves printable Unicode', () => {
    const s = 'Reason: RFC sign-off for RFC-0042 (legitimate)';
    assert.equal(sanitizeReason(s), s);
  });
});

// ------------------------------------------------------- parseOverrideMarker

describe('parseOverrideMarker', () => {
  it('returns null for empty/falsy input', () => {
    assert.equal(parseOverrideMarker(''), null);
    assert.equal(parseOverrideMarker(null), null);
  });

  it('returns null when no marker present', () => {
    assert.equal(parseOverrideMarker('Some PR description without a marker.'), null);
  });

  it('parses a well-formed override marker', () => {
    const text =
      '## PR summary\n\n<!-- ai-sdlc:lifecycle-jump-approved-by:dominique reason:AISDLC-297 emergency skip -->\n\nMore text.';
    const r = parseOverrideMarker(text);
    assert.ok(r !== null);
    assert.equal(r.operator, 'dominique');
    assert.equal(r.reason, 'AISDLC-297 emergency skip');
  });

  it('works with minimal whitespace in marker', () => {
    const text = '<!--ai-sdlc:lifecycle-jump-approved-by:alice reason:test-->';
    const r = parseOverrideMarker(text);
    assert.ok(r !== null);
    assert.equal(r.operator, 'alice');
  });

  it('is case-sensitive on the marker prefix', () => {
    // Must use exact lowercase prefix.
    const text = '<!-- AI-SDLC:lifecycle-jump-approved-by:alice reason:test -->';
    assert.equal(parseOverrideMarker(text), null);
  });

  // AISDLC-350 hardening: empty reason rejected

  it('returns null when reason is empty (after trim)', () => {
    const text = '<!-- ai-sdlc:lifecycle-jump-approved-by:alice reason: -->';
    assert.equal(parseOverrideMarker(text), null);
  });

  it('returns null when reason is whitespace-only', () => {
    const text = '<!-- ai-sdlc:lifecycle-jump-approved-by:alice reason:   -->';
    assert.equal(parseOverrideMarker(text), null);
  });

  // AISDLC-350 hardening: operator name regex [a-zA-Z0-9_-]{1,32}

  it('rejects operator names longer than 32 chars', () => {
    const longName = 'a'.repeat(33);
    const text = `<!-- ai-sdlc:lifecycle-jump-approved-by:${longName} reason:test -->`;
    assert.equal(parseOverrideMarker(text), null);
  });

  it('accepts operator names with hyphens and underscores', () => {
    const text = '<!-- ai-sdlc:lifecycle-jump-approved-by:some-user_name reason:test -->';
    const r = parseOverrideMarker(text);
    assert.ok(r !== null);
    assert.equal(r.operator, 'some-user_name');
  });
});

// ------------------------------------------ loadLifecycleApprovers (AISDLC-350)

describe('loadLifecycleApprovers', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lifecycle-approvers-'));
    mkdirSync(join(tmpDir, '.ai-sdlc'), { recursive: true });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty Set when approvers file does not exist', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'no-approvers-'));
    try {
      const approvers = loadLifecycleApprovers(repoRoot);
      assert.equal(approvers.size, 0);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('loads operator identities from a valid approvers file', () => {
    const approversYaml = `operators:
  - identity: alice
    addedAt: '2026-05-23'
    addedBy: deefactorial
  - identity: bob
    addedAt: '2026-05-23'
    addedBy: deefactorial
`;
    writeFileSync(join(tmpDir, '.ai-sdlc', 'lifecycle-approvers.yaml'), approversYaml);
    const approvers = loadLifecycleApprovers(tmpDir);
    assert.ok(approvers.has('alice'));
    assert.ok(approvers.has('bob'));
    assert.equal(approvers.size, 2);
  });

  it('returns empty Set on malformed YAML (fail-closed)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bad-approvers-'));
    try {
      mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
      writeFileSync(join(dir, '.ai-sdlc', 'lifecycle-approvers.yaml'), 'operators: [unclosed');
      const approvers = loadLifecycleApprovers(dir);
      assert.equal(approvers.size, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------ appendAuditEntry (AISDLC-350)

describe('appendAuditEntry', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'audit-entry-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the audit file and writes a valid JSONL entry', () => {
    appendAuditEntry({
      repoRoot: tmpDir,
      rfc: 'RFC-9999',
      fromLifecycle: 'Draft',
      toLifecycle: 'Signed Off',
      operator: 'alice',
      reason: 'emergency fix',
      prNumber: '42',
      commitSha: 'abc1234',
    });

    const auditPath = join(tmpDir, '.ai-sdlc', '_audit', 'lifecycle-overrides.jsonl');
    assert.ok(existsSync(auditPath));
    const line = readFileSync(auditPath, 'utf-8').trim();
    const entry = JSON.parse(line);
    assert.equal(entry.rfc, 'RFC-9999');
    assert.equal(entry.fromLifecycle, 'Draft');
    assert.equal(entry.toLifecycle, 'Signed Off');
    assert.equal(entry.operator, 'alice');
    assert.equal(entry.reason, 'emergency fix');
    assert.equal(entry.prNumber, '42');
    assert.equal(entry.commitSha, 'abc1234');
    assert.ok(entry.ts);
  });

  it('sanitizes control chars in reason before writing', () => {
    appendAuditEntry({
      repoRoot: tmpDir,
      rfc: 'RFC-8888',
      fromLifecycle: 'Draft',
      toLifecycle: 'Signed Off',
      operator: 'bob',
      reason: 'reason\x1Bwith\x07controls',
    });
    const auditPath = join(tmpDir, '.ai-sdlc', '_audit', 'lifecycle-overrides.jsonl');
    const lines = readFileSync(auditPath, 'utf-8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.reason, 'reasonwithcontrols');
  });
});

// ----------------------------------------------- checkLifecycleTransition

describe('checkLifecycleTransition — allowed transitions', () => {
  it('passes when fromLifecycle is null (new file)', () => {
    const r = checkLifecycleTransition({
      fromLifecycle: null,
      toLifecycle: 'Implemented',
      rfcId: 'RFC-9999',
    });
    assert.ok(r.ok);
  });

  it('passes when no change (same state)', () => {
    const r = checkLifecycleTransition({
      fromLifecycle: 'Signed Off',
      toLifecycle: 'Signed Off',
      rfcId: 'RFC-9999',
    });
    assert.ok(r.ok);
  });

  it('passes Draft → Ready for Review', () => {
    const r = checkLifecycleTransition({
      fromLifecycle: 'Draft',
      toLifecycle: 'Ready for Review',
      rfcId: 'RFC-9999',
    });
    assert.ok(r.ok);
    assert.equal(r.violation, undefined);
  });

  it('passes Ready for Review → Signed Off', () => {
    const r = checkLifecycleTransition({
      fromLifecycle: 'Ready for Review',
      toLifecycle: 'Signed Off',
      rfcId: 'RFC-9999',
    });
    assert.ok(r.ok);
  });

  it('passes Signed Off → Implemented', () => {
    const r = checkLifecycleTransition({
      fromLifecycle: 'Signed Off',
      toLifecycle: 'Implemented',
      rfcId: 'RFC-9999',
    });
    assert.ok(r.ok);
  });

  it('passes any → Superseded (terminal state)', () => {
    for (const from of LIFECYCLE_STATES) {
      const r = checkLifecycleTransition({
        fromLifecycle: from,
        toLifecycle: 'Superseded',
        rfcId: 'RFC-9999',
      });
      assert.ok(r.ok, `${from} → Superseded should be allowed`);
    }
  });

  it('passes regression (Implemented → Draft) without blocking', () => {
    // Regressions are not blocked by this gate (may be intentional reverts).
    const r = checkLifecycleTransition({
      fromLifecycle: 'Implemented',
      toLifecycle: 'Draft',
      rfcId: 'RFC-9999',
    });
    assert.ok(r.ok);
  });
});

describe('checkLifecycleTransition — forbidden transitions', () => {
  it('fails Draft → Signed Off with diagnostic', () => {
    const r = checkLifecycleTransition({
      fromLifecycle: 'Draft',
      toLifecycle: 'Signed Off',
      rfcId: 'RFC-9999',
    });
    assert.ok(!r.ok);
    assert.equal(r.violation, 'Draft->Signed Off');
    assert.match(r.diagnostic, /RFC-9999/);
    assert.match(r.diagnostic, /forbidden lifecycle transition/);
    assert.match(r.diagnostic, /Ready for Review/); // correct next step
    assert.match(r.diagnostic, /ai-sdlc:lifecycle-jump-approved-by/); // override hint
    assert.match(r.diagnostic, /rfc-lifecycle-check\.yml/); // CI wiring reference (AISDLC-350)
  });

  it('fails Draft → Implemented with diagnostic mentioning Ready for Review as next step', () => {
    const r = checkLifecycleTransition({
      fromLifecycle: 'Draft',
      toLifecycle: 'Implemented',
      rfcId: 'RFC-0031',
    });
    assert.ok(!r.ok);
    assert.equal(r.violation, 'Draft->Implemented');
    assert.match(r.diagnostic, /RFC-0031/);
    assert.match(r.diagnostic, /Ready for Review/); // next required step from Draft
  });

  it('fails Ready for Review → Implemented with diagnostic mentioning Signed Off as next step', () => {
    const r = checkLifecycleTransition({
      fromLifecycle: 'Ready for Review',
      toLifecycle: 'Implemented',
      rfcId: 'RFC-0024',
    });
    assert.ok(!r.ok);
    assert.equal(r.violation, 'Ready for Review->Implemented');
    assert.match(r.diagnostic, /RFC-0024/);
    assert.match(r.diagnostic, /Signed Off/); // next required step from Ready for Review
  });

  // AISDLC-350 fail-closed: lifecycle removed mid-PR is now a FAILURE.
  it('FAILS when lifecycle field was removed (toLifecycle null, fromLifecycle set)', () => {
    const r = checkLifecycleTransition({
      fromLifecycle: 'Draft',
      toLifecycle: null,
      rfcId: 'RFC-9999',
    });
    assert.ok(!r.ok);
    assert.match(r.violation, /->null/);
    assert.match(r.diagnostic, /REMOVED/);
    assert.match(r.diagnostic, /RFC-9999/);
  });
});

describe('checkLifecycleTransition — operator override (AISDLC-350 hardening)', () => {
  const forbiddenFrom = 'Draft';
  const forbiddenTo = 'Signed Off';
  const marker = overrideMarker('deefactorial', 'hotfix-required');
  const approvers = makeApprovers('deefactorial');

  it('succeeds when override marker is in BOTH PR body AND RFC body', () => {
    const r = checkLifecycleTransition({
      fromLifecycle: forbiddenFrom,
      toLifecycle: forbiddenTo,
      rfcId: 'RFC-9999',
      prBody: marker,
      rfcBody: `# RFC Body\n\n${marker}\n\nMore text.`,
      approvers,
    });
    assert.ok(r.ok);
    assert.ok(r.override);
    assert.equal(r.override.operator, 'deefactorial');
    assert.equal(r.override.reason, 'hotfix-required');
  });

  it('fails when override marker is in PR body ONLY (single-source no longer accepted)', () => {
    const r = checkLifecycleTransition({
      fromLifecycle: forbiddenFrom,
      toLifecycle: forbiddenTo,
      rfcId: 'RFC-9999',
      prBody: marker,
      rfcBody: '# RFC Body — no marker here',
      approvers,
    });
    assert.ok(!r.ok);
    assert.match(r.diagnostic, /PR body only/);
  });

  it('fails when override marker is in RFC body ONLY (single-source no longer accepted)', () => {
    const r = checkLifecycleTransition({
      fromLifecycle: forbiddenFrom,
      toLifecycle: forbiddenTo,
      rfcId: 'RFC-9999',
      prBody: 'no marker here',
      rfcBody: `# RFC Body\n\n${marker}\n`,
      approvers,
    });
    assert.ok(!r.ok);
    assert.match(r.diagnostic, /RFC body only/);
  });

  it('fails when override marker is malformed (missing reason)', () => {
    const badMarker = '<!-- ai-sdlc:lifecycle-jump-approved-by:deefactorial -->';
    const r = checkLifecycleTransition({
      fromLifecycle: forbiddenFrom,
      toLifecycle: forbiddenTo,
      rfcId: 'RFC-9999',
      prBody: badMarker,
      rfcBody: `# Body\n\n${badMarker}`,
      approvers,
    });
    // Malformed marker (missing reason) should NOT be treated as an approved override.
    assert.ok(!r.ok);
  });

  it('fails when operator is NOT in allowlist', () => {
    const unauthorizedMarker = overrideMarker('unauthorized-user', 'bypass-attempt');
    const r = checkLifecycleTransition({
      fromLifecycle: forbiddenFrom,
      toLifecycle: forbiddenTo,
      rfcId: 'RFC-9999',
      prBody: unauthorizedMarker,
      rfcBody: `# Body\n\n${unauthorizedMarker}`,
      approvers: makeApprovers('alice', 'bob'), // unauthorized-user not listed
    });
    assert.ok(!r.ok);
    assert.match(r.diagnostic, /NOT in .ai-sdlc\/lifecycle-approvers.yaml/);
  });

  it('succeeds without an approvers set (no allowlist enforcement — backward compat)', () => {
    // When approvers is undefined, allowlist validation is skipped.
    const r = checkLifecycleTransition({
      fromLifecycle: forbiddenFrom,
      toLifecycle: forbiddenTo,
      rfcId: 'RFC-9999',
      prBody: marker,
      rfcBody: `# Body\n\n${marker}`,
      // No approvers set provided.
    });
    assert.ok(r.ok);
    assert.ok(r.override);
  });

  it('succeeds when approvers Set is empty (no allowlist enforcement when list has 0 entries)', () => {
    // Empty approvers set (size 0) → no allowlist enforcement.
    const r = checkLifecycleTransition({
      fromLifecycle: forbiddenFrom,
      toLifecycle: forbiddenTo,
      rfcId: 'RFC-9999',
      prBody: marker,
      rfcBody: `# Body\n\n${marker}`,
      approvers: new Set(), // empty
    });
    assert.ok(r.ok);
    assert.ok(r.override);
  });
});

// ---------------------------------------------- checkAllTransitions

describe('checkAllTransitions', () => {
  it('returns clean:N for all-allowed transitions', () => {
    const transitions = [
      {
        rfcId: 'RFC-0001',
        fromContent: rfcWithLifecycle('Draft'),
        toContent: rfcWithLifecycle('Ready for Review'),
      },
      {
        rfcId: 'RFC-0002',
        fromContent: rfcWithLifecycle('Ready for Review'),
        toContent: rfcWithLifecycle('Signed Off'),
      },
      {
        rfcId: 'RFC-0003',
        fromContent: rfcWithLifecycle('Signed Off'),
        toContent: rfcWithLifecycle('Implemented'),
      },
    ];
    const r = checkAllTransitions(transitions);
    assert.deepEqual(r.failures, []);
    assert.deepEqual(r.overrides, []);
    assert.equal(r.clean, 3);
  });

  it('accumulates multiple failures', () => {
    const transitions = [
      {
        rfcId: 'RFC-0010',
        fromContent: rfcWithLifecycle('Draft'),
        toContent: rfcWithLifecycle('Implemented'),
      },
      {
        rfcId: 'RFC-0011',
        fromContent: rfcWithLifecycle('Ready for Review'),
        toContent: rfcWithLifecycle('Implemented'),
      },
    ];
    const r = checkAllTransitions(transitions);
    assert.equal(r.failures.length, 2);
    assert.equal(r.failures[0].rfcId, 'RFC-0010');
    assert.equal(r.failures[1].rfcId, 'RFC-0011');
  });

  it('records override entries for dual-location approved jumps', () => {
    const marker = overrideMarker('deefactorial', 'emergency');
    const rfcBodyWithMarker = rfcWithLifecycle('Signed Off') + `\n${marker}\n`;
    const transitions = [
      {
        rfcId: 'RFC-0020',
        fromContent: rfcWithLifecycle('Draft'),
        toContent: rfcBodyWithMarker,
        prBody: marker,
      },
    ];
    const r = checkAllTransitions(transitions);
    assert.deepEqual(r.failures, []);
    assert.equal(r.overrides.length, 1);
    assert.equal(r.overrides[0].rfcId, 'RFC-0020');
    assert.equal(r.overrides[0].override.operator, 'deefactorial');
    assert.equal(r.overrides[0].transition, 'Draft->Signed Off');
    assert.equal(r.clean, 0); // override is not counted as "clean"
  });

  it('skips files with no lifecycle field in before/after (graceful)', () => {
    const transitions = [
      {
        rfcId: 'RFC-0050',
        fromContent: rfcWithoutLifecycle(),
        toContent: rfcWithLifecycle('Implemented'),
      },
    ];
    const r = checkAllTransitions(transitions);
    // fromContent has no lifecycle → fromLifecycle is null → new-file treatment → clean.
    assert.deepEqual(r.failures, []);
    assert.equal(r.clean, 1);
  });

  it('handles new file (fromContent null)', () => {
    const transitions = [
      {
        rfcId: 'RFC-0060',
        fromContent: null,
        toContent: rfcWithLifecycle('Draft'),
      },
    ];
    const r = checkAllTransitions(transitions);
    assert.deepEqual(r.failures, []);
    assert.equal(r.clean, 1);
  });

  // AISDLC-350 fail-closed: lifecycle removed mid-PR is now a FAILURE.
  it('FAILS when lifecycle field is removed (toContent has no lifecycle but fromContent did)', () => {
    const transitions = [
      {
        rfcId: 'RFC-0070',
        fromContent: rfcWithLifecycle('Signed Off'),
        toContent: rfcWithoutLifecycle(), // lifecycle field removed
      },
    ];
    const r = checkAllTransitions(transitions);
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0].violation, /->null/);
    assert.match(r.failures[0].diagnostic, /REMOVED/);
  });
});

// ------------------------------------------- reportTransitionsAndExit

describe('reportTransitionsAndExit', () => {
  it('returns 0 on a clean report', () => {
    const code = reportTransitionsAndExit({ failures: [], overrides: [], clean: 5 });
    assert.equal(code, 0);
  });

  it('returns 1 when failures are present', () => {
    const code = reportTransitionsAndExit({
      failures: [
        {
          rfcId: 'RFC-0001',
          violation: 'Draft->Implemented',
          diagnostic: '[rfc-lifecycle] FAIL RFC-0001: forbidden...',
        },
      ],
      overrides: [],
      clean: 0,
    });
    assert.equal(code, 1);
  });
});

// -------------------------------------------------------------------- CLI — new test: fromIdx === -1 fix (AISDLC-417)

describe('checkLifecycleTransition — unknown fromLifecycle fails closed (AISDLC-417)', () => {
  it('fails when fromLifecycle is an unknown value and toLifecycle is a known ladder state', () => {
    const r = checkLifecycleTransition({
      fromLifecycle: 'CustomState',
      toLifecycle: 'Implemented',
      rfcId: 'RFC-9999',
    });
    assert.ok(!r.ok);
    assert.match(r.violation, /CustomState->Implemented/);
    assert.match(r.diagnostic, /not a recognised ladder state/);
    assert.match(r.diagnostic, /RFC-9999/);
  });

  it('fails when fromLifecycle is unknown and toLifecycle is Signed Off', () => {
    const r = checkLifecycleTransition({
      fromLifecycle: 'UnknownPhase',
      toLifecycle: 'Signed Off',
      rfcId: 'RFC-1234',
    });
    assert.ok(!r.ok);
    assert.match(r.violation, /UnknownPhase->Signed Off/);
    assert.match(r.diagnostic, /not a recognised ladder state/);
  });

  it('passes regressions (toIdx <= fromIdx) as before when both are known states', () => {
    const r = checkLifecycleTransition({
      fromLifecycle: 'Implemented',
      toLifecycle: 'Draft',
      rfcId: 'RFC-9999',
    });
    assert.ok(r.ok);
  });
});

// ---------------------------------- checkAllowlistMutationGuard (AISDLC-417)

describe('checkAllowlistMutationGuard', () => {
  it('returns ok:true when allowlistDiff is empty (no change)', () => {
    const r = checkAllowlistMutationGuard({ allowlistDiff: '', prBody: 'some PR body' });
    assert.ok(r.ok);
  });

  it('returns ok:true when allowlistDiff is present but no override marker in PR body', () => {
    const diff =
      'diff --git a/.ai-sdlc/lifecycle-approvers.yaml b/.ai-sdlc/lifecycle-approvers.yaml\n+  - identity: newuser';
    const r = checkAllowlistMutationGuard({
      allowlistDiff: diff,
      prBody: 'No override marker here.',
    });
    assert.ok(r.ok);
  });

  it('returns ok:false when allowlistDiff is non-empty AND override marker is present', () => {
    const diff =
      'diff --git a/.ai-sdlc/lifecycle-approvers.yaml b/.ai-sdlc/lifecycle-approvers.yaml\n+  - identity: newuser';
    const prBody = '## PR\n\n<!-- ai-sdlc:lifecycle-jump-approved-by:newuser reason:testing -->\n';
    const r = checkAllowlistMutationGuard({ allowlistDiff: diff, prBody });
    assert.ok(!r.ok);
    assert.match(r.diagnostic, /privilege-escalation vector/);
    assert.match(r.diagnostic, /Split into two PRs/);
    assert.match(r.diagnostic, /AISDLC-417/);
  });

  it('returns ok:true when prBody is empty even with allowlist changes', () => {
    const diff =
      'diff --git a/.ai-sdlc/lifecycle-approvers.yaml b/.ai-sdlc/lifecycle-approvers.yaml\n+  - identity: newuser';
    const r = checkAllowlistMutationGuard({ allowlistDiff: diff, prBody: '' });
    assert.ok(r.ok);
  });

  it('returns ok:true when prBody is null even with allowlist changes', () => {
    const diff = '+  - identity: newuser';
    const r = checkAllowlistMutationGuard({ allowlistDiff: diff, prBody: null });
    assert.ok(r.ok);
  });

  it('diagnostic mentions allowlist file path', () => {
    const diff = '+identity: evil';
    const prBody = '<!-- ai-sdlc:lifecycle-jump-approved-by:evil reason:bypass -->';
    const r = checkAllowlistMutationGuard({ allowlistDiff: diff, prBody });
    assert.ok(!r.ok);
    assert.match(r.diagnostic, /lifecycle-approvers\.yaml/);
  });
});

// ---------------------------------- checkAuditLogIntegrity (AISDLC-417)

describe('checkAuditLogIntegrity', () => {
  it('returns ok:true when auditLogDiff is empty (no change)', () => {
    const r = checkAuditLogIntegrity({ auditLogDiff: '' });
    assert.ok(r.ok);
  });

  it('returns ok:true when auditLogDiff is null', () => {
    const r = checkAuditLogIntegrity({ auditLogDiff: null });
    assert.ok(r.ok);
  });

  it('returns ok:true for a diff that only adds lines', () => {
    const diff = [
      'diff --git a/.ai-sdlc/_audit/lifecycle-overrides.jsonl b/.ai-sdlc/_audit/lifecycle-overrides.jsonl',
      'index abc..def 100644',
      '--- a/.ai-sdlc/_audit/lifecycle-overrides.jsonl',
      '+++ b/.ai-sdlc/_audit/lifecycle-overrides.jsonl',
      '@@ -1,2 +1,3 @@',
      ' {"ts":"2026-01-01","rfc":"RFC-0001"}',
      ' {"ts":"2026-01-02","rfc":"RFC-0002"}',
      '+{"ts":"2026-01-03","rfc":"RFC-0003"}',
    ].join('\n');
    const r = checkAuditLogIntegrity({ auditLogDiff: diff });
    assert.ok(r.ok);
  });

  it('returns ok:false when a line is removed from the audit log', () => {
    const diff = [
      'diff --git a/.ai-sdlc/_audit/lifecycle-overrides.jsonl b/.ai-sdlc/_audit/lifecycle-overrides.jsonl',
      '--- a/.ai-sdlc/_audit/lifecycle-overrides.jsonl',
      '+++ b/.ai-sdlc/_audit/lifecycle-overrides.jsonl',
      '@@ -1,3 +1,2 @@',
      ' {"ts":"2026-01-01","rfc":"RFC-0001"}',
      '-{"ts":"2026-01-02","rfc":"RFC-0002"}',
      ' {"ts":"2026-01-03","rfc":"RFC-0003"}',
    ].join('\n');
    const r = checkAuditLogIntegrity({ auditLogDiff: diff });
    assert.ok(!r.ok);
    assert.ok(Array.isArray(r.removedLines));
    assert.equal(r.removedLines.length, 1);
    assert.match(r.removedLines[0], /RFC-0002/);
    assert.match(r.diagnostic, /append-only/);
    assert.match(r.diagnostic, /AISDLC-417/);
  });

  it('returns ok:false and counts all removed lines when multiple lines are removed', () => {
    const diff = [
      '--- a/.ai-sdlc/_audit/lifecycle-overrides.jsonl',
      '+++ b/.ai-sdlc/_audit/lifecycle-overrides.jsonl',
      '-{"ts":"2026-01-01","rfc":"RFC-0001"}',
      '-{"ts":"2026-01-02","rfc":"RFC-0002"}',
      ' {"ts":"2026-01-03","rfc":"RFC-0003"}',
    ].join('\n');
    const r = checkAuditLogIntegrity({ auditLogDiff: diff });
    assert.ok(!r.ok);
    assert.equal(r.removedLines.length, 2);
    assert.match(r.diagnostic, /2 line/);
  });

  it('does NOT treat diff header lines (---) as removed content lines', () => {
    const diff = [
      '--- a/.ai-sdlc/_audit/lifecycle-overrides.jsonl',
      '+++ b/.ai-sdlc/_audit/lifecycle-overrides.jsonl',
      '+{"ts":"2026-01-04","rfc":"RFC-0004"}',
    ].join('\n');
    const r = checkAuditLogIntegrity({ auditLogDiff: diff });
    assert.ok(r.ok);
  });
});

// -------------------------------------------------------------------- CLI

describe('CLI', () => {
  function makeTempRfcFile(lifecycle) {
    const dir = mkdtempSync(join(tmpdir(), 'rfc-lifecycle-'));
    const path = join(dir, 'RFC-9999-test.md');
    writeFileSync(path, rfcWithLifecycle(lifecycle));
    return { dir, path };
  }

  it('exits 0 for allowed sequential transition via CLI', () => {
    const before = makeTempRfcFile('Draft');
    const after = makeTempRfcFile('Ready for Review');
    try {
      const r = spawnSync(
        'node',
        [SCRIPT, '--before', before.path, '--after', after.path, '--rfc-id', 'RFC-9999'],
        { encoding: 'utf-8' },
      );
      assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.match(r.stdout, /\[rfc-lifecycle\] OK/);
    } finally {
      rmSync(before.dir, { recursive: true, force: true });
      rmSync(after.dir, { recursive: true, force: true });
    }
  });

  it('exits 1 for forbidden transition via CLI', () => {
    const before = makeTempRfcFile('Draft');
    const after = makeTempRfcFile('Implemented');
    try {
      const r = spawnSync(
        'node',
        [SCRIPT, '--before', before.path, '--after', after.path, '--rfc-id', 'RFC-9999'],
        { encoding: 'utf-8' },
      );
      assert.equal(r.status, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.match(r.stderr, /forbidden lifecycle transition/);
      assert.match(r.stderr, /RFC-9999/);
    } finally {
      rmSync(before.dir, { recursive: true, force: true });
      rmSync(after.dir, { recursive: true, force: true });
    }
  });

  it('exits 0 with dual-location override marker for forbidden transition', () => {
    // AISDLC-350: override must be in both PR body AND RFC body.
    const before = makeTempRfcFile('Draft');
    const marker = overrideMarker('deefactorial', 'emergency-hotfix');

    // After RFC file contains the marker in its body.
    const afterDir = mkdtempSync(join(tmpdir(), 'rfc-lifecycle-'));
    const afterPath = join(afterDir, 'RFC-9999-test.md');
    writeFileSync(afterPath, rfcWithLifecycle('Implemented') + `\n${marker}\n`);

    // Use a temp dir as repo-root so the audit entry is NOT written to the
    // real repo's .ai-sdlc/_audit/ directory during tests.
    const repoRootDir = mkdtempSync(join(tmpdir(), 'rfc-lifecycle-repo-'));

    try {
      const r = spawnSync(
        'node',
        [
          SCRIPT,
          '--before',
          before.path,
          '--after',
          afterPath,
          '--rfc-id',
          'RFC-9999',
          '--pr-body',
          marker,
          '--repo-root',
          repoRootDir,
        ],
        { encoding: 'utf-8' },
      );
      assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.match(r.stdout, /OVERRIDE/);
    } finally {
      rmSync(before.dir, { recursive: true, force: true });
      rmSync(afterDir, { recursive: true, force: true });
      rmSync(repoRootDir, { recursive: true, force: true });
    }
  });

  it('exits 1 with override in PR body only (RFC body has no marker)', () => {
    // Single-source override is no longer accepted.
    const before = makeTempRfcFile('Draft');
    const after = makeTempRfcFile('Implemented'); // no marker in RFC body
    const marker = overrideMarker('deefactorial', 'emergency-hotfix');
    try {
      const r = spawnSync(
        'node',
        [
          SCRIPT,
          '--before',
          before.path,
          '--after',
          after.path,
          '--rfc-id',
          'RFC-9999',
          '--pr-body',
          marker,
        ],
        { encoding: 'utf-8' },
      );
      assert.equal(r.status, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.match(r.stderr, /PR body only/);
    } finally {
      rmSync(before.dir, { recursive: true, force: true });
      rmSync(after.dir, { recursive: true, force: true });
    }
  });

  it('exits 1 when lifecycle was removed (fail-closed — AISDLC-350)', () => {
    const before = makeTempRfcFile('Draft');
    // After file has no lifecycle field.
    const afterDir = mkdtempSync(join(tmpdir(), 'rfc-lifecycle-'));
    const afterPath = join(afterDir, 'RFC-9999-test.md');
    writeFileSync(afterPath, rfcWithoutLifecycle());
    try {
      const r = spawnSync(
        'node',
        [SCRIPT, '--before', before.path, '--after', afterPath, '--rfc-id', 'RFC-9999'],
        { encoding: 'utf-8' },
      );
      assert.equal(r.status, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.match(r.stderr, /REMOVED/);
    } finally {
      rmSync(before.dir, { recursive: true, force: true });
      rmSync(afterDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when fromLifecycle is unknown (fails closed — AISDLC-417)', () => {
    // File has a lifecycle value not in the ladder.
    const dir = mkdtempSync(join(tmpdir(), 'rfc-lifecycle-'));
    const beforePath = join(dir, 'rfc-before.md');
    const afterPath = join(dir, 'rfc-after.md');
    writeFileSync(beforePath, '---\nid: RFC-9999\nlifecycle: CustomState\n---\n# Body\n');
    writeFileSync(afterPath, rfcWithLifecycle('Implemented'));
    try {
      const r = spawnSync(
        'node',
        [SCRIPT, '--before', beforePath, '--after', afterPath, '--rfc-id', 'RFC-9999'],
        { encoding: 'utf-8' },
      );
      assert.equal(r.status, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.match(r.stderr, /not a recognised ladder state/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--pr-body-file reads PR body from file instead of command-line arg', () => {
    // AISDLC-417: --pr-body-file avoids command-substitution injection.
    const before = makeTempRfcFile('Draft');
    const marker = overrideMarker('deefactorial', 'emergency-hotfix');

    // After RFC contains the marker in its body.
    const afterDir = mkdtempSync(join(tmpdir(), 'rfc-lifecycle-'));
    const afterPath = join(afterDir, 'RFC-9999-test.md');
    writeFileSync(afterPath, rfcWithLifecycle('Implemented') + `\n${marker}\n`);

    // Write PR body to a temp file.
    const prBodyDir = mkdtempSync(join(tmpdir(), 'pr-body-'));
    const prBodyFile = join(prBodyDir, 'pr-body.txt');
    writeFileSync(prBodyFile, marker);

    const repoRootDir = mkdtempSync(join(tmpdir(), 'rfc-lifecycle-repo-'));

    try {
      const r = spawnSync(
        'node',
        [
          SCRIPT,
          '--before',
          before.path,
          '--after',
          afterPath,
          '--rfc-id',
          'RFC-9999',
          '--pr-body-file',
          prBodyFile,
          '--repo-root',
          repoRootDir,
        ],
        { encoding: 'utf-8' },
      );
      assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.match(r.stdout, /OVERRIDE/);
    } finally {
      rmSync(before.dir, { recursive: true, force: true });
      rmSync(afterDir, { recursive: true, force: true });
      rmSync(prBodyDir, { recursive: true, force: true });
      rmSync(repoRootDir, { recursive: true, force: true });
    }
  });

  it('--pr-body-file takes precedence over --pr-body', () => {
    // When both are passed, --pr-body-file wins.
    const before = makeTempRfcFile('Draft');
    const after = makeTempRfcFile('Implemented'); // forbidden transition

    // PR body via file has the override marker; --pr-body does NOT.
    const prBodyDir = mkdtempSync(join(tmpdir(), 'pr-body-'));
    const prBodyFile = join(prBodyDir, 'pr-body.txt');
    const marker = overrideMarker('deefactorial', 'testing-file-precedence');

    // We use an RFC-after that embeds the marker too (dual-location requirement).
    const afterDir2 = mkdtempSync(join(tmpdir(), 'rfc-lifecycle-'));
    const afterPath2 = join(afterDir2, 'RFC-9999.md');
    writeFileSync(afterPath2, rfcWithLifecycle('Implemented') + `\n${marker}\n`);
    writeFileSync(prBodyFile, marker);

    const repoRootDir = mkdtempSync(join(tmpdir(), 'rfc-lifecycle-repo-'));

    try {
      const r = spawnSync(
        'node',
        [
          SCRIPT,
          '--before',
          before.path,
          '--after',
          afterPath2,
          '--rfc-id',
          'RFC-9999',
          '--pr-body',
          'no marker here',
          '--pr-body-file',
          prBodyFile,
          '--repo-root',
          repoRootDir,
        ],
        { encoding: 'utf-8' },
      );
      // Should succeed because --pr-body-file (which has the marker) overrides --pr-body.
      assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.match(r.stdout, /OVERRIDE/);
    } finally {
      rmSync(before.dir, { recursive: true, force: true });
      rmSync(after.dir, { recursive: true, force: true });
      rmSync(afterDir2, { recursive: true, force: true });
      rmSync(prBodyDir, { recursive: true, force: true });
      rmSync(repoRootDir, { recursive: true, force: true });
    }
  });

  it('exits 2 on unknown argument', () => {
    const r = spawnSync('node', [SCRIPT, '--bogus'], { encoding: 'utf-8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Unknown argument/);
  });

  it('--help prints usage and exits 0', () => {
    const r = spawnSync('node', [SCRIPT, '--help'], { encoding: 'utf-8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage:/);
  });
});

// ---------------------------------------------------------- module exports

describe('module exports', () => {
  it('OVERRIDE_MARKER_REGEX matches the canonical marker format', () => {
    const marker = '<!-- ai-sdlc:lifecycle-jump-approved-by:dominique reason:AISDLC-297 skip -->';
    assert.ok(OVERRIDE_MARKER_REGEX.test(marker));
  });

  it('OVERRIDE_MARKER_REGEX does not match unrelated HTML comments', () => {
    assert.ok(!OVERRIDE_MARKER_REGEX.test('<!-- regular comment -->'));
    assert.ok(!OVERRIDE_MARKER_REGEX.test('<!-- skip ci -->'));
  });

  it('OVERRIDE_MARKER_REGEX does not match operator names > 32 chars', () => {
    const long = 'a'.repeat(33);
    assert.ok(
      !OVERRIDE_MARKER_REGEX.test(
        `<!-- ai-sdlc:lifecycle-jump-approved-by:${long} reason:test -->`,
      ),
    );
  });

  it('exports sanitizeReason', () => {
    assert.equal(typeof sanitizeReason, 'function');
  });

  it('exports loadLifecycleApprovers', () => {
    assert.equal(typeof loadLifecycleApprovers, 'function');
  });

  it('exports appendAuditEntry', () => {
    assert.equal(typeof appendAuditEntry, 'function');
  });

  it('exports checkAllowlistMutationGuard (AISDLC-417)', () => {
    assert.equal(typeof checkAllowlistMutationGuard, 'function');
  });

  it('exports checkAuditLogIntegrity (AISDLC-417)', () => {
    assert.equal(typeof checkAuditLogIntegrity, 'function');
  });

  it('exports extractRfcListField (AISDLC-311)', () => {
    assert.equal(typeof extractRfcListField, 'function');
  });

  it('exports checkRequiresShipped (AISDLC-311)', () => {
    assert.equal(typeof checkRequiresShipped, 'function');
  });
});

// ------------------------------------------- AISDLC-311 requires-shipped gate

describe('extractRfcListField', () => {
  it('returns [] for empty input', () => {
    assert.deepEqual(extractRfcListField('', 'requires'), []);
    assert.deepEqual(extractRfcListField(null, 'requires'), []);
  });

  it('parses inline list', () => {
    const src = '---\nid: RFC-0042\nrequires: [RFC-0001, RFC-0002]\n---\nbody\n';
    assert.deepEqual(extractRfcListField(src, 'requires'), ['RFC-0001', 'RFC-0002']);
  });

  it('parses block list', () => {
    const src = '---\nid: RFC-0042\nassumes:\n  - RFC-0009\n  - RFC-0029\n---\nbody\n';
    assert.deepEqual(extractRfcListField(src, 'assumes'), ['RFC-0009', 'RFC-0029']);
  });

  it('ignores entries that do not match the RFC pattern', () => {
    const src = '---\nrequires:\n  - RFC-0001\n  - not-an-rfc\n---\n';
    assert.deepEqual(extractRfcListField(src, 'requires'), ['RFC-0001']);
  });

  it('deduplicates entries', () => {
    const src = '---\nrequires:\n  - RFC-0001\n  - RFC-0001\n---\n';
    assert.deepEqual(extractRfcListField(src, 'requires'), ['RFC-0001']);
  });

  it('returns [] when the field is absent', () => {
    const src = '---\nid: RFC-0042\n---\n';
    assert.deepEqual(extractRfcListField(src, 'requires'), []);
    assert.deepEqual(extractRfcListField(src, 'assumes'), []);
  });

  it('accepts raw frontmatter blocks (no opening fence)', () => {
    const src = 'requires: [RFC-0001]\nlifecycle: Implemented\n';
    assert.deepEqual(extractRfcListField(src, 'requires'), ['RFC-0001']);
  });
});

describe('checkRequiresShipped', () => {
  it('passes when toLifecycle is not Implemented', () => {
    const r = checkRequiresShipped({
      toContent: '---\nrequires: [RFC-0001]\n---\n',
      toLifecycle: 'Signed Off',
      rfcId: 'RFC-0042',
      readUpstreamRfcContent: () => '---\nlifecycle: Draft\n---\n',
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.violations, []);
  });

  it('passes when no `requires:` field is declared', () => {
    const r = checkRequiresShipped({
      toContent: '---\nid: RFC-0042\n---\nbody\n',
      toLifecycle: 'Implemented',
      rfcId: 'RFC-0042',
      readUpstreamRfcContent: () => null,
    });
    assert.equal(r.ok, true);
  });

  it('passes when all requires deps are Implemented', () => {
    const r = checkRequiresShipped({
      toContent: '---\nrequires: [RFC-0001, RFC-0002]\n---\n',
      toLifecycle: 'Implemented',
      rfcId: 'RFC-0042',
      readUpstreamRfcContent: (id) => `---\nid: ${id}\nlifecycle: Implemented\n---\n`,
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.violations, []);
  });

  it('flags a violation when a requires dep is at lifecycle Draft', () => {
    const r = checkRequiresShipped({
      toContent: '---\nrequires: [RFC-0001]\n---\n',
      toLifecycle: 'Implemented',
      rfcId: 'RFC-0042',
      readUpstreamRfcContent: () => '---\nlifecycle: Draft\n---\n',
    });
    assert.equal(r.ok, false);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].depId, 'RFC-0001');
    assert.equal(r.violations[0].depLifecycle, 'Draft');
    assert.match(r.diagnostic, /RFC-0001/);
    assert.match(r.diagnostic, /move them to 'assumes:'/);
  });

  it('flags a violation when a requires dep is at Signed Off (not Implemented)', () => {
    const r = checkRequiresShipped({
      toContent: '---\nrequires: [RFC-0001]\n---\n',
      toLifecycle: 'Implemented',
      rfcId: 'RFC-0042',
      readUpstreamRfcContent: () => '---\nlifecycle: Signed Off\n---\n',
    });
    assert.equal(r.ok, false);
    assert.equal(r.violations[0].depLifecycle, 'Signed Off');
  });

  it('flags a missing dep file as a violation', () => {
    const r = checkRequiresShipped({
      toContent: '---\nrequires: [RFC-0001]\n---\n',
      toLifecycle: 'Implemented',
      rfcId: 'RFC-0042',
      readUpstreamRfcContent: () => null,
    });
    assert.equal(r.ok, false);
    assert.equal(r.violations[0].depLifecycle, 'missing');
  });

  it('ignores `assumes:` deps (only checks `requires:`)', () => {
    const r = checkRequiresShipped({
      toContent: '---\nassumes: [RFC-0001]\nrequires: [RFC-0002]\n---\n',
      toLifecycle: 'Implemented',
      rfcId: 'RFC-0042',
      readUpstreamRfcContent: (id) =>
        id === 'RFC-0002' ? '---\nlifecycle: Implemented\n---\n' : '---\nlifecycle: Draft\n---\n',
    });
    // RFC-0001 (assumes:) is Draft but should NOT be flagged.
    // RFC-0002 (requires:) is Implemented — passes.
    assert.equal(r.ok, true);
  });

  it('is a no-op when readUpstreamRfcContent is not provided', () => {
    const r = checkRequiresShipped({
      toContent: '---\nrequires: [RFC-0001]\n---\n',
      toLifecycle: 'Implemented',
      rfcId: 'RFC-0042',
    });
    assert.equal(r.ok, true);
  });
});

describe('checkAllTransitions — requires-shipped warnings (AISDLC-311)', () => {
  it('passes warnings through alongside clean transitions', () => {
    const report = checkAllTransitions([
      {
        rfcId: 'RFC-0042',
        fromContent: '---\nlifecycle: Signed Off\n---\n',
        toContent: '---\nlifecycle: Implemented\nrequires: [RFC-0001]\n---\n',
        readUpstreamRfcContent: () => '---\nlifecycle: Draft\n---\n',
      },
    ]);
    assert.equal(report.failures.length, 0);
    assert.equal(report.warnings.length, 1);
    assert.equal(report.warnings[0].kind, 'requires-not-shipped');
    assert.match(report.warnings[0].diagnostic, /RFC-0001/);
    // Clean transition count: the ladder check still passed (Signed Off → Implemented is legal).
    assert.equal(report.clean, 1);
  });

  it('does not emit warnings when requires-shipped passes', () => {
    const report = checkAllTransitions([
      {
        rfcId: 'RFC-0042',
        fromContent: '---\nlifecycle: Signed Off\n---\n',
        toContent: '---\nlifecycle: Implemented\nrequires: [RFC-0001]\n---\n',
        readUpstreamRfcContent: () => '---\nlifecycle: Implemented\n---\n',
      },
    ]);
    assert.equal(report.warnings.length, 0);
  });

  it('warnings field defaults to empty array when no readUpstreamRfcContent provided', () => {
    const report = checkAllTransitions([
      {
        rfcId: 'RFC-0042',
        fromContent: '---\nlifecycle: Signed Off\n---\n',
        toContent: '---\nlifecycle: Implemented\nrequires: [RFC-0001]\n---\n',
      },
    ]);
    assert.deepEqual(report.warnings, []);
  });
});

describe('reportTransitionsAndExit — warnings rendering', () => {
  it('prints warning diagnostics but still exits 0 when no failures', () => {
    const logs = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args) => logs.push(['log', ...args]);
    console.error = (...args) => logs.push(['err', ...args]);
    try {
      const code = reportTransitionsAndExit({
        failures: [],
        overrides: [],
        warnings: [{ rfcId: 'RFC-0042', diagnostic: '[rfc-lifecycle] WARN ...' }],
        clean: 1,
      });
      assert.equal(code, 0);
      assert.ok(logs.some(([k, msg]) => k === 'log' && /WARN/.test(msg)));
      assert.ok(logs.some(([k, msg]) => k === 'log' && /1 warning/.test(msg)));
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });
});
