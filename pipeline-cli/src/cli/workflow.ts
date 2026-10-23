/**
 * `cli-workflow` router (RFC-0056 phase 1). `graph` prints the current execute
 * Machine as Mermaid or as the Workflow YAML document. Read-only.
 *
 * @module cli/workflow
 */
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { load } from 'js-yaml';
import { applyOverlay, decisionLookup, isOverlay } from '../workflow/overlay.js';
import { validateWorkflowDocument, validateWorkflowYaml } from '../workflow/validate.js';
import { buildExecuteGraph, renderMermaid, renderYaml } from '../workflow/graph.js';

export function renderGraph(format: string): string {
  const doc = buildExecuteGraph();
  return format === 'mermaid' ? renderMermaid(doc) : renderYaml(doc);
}

/** Validate a document; an `extends` overlay is resolved with decisions read from `origin/main`. */
function validateFile(text: string, projectDir: string): { ok: boolean; errors: string[] } {
  let doc: unknown;
  try {
    doc = load(text);
  } catch {
    return validateWorkflowYaml(text);
  }
  if (!isOverlay(doc)) return validateWorkflowYaml(text);
  const git = (args: string[]): string => {
    try {
      return execFileSync('git', args, {
        cwd: projectDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return '';
    }
  };
  const names = git(['ls-tree', '--name-only', 'origin/main', '.ai-sdlc/_decisions/events/']).split(
    '\n',
  );
  const legacy = git(['show', 'origin/main:.ai-sdlc/_decisions/events.jsonl']);
  const res = applyOverlay(doc, { decisionExists: decisionLookup(names, legacy) });
  return res.ok ? validateWorkflowDocument(res.doc) : { ok: false, errors: res.errors };
}

export async function runWorkflowCli(argv: string[] = hideBin(process.argv)): Promise<void> {
  await yargs(argv)
    .scriptName('cli-workflow')
    .command(
      'graph',
      'Print the current execute graph',
      (y) =>
        y.option('format', {
          choices: ['mermaid', 'yaml'] as const,
          default: 'yaml',
          describe: 'Output format.',
        }),
      (args) => {
        process.stdout.write(renderGraph(String(args.format)));
      },
    )
    .command(
      'validate',
      'Validate .ai-sdlc/workflow.yaml (schema, loops, anchors, when identifiers)',
      (y) => y.option('project-dir', { type: 'string', default: process.cwd() }),
      (args) => {
        const path = join(String(args['project-dir']), '.ai-sdlc', 'workflow.yaml');
        if (!existsSync(path)) {
          process.stdout.write(JSON.stringify({ state: 'missing', errors: [] }) + '\n');
          return;
        }
        const res = validateFile(readFileSync(path, 'utf8'), String(args['project-dir']));
        process.stdout.write(
          JSON.stringify({ state: res.ok ? 'valid' : 'invalid', errors: res.errors }) + '\n',
        );
        if (!res.ok) process.exitCode = 1;
      },
    )
    .demandCommand(1)
    .strict()
    .parseAsync();
}
