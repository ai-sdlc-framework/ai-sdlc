/**
 * `cli-workflow` router (RFC-0056 phase 1). `graph` prints the current execute
 * Machine as Mermaid or as the Workflow YAML document. Read-only.
 *
 * @module cli/workflow
 */
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
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
    .demandCommand(1)
    .strict()
    .parseAsync();
}
