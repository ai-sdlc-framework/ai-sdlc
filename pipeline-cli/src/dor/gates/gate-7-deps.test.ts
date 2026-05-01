import { describe, expect, it } from 'vitest';
import { evaluateGate7, findInvisibleDependencies } from './gate-7-deps.js';
import type { IssueInput } from '../types.js';

function input(body: string, references?: string[]): IssueInput {
  return { source: 'backlog', id: 'AISDLC-1', title: 't', body, references };
}

describe('findInvisibleDependencies', () => {
  it('finds bare "depends on X" without ref', () => {
    const offenders = findInvisibleDependencies(input('depends on the auth rewrite'));
    expect(offenders.length).toBe(1);
  });
  it('finds bare "blocked by"', () => {
    const offenders = findInvisibleDependencies(input('blocked by the search refactor'));
    expect(offenders.length).toBe(1);
  });
  it('finds "after X ships" pattern', () => {
    const offenders = findInvisibleDependencies(input('Build after the auth rewrite ships.'));
    expect(offenders.length).toBe(1);
  });
  it('finds "once X lands" pattern', () => {
    const offenders = findInvisibleDependencies(input('Do this once auth lands.'));
    expect(offenders.length).toBe(1);
  });
  it('passes when same sentence has tracked AISDLC ref', () => {
    const offenders = findInvisibleDependencies(input('depends on AISDLC-101 finishing'));
    expect(offenders.length).toBe(0);
  });
  it('passes when same sentence has #NN ref', () => {
    const offenders = findInvisibleDependencies(input('depends on #42 landing'));
    expect(offenders.length).toBe(0);
  });
  it('passes when explicit references list is set', () => {
    const offenders = findInvisibleDependencies(
      input('depends on the auth rewrite', ['AISDLC-101']),
    );
    expect(offenders.length).toBe(0);
  });
  it('finds "prerequisite" without ref', () => {
    const offenders = findInvisibleDependencies(input('prerequisite to ship anything'));
    expect(offenders.length).toBe(1);
  });
});

describe('evaluateGate7', () => {
  it('passes a clean body', () => {
    const v = evaluateGate7(input('plain body'));
    expect(v.verdict).toBe('pass');
  });
  it('fails on bare "depends on"', () => {
    const v = evaluateGate7(input('depends on the auth rewrite'));
    expect(v.verdict).toBe('fail');
    expect(v.finding).toMatch(/dependency phrase/);
  });
  it('passes when explicit references[] supplies the link', () => {
    const v = evaluateGate7(input('depends on the auth rewrite', ['AISDLC-101']));
    expect(v.verdict).toBe('pass');
  });
});
