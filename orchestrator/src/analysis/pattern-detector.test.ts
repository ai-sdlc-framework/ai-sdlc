import { describe, it, expect } from 'vitest';
import { detectPatterns } from './pattern-detector.js';
import type { FileInfo, ModuleInfo } from './types.js';

function makeFile(relativePath: string): FileInfo {
  return {
    path: `/repo/${relativePath}`,
    relativePath,
    lineCount: 50,
    extension: '.' + relativePath.split('.').pop()!,
  };
}

function makeModule(name: string, path: string): ModuleInfo {
  return { name, path, fileCount: 3, dependencies: [], dependents: [] };
}

describe('pattern-detector', () => {
  it('detects hexagonal architecture', () => {
    const files = [
      makeFile('src/domain/user.ts'),
      makeFile('src/domain/order.ts'),
      makeFile('src/adapters/http-adapter.ts'),
      makeFile('src/adapters/db-adapter.ts'),
      makeFile('src/ports/user-port.ts'),
    ];
    const modules = [
      makeModule('domain', 'src/domain'),
      makeModule('adapters', 'src/adapters'),
      makeModule('ports', 'src/ports'),
    ];

    const patterns = detectPatterns(files, modules);
    const hexagonal = patterns.find((p) => p.name === 'hexagonal');
    expect(hexagonal).toBeDefined();
    expect(hexagonal!.confidence).toBeGreaterThan(0.1);
  });

  it('detects layered architecture', () => {
    const files = [
      makeFile('src/controllers/user-controller.ts'),
      makeFile('src/services/user-service.ts'),
      makeFile('src/repositories/user-repository.ts'),
      makeFile('src/models/user-model.ts'),
      makeFile('src/middleware/auth.ts'),
    ];
    const modules = [
      makeModule('controllers', 'src/controllers'),
      makeModule('services', 'src/services'),
      makeModule('repositories', 'src/repositories'),
    ];

    const patterns = detectPatterns(files, modules);
    const layered = patterns.find((p) => p.name === 'layered');
    expect(layered).toBeDefined();
    expect(layered!.confidence).toBeGreaterThan(0.1);
  });

  it('detects event-driven architecture', () => {
    const files = [
      makeFile('src/events/user-created.ts'),
      makeFile('src/handlers/user-handler.ts'),
      makeFile('src/events/order-placed.ts'),
      makeFile('src/handlers/order-handler.ts'),
      makeFile('src/emitters/event-bus.ts'),
    ];
    const modules = [
      makeModule('events', 'src/events'),
      makeModule('handlers', 'src/handlers'),
    ];

    const patterns = detectPatterns(files, modules);
    const eventDriven = patterns.find((p) => p.name === 'event-driven');
    expect(eventDriven).toBeDefined();
  });

  it('detects MVC pattern', () => {
    const files = [
      makeFile('app/views/index.ts'),
      makeFile('app/controllers/home.ts'),
      makeFile('app/models/user.ts'),
    ];
    const modules = [
      makeModule('views', 'app/views'),
      makeModule('controllers', 'app/controllers'),
      makeModule('models', 'app/models'),
    ];

    const patterns = detectPatterns(files, modules);
    const mvc = patterns.find((p) => p.name === 'mvc');
    expect(mvc).toBeDefined();
  });

  it('detects plugin-based architecture', () => {
    const files = [
      makeFile('src/plugins/auth-plugin.ts'),
      makeFile('src/plugins/cache-plugin.ts'),
      makeFile('src/plugins/logging-plugin.ts'),
    ];
    const modules = [makeModule('plugins', 'src/plugins')];

    const patterns = detectPatterns(files, modules);
    const plugin = patterns.find((p) => p.name === 'plugin-based');
    expect(plugin).toBeDefined();
  });

  it('returns empty for flat codebase with no patterns', () => {
    const files = [
      makeFile('src/app.ts'),
      makeFile('src/utils.ts'),
      makeFile('src/config.ts'),
    ];

    const patterns = detectPatterns(files, []);
    expect(patterns).toHaveLength(0);
  });

  it('returns empty for empty file list', () => {
    const patterns = detectPatterns([], []);
    expect(patterns).toHaveLength(0);
  });

  it('sorts patterns by confidence descending', () => {
    const files = [
      makeFile('src/adapters/a.ts'),
      makeFile('src/adapters/b.ts'),
      makeFile('src/adapters/c.ts'),
      makeFile('src/domain/d.ts'),
      makeFile('src/events/e.ts'),
    ];
    const modules = [
      makeModule('adapters', 'src/adapters'),
      makeModule('domain', 'src/domain'),
      makeModule('events', 'src/events'),
    ];

    const patterns = detectPatterns(files, modules);
    for (let i = 1; i < patterns.length; i++) {
      expect(patterns[i].confidence).toBeLessThanOrEqual(patterns[i - 1].confidence);
    }
  });

  it('includes evidence in detected patterns', () => {
    const files = [
      makeFile('src/adapters/rest-adapter.ts'),
      makeFile('src/ports/user-port.ts'),
    ];
    const modules = [
      makeModule('adapters', 'src/adapters'),
      makeModule('ports', 'src/ports'),
    ];

    const patterns = detectPatterns(files, modules);
    const hexagonal = patterns.find((p) => p.name === 'hexagonal');
    expect(hexagonal).toBeDefined();
    expect(hexagonal!.evidence.length).toBeGreaterThan(0);
  });
});
