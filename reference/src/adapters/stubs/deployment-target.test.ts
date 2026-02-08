import { describe, it, expect } from 'vitest';
import { createStubDeploymentTarget } from './deployment-target.js';

describe('createStubDeploymentTarget', () => {
  it('deploys and returns deployment info', async () => {
    const dt = createStubDeploymentTarget();
    const deployment = await dt.deploy({
      artifact: 'app:v1',
      environment: 'staging',
      version: '1.0.0',
    });
    expect(deployment.id).toMatch(/^deploy-/);
    expect(deployment.status).toBe('succeeded');
    expect(deployment.environment).toBe('staging');
    expect(deployment.url).toContain('staging');
  });

  it('gets deployment status', async () => {
    const dt = createStubDeploymentTarget();
    const deployment = await dt.deploy({
      artifact: 'app:v2',
      environment: 'production',
      version: '2.0.0',
    });
    const status = await dt.getDeploymentStatus(deployment.id);
    expect(status.status).toBe('succeeded');
    expect(status.environment).toBe('production');
  });

  it('rolls back a deployment', async () => {
    const dt = createStubDeploymentTarget();
    const deployment = await dt.deploy({
      artifact: 'app:v1',
      environment: 'staging',
      version: '1.0.0',
    });
    const rolledBack = await dt.rollback(deployment.id);
    expect(rolledBack.status).toBe('rolled-back');
    const status = await dt.getDeploymentStatus(deployment.id);
    expect(status.status).toBe('rolled-back');
  });

  it('throws for unknown deployment', async () => {
    const dt = createStubDeploymentTarget();
    await expect(dt.getDeploymentStatus('unknown')).rejects.toThrow('not found');
    await expect(dt.rollback('unknown')).rejects.toThrow('not found');
  });

  it('watch returns empty async iterator', async () => {
    const dt = createStubDeploymentTarget();
    const stream = dt.watchDeploymentEvents({});
    const iter = stream[Symbol.asyncIterator]();
    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  it('exposes deployments map for inspection', async () => {
    const dt = createStubDeploymentTarget();
    await dt.deploy({ artifact: 'a', environment: 'dev', version: '1' });
    await dt.deploy({ artifact: 'b', environment: 'prod', version: '2' });
    const deployments = dt.getDeployments();
    expect(deployments.size).toBe(2);
  });

  it('tracks multiple deployments independently', async () => {
    const dt = createStubDeploymentTarget();
    const d1 = await dt.deploy({ artifact: 'a', environment: 'dev', version: '1' });
    const d2 = await dt.deploy({ artifact: 'b', environment: 'staging', version: '2' });
    await dt.rollback(d1.id);
    const s1 = await dt.getDeploymentStatus(d1.id);
    const s2 = await dt.getDeploymentStatus(d2.id);
    expect(s1.status).toBe('rolled-back');
    expect(s2.status).toBe('succeeded');
  });
});
