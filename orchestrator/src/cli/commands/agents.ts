/**
 * ai-sdlc agents [name] — show agent roster, autonomy levels, performance.
 *
 * AISDLC-78 (AC #10): in addition to the autonomy ledger (which only
 * shows agents that have actually executed at least once), we now also
 * scan the project's .ai-sdlc directory for AgentRole resources and
 * surface declared-but-not-executed agents. Fresh installs that ran
 * `ai-sdlc init` previously saw an empty roster even though
 * `agent-role.yaml` declared `default-agent`; now the user sees the
 * declared roster + a "(declared, not yet executed)" hint.
 */

import { Command } from 'commander';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { Orchestrator } from '../../orchestrator.js';
import { formatOutput } from '../formatters/index.js';

interface DeclaredAgent {
  agentName: string;
  currentLevel: number;
  totalTasks: number;
  successCount: number;
  failureCount: number;
  lastTaskAt?: string;
  declaredOnly: true;
}

/**
 * Scan the config directory for AgentRole YAML resources and return the
 * declared agent metadata. Errors are swallowed (the autonomy ledger
 * is the primary source of truth — declared agents are a hint).
 */
export function loadDeclaredAgents(configDir: string): DeclaredAgent[] {
  const dir = resolve(configDir);
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  } catch {
    return [];
  }

  const declared: DeclaredAgent[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf-8');
      const docs = raw
        .split(/^---\s*$/m)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const docText of docs) {
        const doc = parseYaml(docText) as
          | { kind?: string; metadata?: { name?: string } }
          | null
          | undefined;
        if (!doc || doc.kind !== 'AgentRole') continue;
        const name = doc.metadata?.name;
        if (!name) continue;
        declared.push({
          agentName: name,
          currentLevel: 0,
          totalTasks: 0,
          successCount: 0,
          failureCount: 0,
          declaredOnly: true,
        });
      }
    } catch {
      // ignore malformed YAML — surfaced by `ai-sdlc validate`
    }
  }
  return declared;
}

export const agentsCommand = new Command('agents')
  .description('Show agent roster with autonomy levels and performance')
  .argument('[name]', 'Filter by agent name')
  .option('--state <path>', 'SQLite state database path')
  .action(async (name, opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    const format = globalOpts.format ?? 'table';
    const configDir = (globalOpts.config as string | undefined) ?? '.ai-sdlc';

    const orchestrator = new Orchestrator({
      configDir: globalOpts.config,
      statePath: opts.state,
    });

    try {
      const ledger = await orchestrator.agents();
      const executedNames = new Set(ledger.map((a) => a.agentName));
      const declared = loadDeclaredAgents(configDir).filter((d) => !executedNames.has(d.agentName));
      let agents: Array<Record<string, unknown>> = [
        ...ledger.map((a) => ({ ...a, declaredOnly: false }) as Record<string, unknown>),
        ...declared.map((d) => ({ ...d }) as Record<string, unknown>),
      ];
      if (name) {
        agents = agents.filter((a) => a.agentName === name);
      }
      console.log(formatOutput(format, { type: 'agents', agents }));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      orchestrator.close();
    }
  });
