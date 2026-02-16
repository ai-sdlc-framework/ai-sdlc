import { describe, it, expect } from 'vitest';
import { detectConventions } from './convention-detector.js';
import type { FileInfo } from './types.js';

function makeFile(relativePath: string, lineCount = 10): FileInfo {
  return {
    path: `/repo/${relativePath}`,
    relativePath,
    lineCount,
    extension: relativePath.split('.').pop()!.replace(/^/, '.'),
  };
}

describe('convention-detector', () => {
  describe('naming conventions', () => {
    it('detects kebab-case naming', () => {
      const files: FileInfo[] = [
        makeFile('src/user-service.ts'),
        makeFile('src/auth-handler.ts'),
        makeFile('src/data-store.ts'),
        makeFile('src/api-client.ts'),
      ];

      const conventions = detectConventions(files);
      const naming = conventions.find((c) => c.category === 'naming');
      expect(naming).toBeDefined();
      expect(naming!.pattern).toContain('kebab-case');
      expect(naming!.confidence).toBeGreaterThan(0.5);
    });

    it('detects camelCase naming', () => {
      const files: FileInfo[] = [
        makeFile('src/userService.ts'),
        makeFile('src/authHandler.ts'),
        makeFile('src/dataStore.ts'),
      ];

      const conventions = detectConventions(files);
      const naming = conventions.find((c) => c.category === 'naming');
      expect(naming).toBeDefined();
      expect(naming!.pattern).toContain('camelCase');
    });

    it('detects PascalCase naming', () => {
      const files: FileInfo[] = [
        makeFile('src/UserService.ts'),
        makeFile('src/AuthHandler.ts'),
        makeFile('src/DataStore.ts'),
      ];

      const conventions = detectConventions(files);
      const naming = conventions.find((c) => c.category === 'naming');
      expect(naming).toBeDefined();
      expect(naming!.pattern).toContain('PascalCase');
    });

    it('detects snake_case naming', () => {
      const files: FileInfo[] = [
        makeFile('src/user_service.ts'),
        makeFile('src/auth_handler.ts'),
        makeFile('src/data_store.ts'),
      ];

      const conventions = detectConventions(files);
      const naming = conventions.find((c) => c.category === 'naming');
      expect(naming).toBeDefined();
      expect(naming!.pattern).toContain('snake_case');
    });

    it('ignores index files for naming detection', () => {
      const files: FileInfo[] = [
        makeFile('src/index.ts'),
        makeFile('src/user-service.ts'),
        makeFile('src/auth-handler.ts'),
      ];

      const conventions = detectConventions(files);
      const naming = conventions.find((c) => c.category === 'naming');
      expect(naming!.pattern).toContain('kebab-case');
    });

    it('strips test suffix before detecting style', () => {
      const files: FileInfo[] = [
        makeFile('src/user-service.test.ts'),
        makeFile('src/auth-handler.spec.ts'),
        makeFile('src/data-store.ts'),
      ];

      const conventions = detectConventions(files);
      const naming = conventions.find((c) => c.category === 'naming');
      expect(naming!.pattern).toContain('kebab-case');
    });
  });

  describe('testing conventions', () => {
    it('detects co-located tests', () => {
      const files: FileInfo[] = [
        makeFile('src/service.ts'),
        makeFile('src/service.test.ts'),
        makeFile('src/handler.ts'),
        makeFile('src/handler.test.ts'),
      ];

      const conventions = detectConventions(files);
      const testing = conventions.find((c) => c.category === 'testing');
      expect(testing).toBeDefined();
      expect(testing!.pattern).toContain('Co-located');
    });

    it('detects __tests__ directory convention', () => {
      const files: FileInfo[] = [
        makeFile('src/service.ts'),
        makeFile('src/__tests__/service.test.ts'),
        makeFile('src/handler.ts'),
        makeFile('src/__tests__/handler.test.ts'),
      ];

      const conventions = detectConventions(files);
      const testing = conventions.find((c) => c.category === 'testing');
      expect(testing).toBeDefined();
      expect(testing!.pattern).toContain('__tests__');
    });

    it('detects test directory convention', () => {
      const files: FileInfo[] = [
        makeFile('src/service.ts'),
        makeFile('test/service.test.ts'),
        makeFile('test/handler.test.ts'),
      ];

      const conventions = detectConventions(files);
      const testing = conventions.find((c) => c.category === 'testing');
      expect(testing).toBeDefined();
      expect(testing!.pattern).toContain('test/ directory');
    });

    it('handles no test files', () => {
      const files: FileInfo[] = [
        makeFile('src/service.ts'),
        makeFile('src/handler.ts'),
      ];

      const conventions = detectConventions(files);
      const testing = conventions.find((c) => c.category === 'testing');
      // No test files means no testing convention detected
      if (testing) {
        expect(testing.confidence).toBe(0);
      } else {
        expect(testing).toBeUndefined();
      }
    });
  });

  describe('import conventions', () => {
    it('detects barrel re-exports', () => {
      const files: FileInfo[] = [
        makeFile('src/index.ts'),
        makeFile('src/state/index.ts'),
        makeFile('src/runners/index.ts'),
        makeFile('src/cli/index.ts'),
        makeFile('src/service.ts'),
      ];

      const conventions = detectConventions(files);
      const imports = conventions.find((c) => c.category === 'imports');
      expect(imports).toBeDefined();
      expect(imports!.pattern).toContain('barrel re-exports');
    });

    it('detects relative imports without barrels', () => {
      const files: FileInfo[] = [
        makeFile('src/a.ts'),
        makeFile('src/b.ts'),
      ];

      const conventions = detectConventions(files);
      const imports = conventions.find((c) => c.category === 'imports');
      expect(imports).toBeDefined();
      expect(imports!.pattern).toBe('Relative imports');
    });
  });

  describe('overall', () => {
    it('returns all convention categories', () => {
      const files: FileInfo[] = [
        makeFile('src/index.ts'),
        makeFile('src/user-service.ts'),
        makeFile('src/user-service.test.ts'),
      ];

      const conventions = detectConventions(files);
      const categories = conventions.map((c) => c.category);
      expect(categories).toContain('naming');
      expect(categories).toContain('testing');
      expect(categories).toContain('imports');
    });

    it('handles empty file list', () => {
      const conventions = detectConventions([]);
      // Should return import convention with default
      expect(conventions.length).toBeGreaterThanOrEqual(1);
    });
  });
});
