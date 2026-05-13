/**
 * Unit tests for RFC-0024 §5.2 PR-comment marker parser.
 */

import { describe, expect, it } from 'vitest';
import {
  parsePrCommentMarker,
  findCaptureComments,
  PR_CAPTURE_MARKER,
} from './pr-comment-parser.js';

describe('parsePrCommentMarker', () => {
  it('returns found=false when no marker is present', () => {
    const result = parsePrCommentMarker('This is a normal PR comment without a marker.');
    expect(result.found).toBe(false);
    expect(result.markerLineIndex).toBe(-1);
  });

  it('detects a marker on the first line', () => {
    const body = `<!-- ai-sdlc:capture severity=major triage=new-issue -->
The session token rotation doesn't handle clock skew.`;
    const result = parsePrCommentMarker(body);
    expect(result.found).toBe(true);
    expect(result.severity).toBe('major');
    expect(result.triage).toBe('new-issue');
    expect(result.markerLineIndex).toBe(0);
    expect(result.finding).toContain('clock skew');
  });

  it('detects a marker on a middle line', () => {
    const body = `Some preamble text.
<!-- ai-sdlc:capture severity=minor triage=quick-fix -->
This is the actual finding.`;
    const result = parsePrCommentMarker(body);
    expect(result.found).toBe(true);
    expect(result.markerLineIndex).toBe(1);
    expect(result.finding).toContain('actual finding');
  });

  it('parses severity without triage', () => {
    const body = `<!-- ai-sdlc:capture severity=critical -->
Critical finding here.`;
    const result = parsePrCommentMarker(body);
    expect(result.found).toBe(true);
    expect(result.severity).toBe('critical');
    expect(result.triage).toBeUndefined();
  });

  it('parses triage without severity', () => {
    const body = `<!-- ai-sdlc:capture triage=framework-bug -->
Framework misbehaved.`;
    const result = parsePrCommentMarker(body);
    expect(result.found).toBe(true);
    expect(result.triage).toBe('framework-bug');
    expect(result.severity).toBeUndefined();
  });

  it('ignores invalid severity values', () => {
    const body = `<!-- ai-sdlc:capture severity=extreme triage=new-issue -->
Finding.`;
    const result = parsePrCommentMarker(body);
    expect(result.found).toBe(true);
    expect(result.severity).toBeUndefined(); // 'extreme' is not valid
    expect(result.triage).toBe('new-issue');
  });

  it('uses comment body as finding when marker is the only content', () => {
    const body = `<!-- ai-sdlc:capture severity=major triage=new-issue -->`;
    const result = parsePrCommentMarker(body);
    expect(result.found).toBe(true);
    // finding falls back to the whole comment body when body after marker is empty
    expect(result.finding).toBeTruthy();
  });

  it('uses the first marker when multiple are present', () => {
    const body = `<!-- ai-sdlc:capture severity=major triage=new-issue -->
First finding.
<!-- ai-sdlc:capture severity=minor triage=quick-fix -->
Second finding.`;
    const result = parsePrCommentMarker(body);
    expect(result.found).toBe(true);
    expect(result.markerLineIndex).toBe(0);
    expect(result.severity).toBe('major');
  });
});

describe('findCaptureComments', () => {
  it('returns empty array when no comments have markers', () => {
    const comments = [
      { body: 'LGTM!', author: { login: 'alice' } },
      { body: 'Nice work!', author: { login: 'bob' } },
    ];
    expect(findCaptureComments(comments)).toHaveLength(0);
  });

  it('returns only comments with markers', () => {
    const comments = [
      { body: 'LGTM!', author: { login: 'alice' } },
      {
        body: `<!-- ai-sdlc:capture severity=major triage=new-issue -->\nFinding here.`,
        author: { login: 'bob' },
      },
      { body: 'Looks good.', author: { login: 'carol' } },
    ];
    const found = findCaptureComments(comments);
    expect(found).toHaveLength(1);
    expect(found[0].comment.author?.login).toBe('bob');
    expect(found[0].marker.severity).toBe('major');
  });

  it('handles fast-path: skips comments without the marker substring', () => {
    // Comments not containing the marker substring should be fast-skipped.
    const comments = [
      { body: 'No marker here' },
      { body: `<!-- ${PR_CAPTURE_MARKER} severity=minor triage=tbd -->\nFinding.` },
    ];
    const found = findCaptureComments(comments);
    expect(found).toHaveLength(1);
  });
});
