/**
 * Tests for the upstream-OQ gate (AISDLC-296 / RFC-0011 extension).
 *
 * Acceptance criteria:
 *   #1  DoR rubric checks referenced RFC's lifecycle field; rejects on
 *       `Draft` or `Ready for Review`
 *   #2  DoR rubric scans referenced RFC's §OQ section; rejects on any
 *       unresolved OQ
 *   #3  `DorRejectedByOpenUpstreamOq` event emitted with RFC ref + OQ count
 *   #4  Manual override via `blocked.reason` with explicit operator note
 *   #5  Test coverage: rejected-on-draft-RFC, rejected-on-open-OQ,
 *       accepted-on-signed-off + zero-OQ
 */

import { describe, expect, it } from 'vitest';
import {
  checkRfc,
  checkUpstreamOqs,
  extractBlockedReason,
  extractRfcIdsFromBody,
  extractRfcLifecycle,
  extractRfcReferences,
  findUnresolvedOqs,
  resolveRfcFilePath,
} from './upstream-oq-gate.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RFC_SIGNED_OFF_ZERO_OQ = `---
id: RFC-9901
title: Signed Off RFC with no OQs
lifecycle: Signed Off
---
## 1. Summary
Stuff.
## 13. Open Questions
No open questions — all resolved before sign-off.
`;

const RFC_SIGNED_OFF_WITH_OQ_RESOLVED = `---
id: RFC-9902
title: Signed Off RFC with resolved OQs
lifecycle: Signed Off
---
## 1. Summary
Stuff.
## 13. Open Questions
**OQ-1 — Should we cache? YES.**

**Resolution:** Yes, cache with a 5-minute TTL.

**OQ-2 — Log level?**

**Resolution:** Use INFO for happy path, ERROR for failures.
`;

const RFC_DRAFT_ZERO_OQ = `---
id: RFC-9903
title: Draft RFC
lifecycle: Draft
---
## 1. Summary
Work in progress.
## 13. Open Questions
These need decisions before sign-off:

1. Q1 — Which approach?
2. Q2 — Database or file?
`;

const RFC_READY_FOR_REVIEW_ZERO_OQ = `---
id: RFC-9904
title: Ready for Review RFC
lifecycle: Ready for Review
---
## 1. Summary
Awaiting sign-off.
## 13. Open Questions
None.
`;

const RFC_IMPLEMENTED_WITH_OPEN_OQ = `---
id: RFC-9905
title: Implemented RFC but with open OQ
lifecycle: Implemented
---
## 1. Summary
Shipped but editing oversight left one OQ open.
## 13. Open Questions
**OQ-1 — Retry strategy?**

Some discussion here but no firm resolution.

**OQ-2 — Timeout?**

**Resolution:** 30 seconds.
`;

const RFC_IMPLEMENTED_ZERO_OQ = `---
id: RFC-9906
title: Implemented RFC
lifecycle: Implemented
---
## 1. Summary
Fully shipped.
## 13. Open Questions
All resolved — see §3 for details.
`;

// ---------------------------------------------------------------------------
// extractRfcLifecycle
// ---------------------------------------------------------------------------

describe('extractRfcLifecycle', () => {
  it('extracts lifecycle from frontmatter', () => {
    expect(extractRfcLifecycle(RFC_SIGNED_OFF_ZERO_OQ)).toBe('Signed Off');
    expect(extractRfcLifecycle(RFC_DRAFT_ZERO_OQ)).toBe('Draft');
    expect(extractRfcLifecycle(RFC_READY_FOR_REVIEW_ZERO_OQ)).toBe('Ready for Review');
    expect(extractRfcLifecycle(RFC_IMPLEMENTED_ZERO_OQ)).toBe('Implemented');
  });

  it('returns unknown when lifecycle is absent', () => {
    expect(extractRfcLifecycle('---\nid: RFC-0001\ntitle: Foo\n---\nbody')).toBe('unknown');
  });

  it('returns unknown when no frontmatter', () => {
    expect(extractRfcLifecycle('# No frontmatter')).toBe('unknown');
  });

  it('strips quotes from lifecycle value', () => {
    const content = "---\nlifecycle: 'Signed Off'\n---\nbody";
    expect(extractRfcLifecycle(content)).toBe('Signed Off');
  });
});

// ---------------------------------------------------------------------------
// extractBlockedReason
// ---------------------------------------------------------------------------

describe('extractBlockedReason', () => {
  it('returns null when no blocked field', () => {
    expect(extractBlockedReason('id: AISDLC-1\nstatus: To Do')).toBeNull();
  });

  it('extracts two-line blocked.reason', () => {
    const fm = 'id: AISDLC-1\nblocked:\n  reason: OQs still open\nstatus: To Do';
    expect(extractBlockedReason(fm)).toBe('OQs still open');
  });

  it('extracts two-line blocked.reason with single quotes', () => {
    const fm = "id: AISDLC-1\nblocked:\n  reason: 'RFC-0025 has open OQs'\nstatus: To Do";
    expect(extractBlockedReason(fm)).toBe('RFC-0025 has open OQs');
  });

  it('extracts two-line blocked.reason with double quotes', () => {
    const fm = 'id: AISDLC-1\nblocked:\n  reason: "operator reviewed"\nstatus: To Do';
    expect(extractBlockedReason(fm)).toBe('operator reviewed');
  });

  it('extracts inline brace form', () => {
    const fm = "id: AISDLC-1\nblocked: { reason: 'acknowledged' }\nstatus: To Do";
    expect(extractBlockedReason(fm)).toBe('acknowledged');
  });

  it('returns null for empty reason after trim', () => {
    const fm = "id: AISDLC-1\nblocked:\n  reason: ''\nstatus: To Do";
    expect(extractBlockedReason(fm)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractRfcReferences
// ---------------------------------------------------------------------------

describe('extractRfcReferences', () => {
  it('extracts RFC path references from frontmatter references list', () => {
    const fm =
      'references:\n  - spec/rfcs/RFC-0024-emergent-issue.md\n  - backlog/tasks/foo.md\n  - spec/rfcs/RFC-0025-quality.md';
    const refs = extractRfcReferences(fm);
    expect(refs).toContain('spec/rfcs/RFC-0024-emergent-issue.md');
    expect(refs).toContain('spec/rfcs/RFC-0025-quality.md');
    expect(refs).not.toContain('backlog/tasks/foo.md');
  });

  it('extracts bare RFC-NNNN identifiers', () => {
    const fm = 'references:\n  - RFC-0011\n  - RFC-0024';
    const refs = extractRfcReferences(fm);
    expect(refs).toContain('RFC-0011');
    expect(refs).toContain('RFC-0024');
  });

  it('returns empty when no references section', () => {
    expect(extractRfcReferences('id: AISDLC-1\nstatus: To Do')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractRfcIdsFromBody
// ---------------------------------------------------------------------------

describe('extractRfcIdsFromBody', () => {
  it('extracts RFC-NNNN references from body text', () => {
    const body = 'Implements RFC-0024 and closes RFC-0025.';
    const ids = extractRfcIdsFromBody(body);
    expect(ids).toContain('RFC-0024');
    expect(ids).toContain('RFC-0025');
  });

  it('deduplicates references', () => {
    const body = 'RFC-0011 is referenced here and again RFC-0011.';
    const ids = extractRfcIdsFromBody(body);
    expect(ids.filter((id) => id === 'RFC-0011')).toHaveLength(1);
  });

  it('returns empty when no RFC references', () => {
    expect(extractRfcIdsFromBody('no rfc references here')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// findUnresolvedOqs
// ---------------------------------------------------------------------------

describe('findUnresolvedOqs', () => {
  it('returns empty when no OQ section', () => {
    expect(findUnresolvedOqs('# No OQ section\nJust body.')).toHaveLength(0);
  });

  it('returns empty when all OQs have Resolution markers (Signed Off RFC)', () => {
    expect(findUnresolvedOqs(RFC_SIGNED_OFF_WITH_OQ_RESOLVED)).toHaveLength(0);
  });

  it('returns empty for OQ section with no question entries', () => {
    expect(findUnresolvedOqs(RFC_SIGNED_OFF_ZERO_OQ)).toHaveLength(0);
  });

  it('returns unresolved OQs for a Draft RFC with unresolved entries', () => {
    const unresolved = findUnresolvedOqs(RFC_DRAFT_ZERO_OQ);
    expect(unresolved.length).toBeGreaterThan(0);
  });

  it('returns unresolved OQs for Implemented RFC with one open OQ', () => {
    const unresolved = findUnresolvedOqs(RFC_IMPLEMENTED_WITH_OPEN_OQ);
    // OQ-1 should be unresolved; OQ-2 should be resolved.
    expect(unresolved.length).toBe(1);
    expect(unresolved[0]).toMatch(/OQ-1/i);
  });

  it('detects RESOLVED: marker', () => {
    const content = `---\nlifecycle: Implemented\n---\n## Open Questions\n**OQ-1 — Foo?**\n\nRESOLVED: Use the existing pattern.\n`;
    expect(findUnresolvedOqs(content)).toHaveLength(0);
  });

  it('detects emoji RESOLVED marker', () => {
    const content = `---\nlifecycle: Implemented\n---\n## Open Questions\n**OQ-1 — Bar?**\n\n✅ RESOLVED: Confirmed.\n`;
    expect(findUnresolvedOqs(content)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checkRfc
// ---------------------------------------------------------------------------

describe('checkRfc', () => {
  it('accepts Signed Off RFC with no OQs (AC #5 — accepted-on-signed-off + zero-OQ)', () => {
    const result = checkRfc({
      rfcId: 'RFC-9901',
      rfcFilePath: '/fake/path',
      rfcContent: RFC_SIGNED_OFF_ZERO_OQ,
    });
    expect(result.rejected).toBe(false);
    expect(result.lifecycleBlocked).toBe(false);
    expect(result.unresolvedOqCount).toBe(0);
    expect(result.lifecycle).toBe('Signed Off');
  });

  it('accepts Implemented RFC with all OQs resolved', () => {
    const result = checkRfc({
      rfcId: 'RFC-9902',
      rfcFilePath: '/fake/path',
      rfcContent: RFC_SIGNED_OFF_WITH_OQ_RESOLVED,
    });
    expect(result.rejected).toBe(false);
    expect(result.unresolvedOqCount).toBe(0);
  });

  it('rejects Draft RFC (AC #1 — rejected-on-draft-RFC)', () => {
    const result = checkRfc({
      rfcId: 'RFC-9903',
      rfcFilePath: '/fake/path',
      rfcContent: RFC_DRAFT_ZERO_OQ,
    });
    expect(result.rejected).toBe(true);
    expect(result.lifecycleBlocked).toBe(true);
    expect(result.lifecycle).toBe('Draft');
  });

  it('rejects Ready for Review RFC (AC #1 — lifecycle gate)', () => {
    const result = checkRfc({
      rfcId: 'RFC-9904',
      rfcFilePath: '/fake/path',
      rfcContent: RFC_READY_FOR_REVIEW_ZERO_OQ,
    });
    expect(result.rejected).toBe(true);
    expect(result.lifecycleBlocked).toBe(true);
    expect(result.lifecycle).toBe('Ready for Review');
  });

  it('rejects Implemented RFC with open OQ (AC #2 — rejected-on-open-OQ)', () => {
    const result = checkRfc({
      rfcId: 'RFC-9905',
      rfcFilePath: '/fake/path',
      rfcContent: RFC_IMPLEMENTED_WITH_OPEN_OQ,
    });
    expect(result.rejected).toBe(true);
    expect(result.lifecycleBlocked).toBe(false); // lifecycle is fine
    expect(result.unresolvedOqCount).toBe(1);
  });

  it('returns non-rejected when RFC file not found', () => {
    // Missing file: gate does not hard-block on missing RFC (operator should
    // catch via Gate 3 reference resolution).
    const result = checkRfc({
      rfcId: 'RFC-9999',
      rfcFilePath: '/nonexistent/RFC-9999-foo.md',
    });
    expect(result.rejected).toBe(false);
    expect(result.lifecycle).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// checkUpstreamOqs (integration)
// ---------------------------------------------------------------------------

describe('checkUpstreamOqs', () => {
  // Build a temp directory with RFC stubs for filesystem tests.
  let tmp: string;
  const setup = (): string => {
    tmp = mkdtempSync(join(tmpdir(), 'dor-oq-gate-'));
    mkdirSync(join(tmp, 'spec', 'rfcs'), { recursive: true });
    writeFileSync(
      join(tmp, 'spec', 'rfcs', 'RFC-9901-signed-off-zero-oq.md'),
      RFC_SIGNED_OFF_ZERO_OQ,
    );
    writeFileSync(join(tmp, 'spec', 'rfcs', 'RFC-9903-draft.md'), RFC_DRAFT_ZERO_OQ);
    writeFileSync(
      join(tmp, 'spec', 'rfcs', 'RFC-9905-impl-open-oq.md'),
      RFC_IMPLEMENTED_WITH_OPEN_OQ,
    );
    return tmp;
  };
  const teardown = (): void => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  };

  it('AC #4 — manual override via blocked.reason skips the gate', () => {
    const dir = setup();
    try {
      const result = checkUpstreamOqs({
        taskId: 'AISDLC-1',
        frontmatter:
          "id: AISDLC-1\nblocked:\n  reason: 'RFC-0024 OQs acknowledged by operator'\nreferences:\n  - spec/rfcs/RFC-9903-draft.md",
        body: '',
        workDir: dir,
      });
      expect(result.rejected).toBe(false);
      expect(result.manualOverride).toBe(true);
      expect(result.overrideReason).toMatch(/acknowledged/);
      expect(result.events).toHaveLength(0);
    } finally {
      teardown();
    }
  });

  it('AC #5 — accepted-on-signed-off + zero-OQ (no rejection)', () => {
    const dir = setup();
    try {
      const result = checkUpstreamOqs({
        taskId: 'AISDLC-2',
        frontmatter: 'id: AISDLC-2\nreferences:\n  - spec/rfcs/RFC-9901-signed-off-zero-oq.md',
        body: '',
        workDir: dir,
      });
      expect(result.rejected).toBe(false);
      expect(result.events).toHaveLength(0);
      expect(result.rfcChecks).toHaveLength(1);
      expect(result.rfcChecks[0]!.rejected).toBe(false);
    } finally {
      teardown();
    }
  });

  it('AC #1 + #3 — rejects on Draft RFC + emits DorRejectedByOpenUpstreamOq event', () => {
    const dir = setup();
    try {
      const result = checkUpstreamOqs({
        taskId: 'AISDLC-3',
        frontmatter: 'id: AISDLC-3\nreferences:\n  - spec/rfcs/RFC-9903-draft.md',
        body: '',
        workDir: dir,
      });
      expect(result.rejected).toBe(true);
      expect(result.events).toHaveLength(1);
      const evt = result.events[0]!;
      expect(evt.eventType).toBe('DorRejectedByOpenUpstreamOq');
      expect(evt.taskId).toBe('AISDLC-3');
      expect(evt.rfcRef).toContain('RFC-9903');
      expect(evt.lifecycleBlocked).toBe(true);
      expect(evt.lifecycle).toBe('Draft');
    } finally {
      teardown();
    }
  });

  it('AC #2 + #3 — rejects on open OQ + emits event with correct OQ count', () => {
    const dir = setup();
    try {
      const result = checkUpstreamOqs({
        taskId: 'AISDLC-4',
        frontmatter: 'id: AISDLC-4\nreferences:\n  - spec/rfcs/RFC-9905-impl-open-oq.md',
        body: '',
        workDir: dir,
      });
      expect(result.rejected).toBe(true);
      expect(result.events).toHaveLength(1);
      const evt = result.events[0]!;
      expect(evt.eventType).toBe('DorRejectedByOpenUpstreamOq');
      expect(evt.openOqCount).toBe(1);
      expect(evt.lifecycleBlocked).toBe(false);
    } finally {
      teardown();
    }
  });

  it('reads RFC refs from body when not in frontmatter references', () => {
    const dir = setup();
    try {
      // No references: in frontmatter, but body mentions RFC-9903.
      const result = checkUpstreamOqs({
        taskId: 'AISDLC-5',
        frontmatter: 'id: AISDLC-5\nstatus: To Do',
        body: 'This task implements RFC-9903 work.',
        workDir: dir,
      });
      expect(result.rejected).toBe(true);
      expect(result.rfcChecks[0]!.rfcId).toBe('RFC-9903');
    } finally {
      teardown();
    }
  });

  it('deduplicates when RFC appears in both frontmatter and body', () => {
    const dir = setup();
    try {
      const result = checkUpstreamOqs({
        taskId: 'AISDLC-6',
        frontmatter: 'id: AISDLC-6\nreferences:\n  - spec/rfcs/RFC-9901-signed-off-zero-oq.md',
        body: 'Also references RFC-9901 inline.',
        workDir: dir,
      });
      // Should only check RFC-9901 once.
      expect(result.rfcChecks).toHaveLength(1);
    } finally {
      teardown();
    }
  });

  it('returns non-rejected when no RFC references anywhere', () => {
    const dir = setup();
    try {
      const result = checkUpstreamOqs({
        taskId: 'AISDLC-7',
        frontmatter: 'id: AISDLC-7\nstatus: To Do',
        body: 'No RFC references.',
        workDir: dir,
      });
      expect(result.rejected).toBe(false);
      expect(result.rfcChecks).toHaveLength(0);
    } finally {
      teardown();
    }
  });

  it('uses readRfcFile override (test double for I/O)', () => {
    const readRfcFile = (filePath: string): string | null => {
      if (filePath.includes('RFC-9903')) return RFC_DRAFT_ZERO_OQ;
      return null;
    };
    const result = checkUpstreamOqs({
      taskId: 'AISDLC-8',
      frontmatter: 'id: AISDLC-8\nreferences:\n  - spec/rfcs/RFC-9903-draft.md',
      body: '',
      workDir: '/nonexistent',
      readRfcFile,
    });
    expect(result.rejected).toBe(true);
    expect(result.events[0]!.lifecycle).toBe('Draft');
  });

  it('surfaces rejectionSummary on rejection', () => {
    const dir = setup();
    try {
      const result = checkUpstreamOqs({
        taskId: 'AISDLC-9',
        frontmatter: 'id: AISDLC-9\nreferences:\n  - spec/rfcs/RFC-9903-draft.md',
        body: '',
        workDir: dir,
      });
      expect(result.rejectionSummary).toMatch(/upstream-OQ gate blocked/);
      expect(result.rejectionSummary).toMatch(/RFC-9903/);
    } finally {
      teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// resolveRfcFilePath
// ---------------------------------------------------------------------------

describe('resolveRfcFilePath', () => {
  let tmp: string;

  it('resolves bare RFC-NNNN id to file', () => {
    tmp = mkdtempSync(join(tmpdir(), 'dor-oq-resolve-'));
    mkdirSync(join(tmp, 'spec', 'rfcs'), { recursive: true });
    writeFileSync(join(tmp, 'spec', 'rfcs', 'RFC-0011-definition-of-ready-gate.md'), '');
    expect(resolveRfcFilePath('RFC-0011', tmp)).toContain('RFC-0011');
    rmSync(tmp, { recursive: true, force: true });
  });

  it('resolves spec/rfcs/ path directly', () => {
    tmp = mkdtempSync(join(tmpdir(), 'dor-oq-resolve-'));
    mkdirSync(join(tmp, 'spec', 'rfcs'), { recursive: true });
    writeFileSync(join(tmp, 'spec', 'rfcs', 'RFC-0011-definition-of-ready-gate.md'), '');
    expect(resolveRfcFilePath('spec/rfcs/RFC-0011-definition-of-ready-gate.md', tmp)).toBeTruthy();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when RFC not found', () => {
    tmp = mkdtempSync(join(tmpdir(), 'dor-oq-resolve-'));
    mkdirSync(join(tmp, 'spec', 'rfcs'), { recursive: true });
    expect(resolveRfcFilePath('RFC-9999', tmp)).toBeNull();
    rmSync(tmp, { recursive: true, force: true });
  });
});
