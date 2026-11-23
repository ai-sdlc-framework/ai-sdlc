import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * AISDLC-1359: the directory of the pipeline-cli bin files, derived from the running module
 * (as `cli/dispatch.ts` does), so it holds in a repository that has only the installed package.
 */
export function pipelineCliBinDir(moduleUrl: string = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '../bin');
}

/** Absolute path of one pipeline-cli bin, e.g. `pipelineCliBin('cli-usage.mjs')`. */
export function pipelineCliBin(name: string, dir: string = pipelineCliBinDir()): string {
  return path.join(dir, name);
}
