export const dynamic = 'force-dynamic';

import { getStateStore } from '@/lib/state';

export default async function RoiPage() {
  try {
    const mod = await import('@ai-sdlc-enterprise/dashboard');
    const { RoiDashboardPage } = mod;
    const store = getStateStore();
    return <RoiDashboardPage db={store.getDatabase()} />;
  } catch {
    return (
      <div style={{ padding: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>ROI Dashboard</h1>
        <p style={{ color: '#64748b' }}>
          This is an enterprise feature. Install{' '}
          <code>@ai-sdlc-enterprise/dashboard</code> to enable ROI analytics.
        </p>
      </div>
    );
  }
}
