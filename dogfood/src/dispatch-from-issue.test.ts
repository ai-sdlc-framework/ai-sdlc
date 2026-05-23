/**
 * Hermetic tests for `fetchGhIssueAsTaskSpec` + helpers.
 *
 * AISDLC-393 AC-2: the GH-issue path synthesizes an in-memory TaskSpec from
 * the issue (no backlog file written). These tests drive that synthesis with
 * an injectable `gh` stub so no real `gh` binary is required.
 */

import { describe, it, expect } from 'vitest';
import {
  extractAcceptanceCriteria,
  extractPermittedExternalPaths,
  fetchGhIssueAsTaskSpec,
} from './dispatch-from-issue.js';

function ghStubReturning(payload: object): (args: string[]) => Promise<string> {
  return async () => JSON.stringify(payload);
}

describe('extractAcceptanceCriteria (AISDLC-393)', () => {
  it('extracts checkbox-style ACs from the canonical issue-template section', () => {
    const body = [
      '## Background',
      'some context',
      '',
      '## Acceptance criteria',
      '- [ ] First criterion',
      '- [ ] Second criterion',
      '- [x] Third (already done)',
      '',
      '## Notes',
      'unrelated bullet',
      '- noise',
    ].join('\n');

    expect(extractAcceptanceCriteria(body)).toEqual([
      'First criterion',
      'Second criterion',
      'Third (already done)',
    ]);
  });

  it('accepts plain-bullet ACs (no checkbox)', () => {
    const body = ['## Acceptance criteria', '- First', '- Second'].join('\n');
    expect(extractAcceptanceCriteria(body)).toEqual(['First', 'Second']);
  });

  it('is case-insensitive on the section header', () => {
    const body = ['## Acceptance Criteria', '- [ ] one'].join('\n');
    expect(extractAcceptanceCriteria(body)).toEqual(['one']);
  });

  it('returns [] when no AC section is present', () => {
    expect(extractAcceptanceCriteria('## Background\nfoo')).toEqual([]);
  });

  it('returns [] for an empty AC section', () => {
    const body = ['## Acceptance criteria', '', '## Next'].join('\n');
    expect(extractAcceptanceCriteria(body)).toEqual([]);
  });
});

describe('extractPermittedExternalPaths (AISDLC-393)', () => {
  it('extracts from the label form', () => {
    const labels = [
      { name: 'permitted-external-paths:../ai-sdlc-io/' },
      { name: 'unrelated-label' },
    ];
    expect(extractPermittedExternalPaths('', labels)).toEqual(['../ai-sdlc-io/']);
  });

  it('extracts multiple labels (deduped)', () => {
    const labels = [
      { name: 'permitted-external-paths:../a/' },
      { name: 'permitted-external-paths:../b/' },
      { name: 'permitted-external-paths:../a/' },
    ];
    const result = extractPermittedExternalPaths('', labels);
    expect(result?.sort()).toEqual(['../a/', '../b/']);
  });

  it('extracts from a fenced body block', () => {
    const body = [
      'preamble',
      '```permitted-external-paths',
      '../ai-sdlc-io/',
      '- ../other/',
      '```',
      'postamble',
    ].join('\n');
    const result = extractPermittedExternalPaths(body, []);
    expect(result?.sort()).toEqual(['../ai-sdlc-io/', '../other/']);
  });

  it('merges label form and body form (deduped)', () => {
    const body = ['```permitted-external-paths', '../a/', '```'].join('\n');
    const labels = [{ name: 'permitted-external-paths:../b/' }];
    const result = extractPermittedExternalPaths(body, labels);
    expect(result?.sort()).toEqual(['../a/', '../b/']);
  });

  it('returns undefined when neither source contributes a path', () => {
    expect(
      extractPermittedExternalPaths('no relevant block', [{ name: 'random' }]),
    ).toBeUndefined();
  });
});

describe('fetchGhIssueAsTaskSpec (AISDLC-393 AC-2)', () => {
  it('synthesizes a TaskSpec from a well-formed open issue', async () => {
    const gh = ghStubReturning({
      number: 612,
      title: 'Add docs sync feature',
      body: [
        '## Background',
        'context',
        '',
        '## Acceptance criteria',
        '- [ ] Ship the sync',
        '- [ ] Add tests',
      ].join('\n'),
      state: 'OPEN',
      labels: [],
    });

    const result = await fetchGhIssueAsTaskSpec(612, { gh });
    expect(result.issueNumber).toBe(612);
    expect(result.issueState).toBe('OPEN');
    expect(result.spec.id).toBe('gh-issue-612');
    expect(result.spec.title).toBe('Add docs sync feature');
    expect(result.spec.status).toBe('To Do');
    expect(result.spec.acceptanceCriteria).toEqual(['Ship the sync', 'Add tests']);
    expect(result.spec.acceptanceCriteriaChecked).toEqual([false, false]);
    expect(result.spec.permittedExternalPaths).toBeUndefined();
    expect(result.spec.filePath).toBe('<gh-issue:612>');
    expect(result.spec.description).toContain('## Acceptance criteria');
    expect(result.spec.rawBody).toContain('## Acceptance criteria');
  });

  it('uses a placeholder AC when the body has no AC section', async () => {
    const gh = ghStubReturning({
      number: 700,
      title: 'something',
      body: 'free-form description with no AC section',
      state: 'OPEN',
      labels: [],
    });
    const result = await fetchGhIssueAsTaskSpec(700, { gh });
    expect(result.spec.acceptanceCriteria.length).toBe(1);
    expect(result.spec.acceptanceCriteria[0]).toContain('Address the issue');
  });

  it('extracts permittedExternalPaths from labels', async () => {
    const gh = ghStubReturning({
      number: 7,
      title: 't',
      body: '## Acceptance criteria\n- [ ] do it',
      state: 'OPEN',
      labels: [{ name: 'permitted-external-paths:../ai-sdlc-io/' }],
    });
    const result = await fetchGhIssueAsTaskSpec(7, { gh });
    expect(result.spec.permittedExternalPaths).toEqual(['../ai-sdlc-io/']);
  });

  it('refuses to dispatch a CLOSED issue', async () => {
    const gh = ghStubReturning({
      number: 100,
      title: 'closed issue',
      body: '',
      state: 'CLOSED',
      labels: [],
    });
    await expect(fetchGhIssueAsTaskSpec(100, { gh })).rejects.toThrow(/CLOSED.*not OPEN/);
  });

  it('refuses on empty title', async () => {
    const gh = ghStubReturning({
      number: 1,
      title: '',
      body: 'has body',
      state: 'OPEN',
      labels: [],
    });
    await expect(fetchGhIssueAsTaskSpec(1, { gh })).rejects.toThrow(/empty title/);
  });

  it('refuses on negative / zero / non-integer issue numbers', async () => {
    const gh = ghStubReturning({ number: 0, title: 't', body: '', state: 'OPEN', labels: [] });
    await expect(fetchGhIssueAsTaskSpec(0, { gh })).rejects.toThrow(/positive integer/);
    await expect(fetchGhIssueAsTaskSpec(-5, { gh })).rejects.toThrow(/positive integer/);
    await expect(fetchGhIssueAsTaskSpec(1.5, { gh })).rejects.toThrow(/positive integer/);
  });

  it('refuses when gh returns malformed JSON', async () => {
    const gh = async (): Promise<string> => 'this is not json';
    await expect(fetchGhIssueAsTaskSpec(42, { gh })).rejects.toThrow(/invalid JSON/);
  });

  it('refuses when gh returns a payload without title', async () => {
    const gh = async (): Promise<string> => JSON.stringify({ number: 42, state: 'OPEN' });
    await expect(fetchGhIssueAsTaskSpec(42, { gh })).rejects.toThrow(/malformed payload/);
  });

  it('supports a custom idPrefix', async () => {
    const gh = ghStubReturning({
      number: 5,
      title: 't',
      body: '## Acceptance criteria\n- [ ] do it',
      state: 'OPEN',
      labels: [],
    });
    const result = await fetchGhIssueAsTaskSpec(5, { gh, idPrefix: 'issue-' });
    expect(result.spec.id).toBe('issue-5');
  });

  it('passes the correct argv to gh', async () => {
    const calls: string[][] = [];
    const gh = async (args: string[]): Promise<string> => {
      calls.push(args);
      return JSON.stringify({
        number: 99,
        title: 't',
        body: '## Acceptance criteria\n- [ ] x',
        state: 'OPEN',
        labels: [],
      });
    };
    await fetchGhIssueAsTaskSpec(99, { gh });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['issue', 'view', '99', '--json', 'number,title,body,state,labels']);
  });
});
