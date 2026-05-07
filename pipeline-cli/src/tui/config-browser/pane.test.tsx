/**
 * Config-browser pane component tests — RFC-0023 §9 / AISDLC-178.5
 * AC#4-6, AC#9 (search filter).
 *
 * Drives the pane with injected file walker + reader + editor launcher
 * so we can assert the validator-re-run lifecycle without touching real
 * fs / editors.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';

import { ConfigBrowserPane } from './pane.js';

afterEach(() => {
  cleanup();
});

const FILES = [
  { name: 'a.yaml', absPath: '/proj/.ai-sdlc/a.yaml', relPath: '.ai-sdlc/a.yaml' },
  { name: 'b.yaml', absPath: '/proj/.ai-sdlc/b.yaml', relPath: '.ai-sdlc/b.yaml' },
];

const CONTENTS: Record<string, string> = {
  '/proj/.ai-sdlc/a.yaml': 'apiVersion: ai-sdlc.io/v1alpha1\nkind: Pipeline\nspec: {}\n',
  '/proj/.ai-sdlc/b.yaml': 'kind: AgentRole\nbroken: : yaml',
};

function makeWalker() {
  return vi.fn().mockReturnValue({ files: FILES, error: null });
}
function makeReader() {
  return vi.fn().mockImplementation((opts: { absPath: string }) => ({
    text: CONTENTS[opts.absPath] ?? null,
    error: null,
  }));
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('ConfigBrowserPane — list view (AC#4)', () => {
  it('renders every YAML file with status icons', async () => {
    const { lastFrame } = render(
      <ConfigBrowserPane workDir="/proj" walker={makeWalker()} fileReader={makeReader()} />,
    );
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('a.yaml');
    expect(frame).toContain('b.yaml');
    expect(frame).toContain('CONFIGURATION (2 files)');
  });

  it('shows ✓ for valid files and ✗ for invalid', async () => {
    const { lastFrame } = render(
      <ConfigBrowserPane workDir="/proj" walker={makeWalker()} fileReader={makeReader()} />,
    );
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✓');
    expect(frame).toContain('✗');
  });

  it('renders the source-unavailable banner when walker errors', async () => {
    const walker = vi.fn().mockReturnValue({ files: [], error: 'source-unavailable' });
    const { lastFrame } = render(
      <ConfigBrowserPane workDir="/proj" walker={walker} fileReader={makeReader()} />,
    );
    await flush();
    expect(lastFrame() ?? '').toContain('unable to list .ai-sdlc/');
  });

  it('shows empty-state copy when no YAML files', async () => {
    const walker = vi.fn().mockReturnValue({ files: [], error: null });
    const { lastFrame } = render(
      <ConfigBrowserPane workDir="/proj" walker={walker} fileReader={makeReader()} />,
    );
    await flush();
    expect(lastFrame() ?? '').toContain('No .yaml files');
  });
});

describe('ConfigBrowserPane — detail view (AC#5)', () => {
  it('Enter on a file opens the syntax-highlighted detail view', async () => {
    const { stdin, lastFrame } = render(
      <ConfigBrowserPane workDir="/proj" walker={makeWalker()} fileReader={makeReader()} />,
    );
    await flush();
    stdin.write('\r'); // Enter on the first row (a.yaml)
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('CONFIG — .ai-sdlc/a.yaml');
    // Some line numbers must render.
    expect(frame).toMatch(/\b1│|\s1│/);
  });

  it('shows the validation summary in the detail view', async () => {
    const { stdin, lastFrame } = render(
      <ConfigBrowserPane workDir="/proj" walker={makeWalker()} fileReader={makeReader()} />,
    );
    await flush();
    stdin.write('\r');
    await flush();
    expect(lastFrame() ?? '').toContain('valid');
  });

  it('shows annotated line errors for malformed YAML', async () => {
    const { stdin, lastFrame } = render(
      <ConfigBrowserPane workDir="/proj" walker={makeWalker()} fileReader={makeReader()} />,
    );
    await flush();
    stdin.write('j'); // move down to b.yaml
    await flush();
    stdin.write('\r');
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('issue');
    // Annotation marker present.
    expect(frame).toMatch(/↳/);
  });

  it('Esc returns to list view from detail', async () => {
    const { stdin, lastFrame } = render(
      <ConfigBrowserPane workDir="/proj" walker={makeWalker()} fileReader={makeReader()} />,
    );
    await flush();
    stdin.write('\r');
    await flush();
    expect(lastFrame() ?? '').toContain('CONFIG —');
    stdin.write('\x1B'); // Esc
    await flush();
    expect(lastFrame() ?? '').toContain('CONFIGURATION');
  });
});

describe('ConfigBrowserPane — editor handoff (AC#6)', () => {
  it('e-keystroke launches the injected editor and re-validates on return', async () => {
    let currentText = CONTENTS['/proj/.ai-sdlc/a.yaml'];
    const walker = makeWalker();
    const fileReader = vi.fn().mockImplementation(() => ({ text: currentText, error: null }));
    const editorLauncher = vi.fn().mockImplementation(() => {
      // Operator "edits" the file — simulate by mutating the read source.
      currentText = 'kind: Pipeline\nspec:\n  edited: true\n';
      return { outcome: 'EDITOR_OK', editor: 'vim' };
    });
    const { stdin, lastFrame } = render(
      <ConfigBrowserPane
        workDir="/proj"
        walker={walker}
        fileReader={fileReader}
        editorLauncher={editorLauncher}
      />,
    );
    await flush();
    stdin.write('\r'); // open a.yaml
    await flush();
    stdin.write('e');
    await flush();
    expect(editorLauncher).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/proj/.ai-sdlc/a.yaml' }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('saved & re-validated');
  });

  it('surfaces $EDITOR-not-set message when launcher returns EDITOR_NOT_SET', async () => {
    const editorLauncher = vi.fn().mockReturnValue({ outcome: 'EDITOR_NOT_SET', editor: null });
    const { stdin, lastFrame } = render(
      <ConfigBrowserPane
        workDir="/proj"
        walker={makeWalker()}
        fileReader={makeReader()}
        editorLauncher={editorLauncher}
      />,
    );
    await flush();
    stdin.write('\r');
    await flush();
    stdin.write('e');
    await flush();
    expect(lastFrame() ?? '').toContain('$EDITOR not set');
  });

  it('surfaces editor-failure message when launcher returns EDITOR_FAILED', async () => {
    const editorLauncher = vi.fn().mockReturnValue({
      outcome: 'EDITOR_FAILED',
      editor: 'vim',
      error: 'ENOENT',
    });
    const { stdin, lastFrame } = render(
      <ConfigBrowserPane
        workDir="/proj"
        walker={makeWalker()}
        fileReader={makeReader()}
        editorLauncher={editorLauncher}
      />,
    );
    await flush();
    stdin.write('\r');
    await flush();
    stdin.write('e');
    await flush();
    expect(lastFrame() ?? '').toContain('$EDITOR failed');
  });

  it('flags errors after edit when re-validation finds new issues', async () => {
    let currentText = CONTENTS['/proj/.ai-sdlc/a.yaml'];
    const fileReader = vi.fn().mockImplementation(() => ({ text: currentText, error: null }));
    const editorLauncher = vi.fn().mockImplementation(() => {
      currentText = 'broken: : yaml';
      return { outcome: 'EDITOR_OK', editor: 'vim' };
    });
    const { stdin, lastFrame } = render(
      <ConfigBrowserPane
        workDir="/proj"
        walker={makeWalker()}
        fileReader={fileReader}
        editorLauncher={editorLauncher}
      />,
    );
    await flush();
    stdin.write('\r');
    await flush();
    stdin.write('e');
    await flush();
    expect(lastFrame() ?? '').toMatch(/issue.*after edit/);
  });
});

describe('ConfigBrowserPane — search filter (AC#9)', () => {
  it('filterQuery prunes the list to matching files only', async () => {
    const { lastFrame } = render(
      <ConfigBrowserPane
        workDir="/proj"
        walker={makeWalker()}
        fileReader={makeReader()}
        filterQuery="b"
      />,
    );
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('b.yaml');
    expect(frame).not.toContain('a.yaml');
  });

  it('shows "no matches" when filter excludes everything', async () => {
    const { lastFrame } = render(
      <ConfigBrowserPane
        workDir="/proj"
        walker={makeWalker()}
        fileReader={makeReader()}
        filterQuery="zzz"
      />,
    );
    await flush();
    expect(lastFrame() ?? '').toContain('No matches for "zzz"');
  });
});
