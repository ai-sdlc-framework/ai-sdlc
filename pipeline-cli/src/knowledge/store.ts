/**
 * Validates the entries of the two knowledge roots (tracked + protected), read through the
 * `KnowledgeStore`, and the ontology. Also checks a PR body for citations of protected entries.
 */
import { isAbsolute, join, relative } from 'node:path';
import { loadKnowledgeConfig, type KnowledgeConfig } from './config.js';
import { classifyEntry } from './classify.js';
import { toEntry, validateEntryFields } from './entry.js';
import { openKnowledgeStore, toEntries } from './knowledge-store.js';
import { loadOntology } from './ontology.js';

export interface Finding {
  file: string;
  message: string;
}

export interface ValidationReport {
  entries: number;
  errors: Finding[];
  warnings: Finding[];
}

function abs(projectRoot: string, p: string): string {
  return isAbsolute(p) ? p : join(projectRoot, p);
}

export function validateKnowledge(
  projectRoot: string,
  config: KnowledgeConfig = loadKnowledgeConfig(projectRoot),
): ValidationReport {
  const report: ValidationReport = { entries: 0, errors: [], warnings: [] };
  const trackedAbs = abs(projectRoot, config.trackedRoot);
  const protectedAbs = abs(projectRoot, config.protectedRoot);
  const { ontology, errors: ontologyErrors } = loadOntology(trackedAbs);
  for (const message of ontologyErrors) {
    report.errors.push({ file: join(config.trackedRoot, 'ontology.yaml'), message });
  }
  if (ontologyErrors.length > 0) return report;

  const dirs = { tracked: trackedAbs, protected: protectedAbs };
  const store = openKnowledgeStore(config, projectRoot);
  const seenIds = new Map<string, string>();
  for (const kind of ['tracked', 'protected'] as const) {
    for (const { path, parsed } of store.listRaw(kind)) {
      // The README init scaffolds at the root (AISDLC-1408) describes the store; it is not an entry.
      if (path === 'README.md') continue;
      const rel = relative(projectRoot, join(dirs[kind], path));
      report.entries++;
      if ('error' in parsed) {
        report.errors.push({ file: rel, message: parsed.error });
        continue;
      }
      for (const message of validateEntryFields(parsed.fields, ontology)) {
        report.errors.push({ file: rel, message });
      }
      const entry = toEntry(parsed.fields, parsed.body);
      const prior = seenIds.get(entry.id);
      if (prior)
        report.errors.push({ file: rel, message: `duplicate id '${entry.id}' (${prior})` });
      else seenIds.set(entry.id, rel);

      // Scope routing: protected entries only in the protected root, and vice versa.
      if (kind === 'tracked' && entry.scope === 'protected') {
        report.errors.push({ file: rel, message: 'protected entry found in the tracked root' });
      }
      if (kind === 'protected' && entry.scope !== 'protected') {
        report.errors.push({
          file: rel,
          message: `entry in the protected root must have scope 'protected' (got '${entry.scope}')`,
        });
      }
      // Layout: <root>/<trunk>/<topic>.md
      const parts = path.split(/[\\/]/);
      if (parts.length !== 2 || parts[0] !== entry.trunk) {
        report.errors.push({
          file: rel,
          message: `path must be <root>/${entry.trunk}/<topic>.md (trunk directory mismatch)`,
        });
      }
      for (const message of classifyEntry(entry, config)) {
        report.warnings.push({ file: rel, message });
      }
    }
  }
  return report;
}

/** Ids of protected entries in the protected root that a body must not cite. */
export function findProtectedCitations(
  projectRoot: string,
  body: string,
  config: KnowledgeConfig = loadKnowledgeConfig(projectRoot),
): string[] {
  const cited: string[] = [];
  const store = openKnowledgeStore({ protectedRoot: config.protectedRoot }, projectRoot);
  for (const e of toEntries(store.list('protected'))) {
    const re = new RegExp(
      `(^|[^A-Za-z0-9_-])${e.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_-])`,
    );
    if (re.test(body)) cited.push(e.id);
  }
  const rootPath = config.protectedRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  if (body.replace(/\\/g, '/').includes(`${rootPath}/`)) cited.push(`${rootPath}/`);
  return cited;
}
