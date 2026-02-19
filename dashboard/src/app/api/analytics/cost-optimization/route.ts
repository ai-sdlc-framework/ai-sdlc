import { getStateStore } from '@/lib/state';

export async function GET() {
  try {
    const mod = await import('@ai-sdlc-enterprise/dashboard');
    const store = getStateStore();
    return mod.handleCostOptimizationRequest(store.getDatabase());
  } catch {
    return new Response(JSON.stringify({ error: 'Enterprise feature not available' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
