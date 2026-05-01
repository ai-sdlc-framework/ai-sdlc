import { describe, expect, it } from 'vitest';
import { parseDeveloperReturn } from './06-parse-dev-return.js';

const happy = {
  summary: 'ok',
  filesChanged: ['a.ts'],
  commitSha: 'abc1234',
  verifications: { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' },
  acceptanceCriteriaMet: [1, 2],
};

describe('Step 6 — parseDeveloperReturn', () => {
  it('happy path with object input', async () => {
    const r = await parseDeveloperReturn({ developerReturn: happy });
    expect(r.ok).toBe(true);
    expect(r.developer?.commitSha).toBe('abc1234');
  });

  it('happy path with JSON string input', async () => {
    const r = await parseDeveloperReturn({ developerReturn: JSON.stringify(happy) });
    expect(r.ok).toBe(true);
  });

  it('rejects malformed JSON string', async () => {
    const r = await parseDeveloperReturn({ developerReturn: 'not json {' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/failed to parse/);
  });

  it('rejects non-object input', async () => {
    const r = await parseDeveloperReturn({ developerReturn: 42 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not an object/);
  });

  it('flags missing required keys', async () => {
    const { commitSha, ...without } = happy;
    void commitSha;
    const r = await parseDeveloperReturn({ developerReturn: without });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/commitSha/);
  });

  it('flags invalid filesChanged shape', async () => {
    const r = await parseDeveloperReturn({
      developerReturn: { ...happy, filesChanged: 'wrong' },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/filesChanged/);
  });

  it('flags invalid verification status', async () => {
    const r = await parseDeveloperReturn({
      developerReturn: { ...happy, verifications: { ...happy.verifications, build: 'bogus' } },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/verifications.build/);
  });

  it('treats null commitSha as developer-failed', async () => {
    const r = await parseDeveloperReturn({
      developerReturn: { ...happy, commitSha: null, notes: 'could not finish' },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/null commitSha/);
    expect(r.reason).toMatch(/could not finish/);
  });

  it('treats verifications.build=failed as developer-failed', async () => {
    const r = await parseDeveloperReturn({
      developerReturn: { ...happy, verifications: { ...happy.verifications, build: 'failed' } },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/build = failed/);
  });

  it('treats verifications.format=failed as developer-failed', async () => {
    const r = await parseDeveloperReturn({
      developerReturn: { ...happy, verifications: { ...happy.verifications, format: 'failed' } },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/format = failed/);
  });

  it('flags missing verifications object', async () => {
    const { verifications, ...rest } = happy;
    void verifications;
    const r = await parseDeveloperReturn({ developerReturn: rest });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/verifications/);
  });

  it('flags missing acceptanceCriteriaMet array', async () => {
    const { acceptanceCriteriaMet, ...rest } = happy;
    void acceptanceCriteriaMet;
    const r = await parseDeveloperReturn({ developerReturn: rest });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/acceptanceCriteriaMet/);
  });

  it('flags non-array acceptanceCriteriaMet', async () => {
    const r = await parseDeveloperReturn({
      developerReturn: { ...happy, acceptanceCriteriaMet: 'wrong' },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/acceptanceCriteriaMet/);
  });
});
