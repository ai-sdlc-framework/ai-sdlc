import { describe, it, expect } from 'vitest';
import { createABACAuthorizationHook, type ABACPolicy, type ABACContextProvider } from './abac.js';
import { createSimpleExpressionEvaluator } from './expression.js';
import { createRegoEvaluator } from './rego-evaluator.js';
import { createCELEvaluator } from './cel-evaluator.js';

describe('createABACAuthorizationHook', () => {
  describe('with simple expression evaluator', () => {
    const evaluator = createSimpleExpressionEvaluator();

    it('allows when allow policy matches', () => {
      const policies: ABACPolicy[] = [
        { name: 'allow-read', expression: 'action == "read"', effect: 'allow' },
      ];
      const hook = createABACAuthorizationHook(evaluator, policies);
      const result = hook({ agent: 'agent-1', action: 'read', target: 'resource-1' });
      expect(result.allowed).toBe(true);
    });

    it('denies when no policy matches', () => {
      const policies: ABACPolicy[] = [
        { name: 'allow-write', expression: 'action == "write"', effect: 'allow' },
      ];
      const hook = createABACAuthorizationHook(evaluator, policies);
      const result = hook({ agent: 'agent-1', action: 'read', target: 'resource-1' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('default deny');
    });

    it('deny policy takes precedence over allow', () => {
      const policies: ABACPolicy[] = [
        { name: 'deny-secrets', expression: 'action == "read"', effect: 'deny' },
        { name: 'allow-all', expression: 'action == "read"', effect: 'allow' },
      ];
      const hook = createABACAuthorizationHook(evaluator, policies);
      const result = hook({ agent: 'agent-1', action: 'read', target: 'secrets' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('deny-secrets');
    });
  });

  describe('with Rego evaluator', () => {
    const evaluator = createRegoEvaluator();

    it('evaluates Rego-style policies', () => {
      const policies: ABACPolicy[] = [
        {
          name: 'allow-senior-agents',
          expression: 'subject.level >= 3',
          effect: 'allow',
        },
      ];
      let subjectAttrs: Record<string, unknown> = { name: 'agent-1', level: 4 };
      const dynamicProvider: ABACContextProvider = (ctx) => ({
        subject: subjectAttrs,
        action: ctx.action,
        resource: { name: ctx.target },
      });

      const hook = createABACAuthorizationHook(evaluator, policies, dynamicProvider);

      const allowed = hook({ agent: 'agent-1', action: 'execute', target: 'prod' });
      expect(allowed.allowed).toBe(true);

      subjectAttrs = { name: 'agent-2', level: 1 };
      const denied = hook({ agent: 'agent-2', action: 'execute', target: 'prod' });
      expect(denied.allowed).toBe(false);
    });
  });

  describe('with CEL evaluator', () => {
    const evaluator = createCELEvaluator();

    it('evaluates CEL-style policies', () => {
      const policies: ABACPolicy[] = [
        {
          name: 'allow-read-own-team',
          expression: 'action == "read" && subject.team == resource.team',
          effect: 'allow',
        },
      ];

      let attrs: Record<string, unknown> = {};
      const provider: ABACContextProvider = (ctx) => ({
        subject: (attrs.subject as Record<string, unknown>) ?? { name: ctx.agent },
        resource: (attrs.resource as Record<string, unknown>) ?? { name: ctx.target },
        action: ctx.action,
      });

      const hook = createABACAuthorizationHook(evaluator, policies, provider);

      attrs = {
        subject: { name: 'agent-1', team: 'backend' },
        resource: { name: 'doc-1', team: 'backend' },
      };
      const allowed = hook({ agent: 'agent-1', action: 'read', target: 'doc-1' });
      expect(allowed.allowed).toBe(true);

      attrs = {
        subject: { name: 'agent-1', team: 'backend' },
        resource: { name: 'doc-2', team: 'frontend' },
      };
      const denied = hook({ agent: 'agent-1', action: 'read', target: 'doc-2' });
      expect(denied.allowed).toBe(false);
    });

    it('supports environment attributes', () => {
      const policies: ABACPolicy[] = [
        {
          name: 'allow-during-business-hours',
          expression: 'environment.hour >= 9 && environment.hour <= 17',
          effect: 'allow',
        },
      ];

      let envHour = 14;
      const provider: ABACContextProvider = (ctx) => ({
        subject: { name: ctx.agent },
        resource: { name: ctx.target },
        action: ctx.action,
        environment: { hour: envHour },
      });

      const hook = createABACAuthorizationHook(evaluator, policies, provider);

      const allowed = hook({ agent: 'agent-1', action: 'execute', target: 'prod' });
      expect(allowed.allowed).toBe(true);

      envHour = 3;
      const denied = hook({ agent: 'agent-1', action: 'execute', target: 'prod' });
      expect(denied.allowed).toBe(false);
    });
  });

  describe('multiple policies', () => {
    const evaluator = createSimpleExpressionEvaluator();

    it('first deny wins, even with later allow', () => {
      const policies: ABACPolicy[] = [
        { name: 'deny-execute', expression: 'action == "execute"', effect: 'deny' },
        { name: 'allow-all', expression: 'action == "execute"', effect: 'allow' },
      ];
      const hook = createABACAuthorizationHook(evaluator, policies);
      const result = hook({ agent: 'agent-1', action: 'execute', target: 'prod' });
      expect(result.allowed).toBe(false);
    });

    it('allow requires at least one matching allow policy', () => {
      const policies: ABACPolicy[] = [
        { name: 'allow-read', expression: 'action == "read"', effect: 'allow' },
        { name: 'allow-write', expression: 'action == "write"', effect: 'allow' },
      ];
      const hook = createABACAuthorizationHook(evaluator, policies);

      expect(hook({ agent: 'a', action: 'read', target: 'r' }).allowed).toBe(true);
      expect(hook({ agent: 'a', action: 'write', target: 'r' }).allowed).toBe(true);
      expect(hook({ agent: 'a', action: 'execute', target: 'r' }).allowed).toBe(false);
    });
  });
});
