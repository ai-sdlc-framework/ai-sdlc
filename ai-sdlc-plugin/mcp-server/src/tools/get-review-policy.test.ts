import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGetReviewPolicy } from './get-review-policy.js';
import * as fs from 'node:fs';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  return { ...actual, existsSync: vi.fn(), readFileSync: vi.fn() };
});

describe('get_review_policy', () => {
  let registeredHandler: (
    args: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text: string }[] }>;

  beforeEach(() => {
    const server = {
      tool: vi.fn((_name, _desc, _schema, handler) => {
        registeredHandler = handler;
      }),
    } as unknown as McpServer;

    registerGetReviewPolicy(server, { projectDir: '/test/project' });
  });

  it('returns policy content when file exists', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      '# Review Policy\n\nGolden Rule: approve with suggestion',
    );

    const result = await registeredHandler({});
    expect(result.content[0].text).toContain('Golden Rule');
  });

  it('returns default message when no policy file', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = await registeredHandler({});
    expect(result.content[0].text).toContain('default calibration');
  });
});
