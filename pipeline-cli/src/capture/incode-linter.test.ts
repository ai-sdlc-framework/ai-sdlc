/**
 * Unit tests for RFC-0024 §5.3 in-code marker linter.
 */

import { describe, expect, it } from 'vitest';
import {
  parseIncodeMarkers,
  markersToWarnings,
  renderLinterWarnings,
  INCODE_CAPTURE_MARKER,
} from './incode-linter.js';

describe('parseIncodeMarkers', () => {
  it('returns empty array when no markers are present', () => {
    const content = `
// TODO: old-style comment
function foo() { return 42; }
`;
    expect(parseIncodeMarkers('foo.ts', content)).toHaveLength(0);
  });

  it('detects a single marker with severity and triage', () => {
    const content = `
// ai-sdlc:capture severity=minor triage=new-issue
// The retry loop here doesn't apply jitter; could thunder-herd.
function retryWithBackoff() {}
`;
    const marks = parseIncodeMarkers('src/retry.ts', content);
    expect(marks).toHaveLength(1);
    expect(marks[0].line).toBe(2);
    expect(marks[0].severity).toBe('minor');
    expect(marks[0].triage).toBe('new-issue');
    expect(marks[0].finding).toContain('jitter');
    expect(marks[0].filePath).toBe('src/retry.ts');
  });

  it('detects a marker without severity or triage', () => {
    const content = `// ai-sdlc:capture
// Finding: something is broken here.
const x = 1;
`;
    const marks = parseIncodeMarkers('x.ts', content);
    expect(marks).toHaveLength(1);
    expect(marks[0].severity).toBeUndefined();
    expect(marks[0].triage).toBeUndefined();
    expect(marks[0].finding).toContain('broken');
  });

  it('collects multi-line comment finding', () => {
    const content = `// ai-sdlc:capture severity=major triage=new-feature-issue
// Line 1 of finding.
// Line 2 of finding.
// Line 3 of finding.
function doSomething() {}
`;
    const marks = parseIncodeMarkers('z.ts', content);
    expect(marks).toHaveLength(1);
    expect(marks[0].finding).toContain('Line 1');
    expect(marks[0].finding).toContain('Line 3');
  });

  it('stops collecting finding at non-comment line', () => {
    const content = `// ai-sdlc:capture severity=minor
// Finding text.
const nonComment = true;
// This comment is after the non-comment line — not part of the finding.
`;
    const marks = parseIncodeMarkers('z.ts', content);
    expect(marks[0].finding).toContain('Finding text');
    expect(marks[0].finding).not.toContain('not part');
  });

  it('detects multiple markers in one file', () => {
    const content = `
// ai-sdlc:capture severity=minor triage=new-issue
// First finding.

// ai-sdlc:capture severity=major triage=framework-bug
// Second finding.
`;
    const marks = parseIncodeMarkers('multi.ts', content);
    expect(marks).toHaveLength(2);
    expect(marks[0].finding).toContain('First');
    expect(marks[1].finding).toContain('Second');
    expect(marks[1].severity).toBe('major');
  });

  it('ignores unknown severity values', () => {
    const content = `// ai-sdlc:capture severity=extreme triage=new-issue
// Finding.
`;
    const marks = parseIncodeMarkers('x.ts', content);
    expect(marks[0].severity).toBeUndefined();
    expect(marks[0].triage).toBe('new-issue');
  });
});

describe('markersToWarnings', () => {
  it('converts markers to IncodeMarkerWarning objects', () => {
    const marks = parseIncodeMarkers(
      'foo.ts',
      `// ai-sdlc:capture severity=minor triage=new-issue\n// Finding.\n`,
    );
    const warnings = markersToWarnings(marks);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].location).toBe('foo.ts:1');
    expect(warnings[0].message).toContain('ai-sdlc:capture');
    expect(warnings[0].message).toContain('severity=minor');
  });
});

describe('renderLinterWarnings', () => {
  it('returns empty string for no warnings', () => {
    expect(renderLinterWarnings([])).toBe('');
  });

  it('renders each warning prefixed with "warning:"', () => {
    const marks = parseIncodeMarkers(
      'x.ts',
      `// ${INCODE_CAPTURE_MARKER.replace('//', '').trim()} severity=minor triage=new-issue\n// Finding.\n`,
    );
    const warnings = markersToWarnings(marks);
    const rendered = renderLinterWarnings(warnings);
    expect(rendered).toMatch(/^warning:/m);
    expect(rendered).toContain('x.ts:1');
  });
});
