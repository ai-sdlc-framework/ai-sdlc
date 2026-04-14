/**
 * Storybook MCP ComponentCatalog adapter.
 *
 * Fetches component manifests from a Storybook MCP server endpoint,
 * caches with configurable refresh interval, and provides composition
 * analysis and catalog validation.
 */

import type {
  ComponentCatalog,
  ComponentManifest,
  ComponentQuery,
  ComponentMatch,
  StoryEntry,
  ComponentEntry,
} from '../interfaces.js';

/** Injectable HTTP client for testability. */
export interface StorybookHttpClient {
  get(url: string, headers: Record<string, string>): Promise<{ status: number; data: unknown }>;
}

export interface StorybookMcpConfig {
  /** MCP endpoint URL (e.g., https://storybook.acme.dev/mcp). */
  endpoint: string;
  /** Bearer token for authentication. */
  token?: string;
  /** Cache refresh interval in ms. */
  refreshIntervalMs?: number;
  /** Injectable HTTP client. */
  httpClient?: StorybookHttpClient;
}

function createDefaultHttpClient(): StorybookHttpClient {
  return {
    async get(url, headers) {
      const res = await fetch(url, { headers });
      return { status: res.status, data: await res.json() };
    },
  };
}

export function createStorybookMcpCatalog(config: StorybookMcpConfig): ComponentCatalog {
  const { endpoint, token, refreshIntervalMs = 3600000 } = config;
  const http = config.httpClient ?? createDefaultHttpClient();

  let cachedManifest: ComponentManifest | null = null;
  let cacheTimestamp = 0;

  function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
  }

  function isCacheValid(): boolean {
    return cachedManifest !== null && Date.now() - cacheTimestamp < refreshIntervalMs;
  }

  async function fetchManifest(): Promise<ComponentManifest> {
    if (isCacheValid()) return cachedManifest!;

    const res = await http.get(`${endpoint}/manifest`, authHeaders());
    if (res.status !== 200) {
      throw new Error(`Storybook MCP manifest fetch failed: HTTP ${res.status}`);
    }
    cachedManifest = res.data as ComponentManifest;
    cacheTimestamp = Date.now();
    return cachedManifest;
  }

  function scoreMatch(component: ComponentEntry, query: ComponentQuery): number {
    let score = 0;
    let factors = 0;

    if (query.name) {
      factors++;
      if (component.name.toLowerCase() === query.name.toLowerCase()) score += 1;
      else if (component.name.toLowerCase().includes(query.name.toLowerCase())) score += 0.5;
    }

    if (query.category) {
      factors++;
      if (component.category === query.category) score += 1;
    }

    if (query.capabilities && query.capabilities.length > 0) {
      factors++;
      const has = new Set(component.capabilities ?? []);
      const matched = query.capabilities.filter((c) => has.has(c)).length;
      score += matched / query.capabilities.length;
    }

    return factors > 0 ? score / factors : 0;
  }

  return {
    async getManifest() {
      return fetchManifest();
    },

    async resolveComponent(query) {
      const manifest = await fetchManifest();
      const matches: ComponentMatch[] = [];

      for (const component of manifest.components) {
        const score = scoreMatch(component, query);
        if (score > 0) {
          const matchedOn: string[] = [];
          if (query.name && component.name.toLowerCase().includes(query.name.toLowerCase()))
            matchedOn.push('name');
          if (query.category && component.category === query.category) matchedOn.push('category');
          if (query.capabilities) {
            const has = new Set(component.capabilities ?? []);
            if (query.capabilities.some((c) => has.has(c))) matchedOn.push('capabilities');
          }
          matches.push({ component, score, matchedOn });
        }
      }

      return matches.sort((a, b) => b.score - a.score);
    },

    async canCompose(requirement) {
      const manifest = await fetchManifest();
      const candidates: ComponentEntry[] = [];
      const coveredCaps = new Set<string>();

      for (const component of manifest.components) {
        const caps = new Set(component.capabilities ?? []);
        const overlap = requirement.capabilities.filter((c) => caps.has(c));
        if (overlap.length > 0) {
          candidates.push(component);
          overlap.forEach((c) => coveredCaps.add(c));
        }
      }

      const gaps = requirement.capabilities.filter((c) => !coveredCaps.has(c));
      return {
        feasible: gaps.length === 0,
        components: candidates,
        gaps,
        confidence:
          gaps.length === 0 ? 0.85 : Math.max(0, 1 - gaps.length / requirement.capabilities.length),
      };
    },

    async getStories(componentName) {
      const res = await http.get(
        `${endpoint}/stories?component=${encodeURIComponent(componentName)}`,
        authHeaders(),
      );
      if (res.status !== 200) return [];
      return (res.data as { stories: StoryEntry[] }).stories ?? [];
    },

    async validateAgainstCatalog(code, options) {
      const manifest = await fetchManifest();
      const knownNames = new Set(manifest.components.map((c) => c.name));
      const reused = new Set<string>();
      const newComponents: string[] = [];

      // Detect component references in code
      for (const name of knownNames) {
        if (code.includes(name)) reused.add(name);
      }

      // Detect potential new components (PascalCase identifiers)
      const pascalPattern = /\b([A-Z][a-zA-Z0-9]{2,})\b/g;
      const ignoredNames = new Set([
        'Promise',
        'Object',
        'Array',
        'String',
        'Number',
        'Boolean',
        'Error',
        'Map',
        'Set',
        'Date',
        'RegExp',
        'Function',
        'Symbol',
        'React',
        'Component',
        'Fragment',
        'Suspense',
        'HTMLElement',
      ]);

      let match: RegExpExecArray | null;
      while ((match = pascalPattern.exec(code)) !== null) {
        const name = match[1];
        if (!knownNames.has(name) && !reused.has(name) && !ignoredNames.has(name)) {
          newComponents.push(name);
        }
      }

      const isStrict = options?.strict ?? false;
      return {
        valid: isStrict ? newComponents.length === 0 : true,
        reusedComponents: [...reused],
        newComponents: [...new Set(newComponents)],
        violations: newComponents.map((n) => `New component "${n}" not in catalog`),
      };
    },
  };
}
