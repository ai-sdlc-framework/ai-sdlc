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
import { validateWorkflowYaml } from '../workflow/validate.js';
import { buildExecuteGraph, renderMermaid, renderYaml } from '../workflow/graph.js';

export function renderGraph(format: string): string {
  const doc = buildExecuteGraph();
  return format === 'mermaid' ? renderMermaid(doc) : renderYaml(doc);
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
        const res = validateWorkflowYaml(readFileSync(path, 'utf8'));
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
