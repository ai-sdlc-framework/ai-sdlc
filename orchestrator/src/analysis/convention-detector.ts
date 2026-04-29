/**
 * Detect coding conventions: naming style, test organization, import style.
 *
 * The detector accepts an optional `repoPath` so it can read project-level
 * configuration (`package.json`, `vite.config.{js,ts}`, `tsconfig.json`,
 * `jsconfig.json`, `webpack.config.*`) to interpret the file list more
 * accurately. When `repoPath` is omitted the detector falls back to a pure
 * file-name analysis (the original v1 behaviour).
 *
 * Three classes of false-positives motivated the project-config plumbing
 * (AISDLC-80):
 *
 *  1. React projects mix PascalCase (components) with camelCase (hooks/stores
 *     and plain modules) — the v1 detector flagged this as `mixed`. With
 *     `package.json` `dependencies.react` visible we treat the dual-pattern
 *     case as the expected React convention.
 *  2. Many repos host tests in multiple directories (`tests/`, `tests/e2e/`,
 *     `src/tests/`, `cypress/`, ...) plus collocated `*.test.*`. The v1
 *     detector picked one bucket and called it `mixed` when the proportions
 *     were close. We now enumerate the FULL set of locations.
 *  3. Vite / TS / webpack path aliases (`@components`, `@engine`, ...) were
 *     classified as external imports because the v1 detector never read the
 *     alias maps. We now parse the alias map from each known config file and
 *     report alias usage as its own bucket.
 */

import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { FileInfo, DetectedConvention } from './types.js';

// ── Naming style helpers ──────────────────────────────────────────

function isCamelCase(name: string): boolean {
  return /^[a-z][a-zA-Z0-9]*$/.test(name);
}

function isPascalCase(name: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(name);
}

function isKebabCase(name: string): boolean {
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name);
}

function isSnakeCase(name: string): boolean {
  return /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(name);
}

type NamingStyle =
  | 'camelCase'
  | 'PascalCase'
  | 'kebab-case'
  | 'snake_case'
  | 'PascalCase + camelCase (React)'
  | 'mixed';

const REACT_COMPONENT_EXTENSIONS = new Set(['.jsx', '.tsx']);
const REACT_MODULE_EXTENSIONS = new Set(['.js', '.ts']);

/**
 * Recognised React project structure: PascalCase for `.jsx`/`.tsx` (components)
 * AND camelCase for `.js`/`.ts` (hooks, stores, utilities). At least 60% of
 * each extension family must follow the expected style for the heuristic to
 * fire so an accidentally-mixed repo still gets flagged.
 */
function detectReactDualNamingPattern(files: FileInfo[]): {
  matched: boolean;
  componentExamples: string[];
  moduleExamples: string[];
} {
  let componentTotal = 0;
  let componentPascal = 0;
  let moduleTotal = 0;
  let moduleCamel = 0;
  const componentExamples: string[] = [];
  const moduleExamples: string[] = [];

  for (const file of files) {
    const name = stripTestSuffix(basename(file.relativePath, extname(file.relativePath)));
    if (!name || name === 'index') continue;

    if (REACT_COMPONENT_EXTENSIONS.has(file.extension)) {
      componentTotal++;
      if (isPascalCase(name)) {
        componentPascal++;
        if (componentExamples.length < 3) componentExamples.push(file.relativePath);
      }
    } else if (REACT_MODULE_EXTENSIONS.has(file.extension)) {
      moduleTotal++;
      // Hooks (`useFoo.js`) and store/util modules (`gameplayStore.js`) are
      // both camelCase under React community convention.
      if (isCamelCase(name)) {
        moduleCamel++;
        if (moduleExamples.length < 3) moduleExamples.push(file.relativePath);
      }
    }
  }

  // Need meaningful evidence of BOTH families and at least 60% adherence in each.
  if (componentTotal < 2 || moduleTotal < 2) {
    return { matched: false, componentExamples, moduleExamples };
  }
  const componentRatio = componentPascal / componentTotal;
  const moduleRatio = moduleCamel / moduleTotal;
  return {
    matched: componentRatio >= 0.6 && moduleRatio >= 0.6,
    componentExamples,
    moduleExamples,
  };
}

function stripTestSuffix(name: string): string {
  return name.replace(/\.(test|spec|stories|d)$/, '');
}

function detectFileNamingStyle(
  files: FileInfo[],
  reactMode: boolean,
): {
  style: NamingStyle;
  confidence: number;
  examples: string[];
} {
  // React projects get a dual-pattern check first — if it matches we report
  // the friendly "PascalCase + camelCase (React)" label and skip the legacy
  // single-style heuristic that would otherwise (correctly but unhelpfully)
  // call this `mixed`.
  if (reactMode) {
    const dual = detectReactDualNamingPattern(files);
    if (dual.matched) {
      return {
        style: 'PascalCase + camelCase (React)',
        confidence: 0.9,
        examples: [...dual.componentExamples, ...dual.moduleExamples].slice(0, 3),
      };
    }
  }

  const counts: Record<NamingStyle, number> = {
    camelCase: 0,
    PascalCase: 0,
    'kebab-case': 0,
    snake_case: 0,
    'PascalCase + camelCase (React)': 0,
    mixed: 0,
  };
  const examples: Record<NamingStyle, string[]> = {
    camelCase: [],
    PascalCase: [],
    'kebab-case': [],
    snake_case: [],
    'PascalCase + camelCase (React)': [],
    mixed: [],
  };

  for (const file of files) {
    const name = stripTestSuffix(basename(file.relativePath, extname(file.relativePath)));

    if (!name || name === 'index') continue;

    if (isKebabCase(name)) {
      counts['kebab-case']++;
      if (examples['kebab-case'].length < 3) examples['kebab-case'].push(file.relativePath);
    } else if (isSnakeCase(name)) {
      counts.snake_case++;
      if (examples.snake_case.length < 3) examples.snake_case.push(file.relativePath);
    } else if (isCamelCase(name)) {
      counts.camelCase++;
      if (examples.camelCase.length < 3) examples.camelCase.push(file.relativePath);
    } else if (isPascalCase(name)) {
      counts.PascalCase++;
      if (examples.PascalCase.length < 3) examples.PascalCase.push(file.relativePath);
    }
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return { style: 'mixed', confidence: 0, examples: [] };

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]) as [NamingStyle, number][];
  const [topStyle, topCount] = sorted[0];
  const confidence = topCount / total;

  return {
    style: confidence >= 0.5 ? topStyle : 'mixed',
    confidence: Math.round(confidence * 100) / 100,
    examples: examples[topStyle],
  };
}

// ── Testing convention detection ────────────────────────────────

/**
 * Each entry describes ONE place tests live in the repo. We enumerate ALL of
 * them rather than flatten to a single label — a repo with `tests/`,
 * `tests/e2e/`, `src/tests/` and a few collocated `*.test.*` files is reported
 * with all four buckets visible (AISDLC-80).
 */
export interface TestLocationSummary {
  /** Stable label for the bucket (e.g. `__tests__/`, `tests/e2e/`, `co-located`). */
  label: string;
  /** Number of test files matched against this bucket. */
  count: number;
  /** Up to three example file paths from this bucket. */
  examples: string[];
}

const KNOWN_TEST_DIRECTORY_PREFIXES: { label: string; matches: (dir: string) => boolean }[] = [
  // Order matters: more specific matchers first so `tests/e2e/foo.test.ts`
  // ends up in `tests/e2e/` rather than `tests/`.
  { label: 'tests/e2e/', matches: (d) => /(^|\/)tests\/e2e(\/|$)/.test(d) },
  { label: 'tests/integration/', matches: (d) => /(^|\/)tests\/integration(\/|$)/.test(d) },
  { label: 'tests/unit/', matches: (d) => /(^|\/)tests\/unit(\/|$)/.test(d) },
  { label: 'src/tests/', matches: (d) => /(^|\/)src\/tests(\/|$)/.test(d) },
  { label: '__tests__/', matches: (d) => /(^|\/)__tests__(\/|$)/.test(d) },
  { label: 'cypress/', matches: (d) => /(^|\/)cypress(\/|$)/.test(d) },
  { label: 'e2e/', matches: (d) => /(^|\/)e2e(\/|$)/.test(d) && !/tests\/e2e/.test(d) },
  { label: 'tests/', matches: (d) => /(^|\/)tests(\/|$)/.test(d) },
  { label: 'test/', matches: (d) => /(^|\/)test(\/|$)/.test(d) && !/__tests__/.test(d) },
];

/**
 * Classify every test file found into ALL the locations it actually lives,
 * preserving the multi-directory reality of real projects. Returns the
 * complete set sorted by file count (descending) with examples for each.
 */
export function enumerateTestLocations(files: FileInfo[]): TestLocationSummary[] {
  const buckets = new Map<string, { count: number; examples: string[] }>();

  function bump(label: string, path: string): void {
    const existing = buckets.get(label) ?? { count: 0, examples: [] };
    existing.count += 1;
    if (existing.examples.length < 3) existing.examples.push(path);
    buckets.set(label, existing);
  }

  const testFiles = files.filter((f) => {
    const name = basename(f.relativePath);
    return (
      name.includes('.test.') ||
      name.includes('.spec.') ||
      f.relativePath.includes('__tests__') ||
      // Cypress puts integration specs under `cypress/e2e/foo.cy.js` — pick
      // those up too even if they don't carry a `.test.` / `.spec.` suffix.
      /(^|\/)cypress\/.*\.(js|ts|jsx|tsx)$/.test(f.relativePath) ||
      /(^|\/)tests?\/.*\.(js|ts|jsx|tsx|mjs|cjs)$/.test(f.relativePath)
    );
  });

  for (const file of testFiles) {
    const dir = dirname(file.relativePath);
    let matched = false;
    for (const matcher of KNOWN_TEST_DIRECTORY_PREFIXES) {
      if (matcher.matches(dir)) {
        bump(matcher.label, file.relativePath);
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Anything else — collocated with source.
      bump('co-located', file.relativePath);
    }
  }

  return [...buckets.entries()]
    .map(([label, info]) => ({ label, count: info.count, examples: info.examples }))
    .sort((a, b) => b.count - a.count);
}

function summariseTestLocations(locations: TestLocationSummary[]): {
  pattern: string;
  examples: string[];
  confidence: number;
} {
  if (locations.length === 0) {
    return { pattern: 'No test files detected', examples: [], confidence: 0 };
  }
  const total = locations.reduce((sum, loc) => sum + loc.count, 0);
  const labelList = locations.map((loc) => loc.label).join(', ');
  // Confidence is the share of test files that fall into the largest bucket
  // — but we still REPORT the full set in `pattern` so users see every place
  // tests actually live.
  const confidence = Math.round((locations[0].count / total) * 100) / 100;
  return {
    pattern: `Test files in: ${labelList}`,
    examples: locations.flatMap((loc) => loc.examples).slice(0, 3),
    confidence,
  };
}

// ── Path-alias detection ────────────────────────────────────────

/** Map of alias prefix (e.g. `@components`) → resolved target glob. */
export type PathAliasMap = Record<string, string>;

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

function stripJsonComments(text: string): string {
  // Tolerant pre-pass for `tsconfig.json` / `jsconfig.json` which permit
  // line + block comments and trailing commas. The implementation is
  // intentionally narrow: strings are scanned char-by-char so we don't
  // accidentally strip "//" inside a string literal.
  let out = '';
  let i = 0;
  let inString: '"' | "'" | null = null;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  // Trailing comma cleanup.
  return out.replace(/,(\s*[\]}])/g, '$1');
}

/**
 * Parse `compilerOptions.paths` from a `tsconfig.json` / `jsconfig.json`.
 * The TS config format maps `"@components/*": ["src/components/*"]` — we
 * normalise to `@components` → `src/components/*`.
 */
export function parseTsConfigAliases(content: string): PathAliasMap {
  const aliases: PathAliasMap = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(content));
  } catch {
    return aliases;
  }
  const obj = parsed as { compilerOptions?: { paths?: Record<string, unknown> } } | undefined;
  const paths = obj?.compilerOptions?.paths;
  if (!paths || typeof paths !== 'object') return aliases;
  for (const [pattern, target] of Object.entries(paths)) {
    if (!Array.isArray(target) || target.length === 0) continue;
    const firstTarget = target[0];
    if (typeof firstTarget !== 'string') continue;
    // Drop wildcard suffix for the alias key — `"@/*"` → `@`,
    // `"@components/*"` → `@components`.
    const aliasKey = pattern.replace(/\/\*$/, '');
    aliases[aliasKey] = firstTarget;
  }
  return aliases;
}

/**
 * Extract `resolve.alias` (object literal form) from a Vite or webpack config
 * file. We use a regex rather than a full JS parser because the contents are
 * config files written in a small, well-known shape — the v1 detector's
 * "regex over AST" tradeoff carries forward.
 *
 * Recognises both:
 *   resolve: { alias: { '@components': path.resolve(__dirname, 'src/components') } }
 *   alias: { '@engine': '/abs/path' }
 */
export function parseViteOrWebpackAliases(content: string): PathAliasMap {
  const aliases: PathAliasMap = {};
  // Find an `alias:` or `alias =` followed by an object literal. Only the
  // first occurrence is parsed — vite configs typically declare exactly one.
  const aliasMatch = /alias\s*[:=]\s*\{([\s\S]*?)\}/m.exec(content);
  if (!aliasMatch) return aliases;
  const body = aliasMatch[1];
  // Each entry is `'key': <expr>` or `"key": <expr>`. We grab the key and
  // ignore the expression because we only need the alias prefix to match
  // user code.
  const entryRe = /['"]([^'"]+)['"]\s*:\s*([^,\n}]+)/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(body)) !== null) {
    const key = m[1];
    const valueExpr = m[2].trim();
    aliases[key] = valueExpr;
  }
  return aliases;
}

/**
 * Read every alias source we know about and merge into a single map. Sources
 * are read in parallel; later sources take precedence if there is overlap.
 */
export async function loadProjectAliases(repoPath: string): Promise<PathAliasMap> {
  const candidates = [
    'tsconfig.json',
    'jsconfig.json',
    'vite.config.js',
    'vite.config.ts',
    'vite.config.mjs',
    'vite.config.cjs',
    'webpack.config.js',
    'webpack.config.ts',
    'webpack.config.mjs',
    'webpack.config.cjs',
  ];
  const reads = await Promise.all(
    candidates.map(async (name) => ({ name, content: await readFileSafe(join(repoPath, name)) })),
  );
  const merged: PathAliasMap = {};
  for (const { name, content } of reads) {
    if (!content) continue;
    const isTsConfig = name === 'tsconfig.json' || name === 'jsconfig.json';
    const parsed = isTsConfig ? parseTsConfigAliases(content) : parseViteOrWebpackAliases(content);
    Object.assign(merged, parsed);
  }
  return merged;
}

// ── Import style detection ──────────────────────────────────────

type ImportStyle =
  | 'relative'
  | 'path-alias'
  | 'barrel-re-exports'
  | 'mixed-relative-and-aliases'
  | 'mixed';

interface ImportStyleResult {
  style: ImportStyle;
  confidence: number;
  usesBarrels: boolean;
  examples: string[];
  /** Aliases discovered from project config files. Empty if none parsed. */
  aliases: PathAliasMap;
}

function detectImportStyle(files: FileInfo[], aliases: PathAliasMap): ImportStyleResult {
  // Barrel detection is unchanged from v1 — it's a structural signal taken
  // straight off the file list.
  const indexFiles = files.filter((f) => basename(f.relativePath).startsWith('index.'));
  const usesBarrels = indexFiles.length > 3;
  const aliasKeys = Object.keys(aliases);
  const hasAliases = aliasKeys.length > 0;

  let style: ImportStyle = 'relative';
  if (hasAliases && usesBarrels) {
    style = 'mixed-relative-and-aliases';
  } else if (hasAliases) {
    style = 'path-alias';
  }

  const aliasExamples = aliasKeys.slice(0, 3);
  const barrelExamples = indexFiles.slice(0, 3).map((f) => f.relativePath);
  const examples = hasAliases ? aliasExamples : barrelExamples;

  return {
    style,
    confidence: 0.8,
    usesBarrels,
    examples,
    aliases,
  };
}

// ── React project detection ─────────────────────────────────────

/**
 * Read `package.json` and decide whether this is a React project. Looks at
 * `dependencies` AND `devDependencies` because Vite-driven SPAs sometimes
 * declare React as a dev dep via templates.
 */
export async function detectReactProject(repoPath: string): Promise<boolean> {
  const content = await readFileSafe(join(repoPath, 'package.json'));
  if (!content) return false;
  let pkg: unknown;
  try {
    pkg = JSON.parse(content);
  } catch {
    return false;
  }
  const obj = pkg as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return Boolean(obj.dependencies?.react ?? obj.devDependencies?.react);
}

// ── Public API ──────────────────────────────────────────────────

export interface DetectConventionsOptions {
  /**
   * Absolute path to the repo root. When provided the detector reads project
   * configs (`package.json`, vite/tsconfig/jsconfig/webpack) for context-aware
   * decisions. Without it the detector falls back to pure file-name analysis.
   */
  repoPath?: string;
}

/**
 * Detect coding conventions from the file list. When `options.repoPath` is
 * supplied the detector additionally reads project-level configuration to
 * suppress the three classes of false-positives described at the top of this
 * file (AISDLC-80).
 */
export async function detectConventions(
  files: FileInfo[],
  options: DetectConventionsOptions = {},
): Promise<DetectedConvention[]> {
  const conventions: DetectedConvention[] = [];

  const repoPath = options.repoPath;
  const reactMode = repoPath ? await detectReactProject(repoPath) : false;
  const aliases = repoPath ? await loadProjectAliases(repoPath) : {};

  // ── File naming ──
  const naming = detectFileNamingStyle(files, reactMode);
  if (naming.confidence > 0) {
    const labelSuffix = naming.style.startsWith('PascalCase + camelCase')
      ? ' for React components/hooks'
      : ' for file names';
    conventions.push({
      category: 'naming',
      pattern: `${naming.style}${labelSuffix}`,
      confidence: naming.confidence,
      examples: naming.examples,
    });
  }

  // ── Testing ──
  const locations = enumerateTestLocations(files);
  const testingSummary = summariseTestLocations(locations);
  if (testingSummary.confidence > 0) {
    conventions.push({
      category: 'testing',
      pattern: testingSummary.pattern,
      confidence: testingSummary.confidence,
      examples: testingSummary.examples,
    });
  }

  // ── Imports ──
  const imports = detectImportStyle(files, aliases);
  const aliasKeys = Object.keys(imports.aliases);
  let importDesc: string;
  if (imports.style === 'mixed-relative-and-aliases') {
    importDesc = `Path aliases (${aliasKeys.join(', ')}) + relative imports + barrel re-exports via index.ts`;
  } else if (imports.style === 'path-alias') {
    importDesc = `Path aliases (${aliasKeys.join(', ')}) + relative imports`;
  } else if (imports.usesBarrels) {
    importDesc = 'Relative imports, barrel re-exports via index.ts';
  } else {
    importDesc = 'Relative imports';
  }
  conventions.push({
    category: 'imports',
    pattern: importDesc,
    confidence: imports.confidence,
    examples: imports.examples,
  });

  return conventions;
}
