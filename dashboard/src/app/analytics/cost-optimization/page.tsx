export const dynamic = 'force-dynamic';

import { getStateStore } from '@/lib/state';

export default async function CostOptimizationPage() {
  try {
    const mod = await import('@ai-sdlc-enterprise/dashboard');
    const { CostOptimizationPage: Page } = mod;
    const store = getStateStore();
    return <Page db={store.getDatabase()} />;
  } catch {
    return (
      <div style={{ padding: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Cost Optimization</h1>
        <p style={{ color: '#64748b' }}>
          This is an enterprise feature. Install <code>@ai-sdlc-enterprise/dashboard</code> to
          enable cost optimization analytics.
        </p>
      </div>
    );
  }
}
