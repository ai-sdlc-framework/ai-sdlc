import { describe, it, expect } from 'vitest';
import type { DesignIntentDocument } from '@ai-sdlc/reference';
import {
  handleCoreIdentityChanged,
  type CoreIdentityChangedEvent,
  type RescoreDeps,
  type SoulGraphStaleFlag,
} from './rescore-orchestrator.js';

const API_VERSION = 'ai-sdlc.io/v1alpha1' as const;

function makeDid(name = 'acme-did'): DesignIntentDocument {
  return {
    apiVersion: API_VERSION,
    kind: 'DesignIntentDocument',
    metadata: { name },
    spec: {
      stewardship: {
        productAuthority: { owner: 'p', approvalRequired: ['p'], scope: ['m'] },
        designAuthority: { owner: 'd', approvalRequired: ['d'], scope: ['dp'] },
      },
      soulPurpose: {
        mission: { value: 'new mission' },
        designPrinciples: [
          {
            id: 'approachable',
            name: 'Approachable',
            description: 'd',
            measurableSignals: [{ id: 's', metric: 'm', threshold: 1, operator: 'gte' }],
          },
        ],
      },
      designSystemRef: { name: 'acme-ds' },
    },
  };
}

function makeEvent(): CoreIdentityChangedEvent {
  return {
    type: 'CoreIdentityChanged',
    didName: 'acme-did',
    changedFields: ['spec.soulPurpose.mission.value'],
    timestamp: '2026-04-24T00:00:00Z',
  };
}

describe('handleCoreIdentityChanged (AC #3)', () => {
  it('invokes recompile → rescore → flag in order and emits BacklogReshuffled', async () => {
    const calls: string[] = [];
    const did = makeDid();
    const deps: RescoreDeps = {
      getDid: () => did,
      recompileArtifacts: async () => {
        calls.push('recompile');
      },
      rescoreFullBacklog: async () => {
        calls.push('rescore');
        return 7;
      },
      flagInFlight: async () => {
        calls.push('flag');
        return [
          { issueNumber: 100, reason: 'core identity changed' },
          { issueNumber: 101, reason: 'core identity changed' },
        ] as SoulGraphStaleFlag[];
      },
    };
    const result = await handleCoreIdentityChanged(makeEvent(), deps);
    expect(calls).toEqual(['recompile', 'rescore', 'flag']);
    expect(result.skipped).toBe(false);
    expect(result.rescored).toBe(7);
    expect(result.inFlightFlags).toHaveLength(2);
    expect(result.reshuffled.type).toBe('BacklogReshuffled');
    expect(result.reshuffled.didName).toBe('acme-did');
    expect(result.reshuffled.rescoredItems).toBe(7);
    expect(result.reshuffled.inFlightFlagged).toBe(2);
  });

  it('skips when DID cannot be resolved', async () => {
    const deps: RescoreDeps = {
      getDid: () => undefined,
      recompileArtifacts: () => {
        throw new Error('should not be called');
      },
      rescoreFullBacklog: () => {
        throw new Error('should not be called');
      },
      flagInFlight: () => {
        throw new Error('should not be called');
      },
    };
    const result = await handleCoreIdentityChanged(makeEvent(), deps);
    expect(result.skipped).toBe(true);
    expect(result.rescored).toBe(0);
    expect(result.inFlightFlags).toEqual([]);
    expect(result.reshuffled.rescoredItems).toBe(0);
  });

  it('accepts synchronous callbacks alongside async ones', async () => {
    const deps: RescoreDeps = {
      getDid: () => makeDid(),
      recompileArtifacts: () => undefined, // sync
      rescoreFullBacklog: () => 3, // sync
      flagInFlight: () => [{ issueNumber: 1, reason: 'x' }], // sync
    };
    const result = await handleCoreIdentityChanged(makeEvent(), deps);
    expect(result.rescored).toBe(3);
    expect(result.inFlightFlags).toHaveLength(1);
  });

  it('includes triggeredAt from injected clock', async () => {
    const frozen = () => Date.parse('2026-04-24T00:00:00Z');
    const deps: RescoreDeps = {
      getDid: () => makeDid(),
      recompileArtifacts: () => undefined,
      rescoreFullBacklog: () => 0,
      flagInFlight: () => [],
      now: frozen,
    };
    const result = await handleCoreIdentityChanged(makeEvent(), deps);
    expect(result.reshuffled.triggeredAt).toBe('2026-04-24T00:00:00.000Z');
  });

  it('propagates errors from the rescore callback', async () => {
    const deps: RescoreDeps = {
      getDid: () => makeDid(),
      recompileArtifacts: () => undefined,
      rescoreFullBacklog: () => {
        throw new Error('rescore broke');
      },
      flagInFlight: () => [],
    };
    await expect(handleCoreIdentityChanged(makeEvent(), deps)).rejects.toThrow('rescore broke');
  });

  it('flags even zero in-flight items (empty array)', async () => {
    const deps: RescoreDeps = {
      getDid: () => makeDid(),
      recompileArtifacts: () => undefined,
      rescoreFullBacklog: () => 5,
      flagInFlight: () => [],
    };
    const result = await handleCoreIdentityChanged(makeEvent(), deps);
    expect(result.inFlightFlags).toEqual([]);
    expect(result.reshuffled.inFlightFlagged).toBe(0);
  });
});
