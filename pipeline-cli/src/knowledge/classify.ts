/**
 * Scope classification heuristic (RFC-0053 OQ-1): flags entries that are not
 * scoped `protected` but look like client / data-room material. A finding is a
 * likely mis-scoping, not proof; callers surface it as a warning.
 */
import type { KnowledgeEntry } from './entry.js';
import type { KnowledgeConfig } from './config.js';

export function classifyEntry(
  entry: Pick<KnowledgeEntry, 'scope' | 'source' | 'value' | 'body'>,
  config: Pick<KnowledgeConfig, 'dataRoomRoots' | 'clientIdentifiers'>,
): string[] {
  if (entry.scope === 'protected') return [];
  const findings: string[] = [];
  const source = entry.source.replace(/\\/g, '/');
  for (const root of config.dataRoomRoots) {
    const prefix = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (source === prefix || source.startsWith(`${prefix}/`)) {
      findings.push(`source '${entry.source}' is under data-room root '${root}'`);
    }
  }
  const haystack = `${entry.value}\n${entry.body}`.toLowerCase();
  for (const id of config.clientIdentifiers) {
    if (haystack.includes(id.toLowerCase())) {
      findings.push(`contains client identifier '${id}'`);
    }
  }
  return findings.map((f) => `likely mis-scoped (scope '${entry.scope}'): ${f}`);
}
