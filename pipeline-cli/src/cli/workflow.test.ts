/**
 * Tests for `cli-workflow graph` (RFC-0056 phase 1), driven through the
 * command entry `runWorkflowCli` in-process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderGraph, runWorkflowCli } from './workflow.js';

let out: string[];

beforeEach(() => {
  out = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runWorkflowCli graph', () => {
  it('emits Mermaid with --format mermaid', async () => {
    await runWorkflowCli(['graph', '--format', 'mermaid']);
    const text = out.join('');
    expect(text.length).toBeGreaterThan(0);
    expect(text).toBe(renderGraph('mermaid'));
    expect(text).toMatch(/stateDiagram|flowchart|graph /);
  });

  it('emits YAML by default', async () => {
    await runWorkflowCli(['graph']);
    const text = out.join('');
    expect(text).toBe(renderGraph('yaml'));
    expect(text).not.toMatch(/^(stateDiagram|flowchart|graph )/);
  });

  it('emits YAML with --format yaml', async () => {
    await runWorkflowCli(['graph', '--format', 'yaml']);
    expect(out.join('')).toBe(renderGraph('yaml'));
  });

  it('rejects an unknown format without printing a graph', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    await expect(runWorkflowCli(['graph', '--format', 'bogus'])).rejects.toThrow();
    expect(exit).toHaveBeenCalled();
    expect(out.join('')).toBe('');
    err.mockRestore();
  });

  it('rejects a missing command', async () => {
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    await expect(runWorkflowCli([])).rejects.toThrow();
    expect(out.join('')).toBe('');
  });
});
