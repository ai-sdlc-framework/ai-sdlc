/**
 * Scans the two knowledge roots (tracked + protected) and validates entries
 * and the ontology. Also checks a PR body for citations of protected entries.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { loadKnowledgeConfig, type KnowledgeConfig } from './config.js';
import { classifyEntry } from './classify.js';
import { parseEntryFile, toEntry, validateEntryFields, type KnowledgeEntry } from './entry.js';
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

function listMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, d.name);
    if (d.isDirectory()) out.push(...listMarkdown(full));
    else if (d.isFile() && d.name.endsWith('.md')) out.push(full);
  }
  return out.sort();
}

/** Parse every entry file under a root, skipping unparseable ones (reported by validate). */
export function readEntries(dir: string): KnowledgeEntry[] {
  const entries: KnowledgeEntry[] = [];
  for (const file of listMarkdown(dir)) {
    const parsed = parseEntryFile(readFileSync(file, 'utf-8'));
    if ('fields' in parsed) entries.push(toEntry(parsed.fields, parsed.body));
  }
  return entries;
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

  const roots: [string, string][] = [
    [trackedAbs, 'tracked'],
    [protectedAbs, 'protected'],
  ];
  const seenIds = new Map<string, string>();
  for (const [dir, kind] of roots) {
    for (const file of listMarkdown(dir)) {
      const rel = relative(projectRoot, file);
      report.entries++;
      const parsed = parseEntryFile(readFileSync(file, 'utf-8'));
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
      const parts = relative(dir, file).split(/[\\/]/);
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
  const protectedAbs = abs(projectRoot, config.protectedRoot);
  for (const e of readEntries(protectedAbs)) {
    const re = new RegExp(
      `(^|[^A-Za-z0-9_-])${e.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_-])`,
    );
    if (re.test(body)) cited.push(e.id);
  }
  const rootPath = config.protectedRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  if (body.replace(/\\/g, '/').includes(`${rootPath}/`)) cited.push(`${rootPath}/`);
  return cited;
}
