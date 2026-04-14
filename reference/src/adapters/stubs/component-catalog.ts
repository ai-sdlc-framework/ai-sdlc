/**
 * Stub ComponentCatalog adapter for testing.
 * In-memory manifest with preloadable components and canned matches.
 */

import type {
  ComponentCatalog,
  ComponentManifest,
  ComponentQuery,
  ComponentMatch,
  ComponentRequirement,
  CompositionPlan,
  StoryEntry,
  CatalogValidationResult,
  ComponentEntry,
} from '../interfaces.js';

export interface StubComponentCatalogConfig {
  components?: ComponentEntry[];
  stories?: StoryEntry[];
}

export interface StubComponentCatalogAdapter extends ComponentCatalog {
  /** Get the number of manifest fetches. */
  getManifestFetchCount(): number;
  /** Add a component to the catalog at runtime. */
  addComponent(component: ComponentEntry): void;
}

export function createStubComponentCatalog(
  config: StubComponentCatalogConfig = {},
): StubComponentCatalogAdapter {
  const components: ComponentEntry[] = [...(config.components ?? [])];
  const stories: StoryEntry[] = [...(config.stories ?? [])];
  let manifestFetchCount = 0;

  return {
    async getManifest(): Promise<ComponentManifest> {
      manifestFetchCount++;
      return {
        version: '1.0.0',
        components: [...components],
        generatedAt: new Date().toISOString(),
      };
    },

    async resolveComponent(query: ComponentQuery): Promise<ComponentMatch[]> {
      return components
        .filter((c) => {
          if (query.name && !c.name.toLowerCase().includes(query.name.toLowerCase())) return false;
          if (query.category && c.category !== query.category) return false;
          if (query.capabilities) {
            const has = new Set(c.capabilities ?? []);
            if (!query.capabilities.every((cap) => has.has(cap))) return false;
          }
          return true;
        })
        .map((c) => ({
          component: c,
          score: 1.0,
          matchedOn: [
            query.name ? 'name' : '',
            query.category ? 'category' : '',
            query.capabilities ? 'capabilities' : '',
          ].filter(Boolean),
        }));
    },

    async canCompose(requirement: ComponentRequirement): Promise<CompositionPlan> {
      const matched = components.filter((c) => {
        const caps = new Set(c.capabilities ?? []);
        return requirement.capabilities.some((cap) => caps.has(cap));
      });
      const coveredCaps = new Set(matched.flatMap((c) => c.capabilities ?? []));
      const gaps = requirement.capabilities.filter((cap) => !coveredCaps.has(cap));

      return {
        feasible: gaps.length === 0,
        components: matched,
        gaps,
        confidence: gaps.length === 0 ? 0.9 : 0.3,
      };
    },

    async getStories(componentName: string): Promise<StoryEntry[]> {
      return stories.filter((s) => s.componentName === componentName);
    },

    async validateAgainstCatalog(
      code: string,
      _options?: { strict?: boolean },
    ): Promise<CatalogValidationResult> {
      const knownNames = new Set(components.map((c) => c.name));
      const referenced = new Set<string>();
      const newComponents: string[] = [];

      // Simple heuristic: look for component-like references in code
      for (const name of knownNames) {
        if (code.includes(name)) referenced.add(name);
      }

      // Detect potential new components (PascalCase identifiers not in catalog)
      const pascalCasePattern = /\b([A-Z][a-zA-Z0-9]+)\b/g;
      let match: RegExpExecArray | null;
      while ((match = pascalCasePattern.exec(code)) !== null) {
        const name = match[1];
        if (!knownNames.has(name) && !referenced.has(name) && name !== 'Promise') {
          newComponents.push(name);
        }
      }

      return {
        valid: newComponents.length === 0,
        reusedComponents: [...referenced],
        newComponents,
        violations: newComponents.map((n) => `New component "${n}" not found in catalog`),
      };
    },

    // Test helpers
    getManifestFetchCount() {
      return manifestFetchCount;
    },

    addComponent(component: ComponentEntry) {
      components.push(component);
    },
  };
}
