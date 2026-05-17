#!/usr/bin/env node
/**
 * check-rfc-lifecycle-transitions.test.mjs — node:test coverage for the
 * RFC lifecycle-transition gate.
 *
 * Run with: `node --test scripts/check-rfc-lifecycle-transitions.test.mjs`
 *
 * Why node:test: same rationale as `scripts/check-rfc-docs.test.mjs` —
 * the script lives at workspace root, has no package.json, and node:test
 * ships with Node >=20 which we already require.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIFECYCLE_STATES,
  FORBIDDEN_TRANSITIONS,
  TERMINAL_STATES,
  OVERRIDE_MARKER_REGEX,
  extractLifecycle,
  parseOverrideMarker,
  checkLifecycleTransition,
  checkAllTransitions,
  reportTransitionsAndExit,
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

  it('passes when toLifecycle is null (file deleted)', () => {
    const r = checkLifecycleTransition({
      fromLifecycle: 'Draft',
      toLifecycle: null,
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
});

describe('checkLifecycleTransition — operator override', () => {
  const forbiddenFrom = 'Draft';
  const forbiddenTo = 'Signed Off';

  it('honors override marker in prBody', () => {
    const prBody = '<!-- ai-sdlc:lifecycle-jump-approved-by:dominique reason:hotfix-required -->';
    const r = checkLifecycleTransition({
      fromLifecycle: forbiddenFrom,
      toLifecycle: forbiddenTo,
      rfcId: 'RFC-9999',
      prBody,
    });
    assert.ok(r.ok);
    assert.ok(r.override);
    assert.equal(r.override.operator, 'dominique');
    assert.equal(r.override.reason, 'hotfix-required');
  });

  it('honors override marker in rfcBody', () => {
    const rfcBody =
      '# RFC Body\n\n<!-- ai-sdlc:lifecycle-jump-approved-by:alice reason:design-stable -->\n\nMore text.';
    const r = checkLifecycleTransition({
      fromLifecycle: forbiddenFrom,
      toLifecycle: forbiddenTo,
      rfcId: 'RFC-9999',
      rfcBody,
    });
    assert.ok(r.ok);
    assert.ok(r.override);
    assert.equal(r.override.operator, 'alice');
  });

  it('prBody marker takes precedence when both are present', () => {
    const prBody = '<!-- ai-sdlc:lifecycle-jump-approved-by:pr-author reason:from-pr -->';
    const rfcBody =
      '# Body\n<!-- ai-sdlc:lifecycle-jump-approved-by:rfc-author reason:from-rfc -->';
    const r = checkLifecycleTransition({
      fromLifecycle: forbiddenFrom,
      toLifecycle: forbiddenTo,
      rfcId: 'RFC-9999',
      prBody,
      rfcBody,
    });
    assert.ok(r.ok);
    assert.equal(r.override.operator, 'pr-author');
  });

  it('fails when override marker is malformed (missing reason)', () => {
    const prBody = '<!-- ai-sdlc:lifecycle-jump-approved-by:dominique -->';
    const r = checkLifecycleTransition({
      fromLifecycle: forbiddenFrom,
      toLifecycle: forbiddenTo,
      rfcId: 'RFC-9999',
      prBody,
    });
    // Malformed marker should NOT be treated as an approved override.
    assert.ok(!r.ok);
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

  it('records override entries for approved jumps', () => {
    const prBody = '<!-- ai-sdlc:lifecycle-jump-approved-by:dominique reason:emergency -->';
    const transitions = [
      {
        rfcId: 'RFC-0020',
        fromContent: rfcWithLifecycle('Draft'),
        toContent: rfcWithLifecycle('Signed Off'),
        prBody,
      },
    ];
    const r = checkAllTransitions(transitions);
    assert.deepEqual(r.failures, []);
    assert.equal(r.overrides.length, 1);
    assert.equal(r.overrides[0].rfcId, 'RFC-0020');
    assert.equal(r.overrides[0].override.operator, 'dominique');
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

  it('handles deleted file (toContent null)', () => {
    const transitions = [
      {
        rfcId: 'RFC-0070',
        fromContent: rfcWithLifecycle('Signed Off'),
        toContent: null,
      },
    ];
    const r = checkAllTransitions(transitions);
    assert.deepEqual(r.failures, []);
    assert.equal(r.clean, 1);
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

  it('exits 0 with override marker in --pr-body for forbidden transition', () => {
    const before = makeTempRfcFile('Draft');
    const after = makeTempRfcFile('Implemented');
    const marker = '<!-- ai-sdlc:lifecycle-jump-approved-by:dominique reason:emergency-hotfix -->';
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
      assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.match(r.stdout, /OVERRIDE/);
    } finally {
      rmSync(before.dir, { recursive: true, force: true });
      rmSync(after.dir, { recursive: true, force: true });
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
});
