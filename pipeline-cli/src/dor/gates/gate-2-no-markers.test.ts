import { describe, expect, it } from 'vitest';
import { evaluateGate2, findMarkers, stripFencedCode } from './gate-2-no-markers.js';
import type { IssueInput } from '../types.js';

function input(body: string): IssueInput {
  return { source: 'backlog', id: 'AISDLC-1', title: 't', body };
}

describe('stripFencedCode', () => {
  it('removes triple-backtick blocks', () => {
    const stripped = stripFencedCode('hello\n```\n// TODO me\n```\nworld');
    expect(stripped).not.toMatch(/TODO/);
  });
});

describe('findMarkers', () => {
  it('finds TBD', () => {
    expect(findMarkers('the design is TBD').length).toBe(1);
  });
  it('finds tbd case-insensitive', () => {
    expect(findMarkers('the design is tbd').length).toBe(1);
  });
  it('finds TODO bare', () => {
    expect(findMarkers('TODO add tests').length).toBe(1);
  });
  it('does not flag substrings like "fixmessage"', () => {
    expect(findMarkers('fixmessage logic').length).toBe(0);
  });
  it('finds ???', () => {
    expect(findMarkers('what about edge case ???').length).toBe(1);
  });
  it('finds "not sure"', () => {
    expect(findMarkers('not sure how to handle this').length).toBe(1);
  });
  it('finds "we\'ll figure it out"', () => {
    expect(findMarkers("we'll figure it out later").length).toBe(1);
  });
  it('finds "decide later"', () => {
    expect(findMarkers('decide later').length).toBe(1);
  });
  it('finds "up to the dev"', () => {
    expect(findMarkers('up to the dev to choose').length).toBe(1);
  });
  it('finds "to be determined"', () => {
    expect(findMarkers('design to be determined').length).toBe(1);
  });
  it('finds "to be decided"', () => {
    expect(findMarkers('format to be decided').length).toBe(1);
  });
  it('finds placeholder', () => {
    expect(findMarkers('this is a placeholder paragraph').length).toBe(1);
  });
  it('does not flag markers inside fenced code', () => {
    expect(findMarkers('```\nTODO\n```').length).toBe(0);
  });
});

describe('evaluateGate2', () => {
  it('passes a clean body', () => {
    const v = evaluateGate2(input('A clean issue body with no hedges.'));
    expect(v.verdict).toBe('pass');
  });
  it('fails on TBD', () => {
    const v = evaluateGate2(input('The plan is TBD.'));
    expect(v.verdict).toBe('fail');
    expect(v.finding).toMatch(/unresolved/);
  });
  it('caps the per-marker summary at 5', () => {
    const body = 'TBD TODO XXX FIXME ??? not sure decide later';
    const v = evaluateGate2(input(body));
    expect(v.verdict).toBe('fail');
    // The summary lists only the first 5
    expect(v.finding?.split(';').length).toBeLessThanOrEqual(5);
  });
});
