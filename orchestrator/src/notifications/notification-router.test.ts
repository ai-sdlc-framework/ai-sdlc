import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationRouter, type PipelineEvent, type NotificationRoute } from './notification-router.js';
import type { Messenger } from '@ai-sdlc/reference';

function makeMockMessenger(): Messenger & {
  sendNotification: ReturnType<typeof vi.fn>;
  createThread: ReturnType<typeof vi.fn>;
  postUpdate: ReturnType<typeof vi.fn>;
} {
  return {
    sendNotification: vi.fn().mockResolvedValue(undefined),
    createThread: vi.fn().mockResolvedValue({ id: 'thread-1', url: 'https://example.com/thread' }),
    postUpdate: vi.fn().mockResolvedValue(undefined),
  };
}

describe('NotificationRouter', () => {
  let messenger: ReturnType<typeof makeMockMessenger>;
  let router: NotificationRouter;

  beforeEach(() => {
    messenger = makeMockMessenger();
    router = new NotificationRouter();
  });

  it('dispatches events to matching routes', async () => {
    router.addRoute({ name: 'slack', messenger, channel: '#general' });

    await router.dispatch({
      type: 'pipeline-complete',
      data: { runId: 'run-1', prUrl: 'https://github.com/pr/1' },
    });

    expect(messenger.sendNotification).toHaveBeenCalledTimes(1);
    const call = messenger.sendNotification.mock.calls[0][0];
    expect(call.channel).toBe('#general');
    expect(call.message).toContain('Pipeline Completed');
    expect(call.message).toContain('https://github.com/pr/1');
  });

  it('filters by event type', async () => {
    router.addRoute({
      name: 'errors-only',
      messenger,
      channel: '#errors',
      events: ['pipeline-failed', 'agent-failed'],
    });

    await router.dispatch({ type: 'pipeline-complete', data: {} });
    expect(messenger.sendNotification).not.toHaveBeenCalled();

    await router.dispatch({ type: 'pipeline-failed', data: { runId: 'r1', error: 'timeout' } });
    expect(messenger.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('filters by minimum severity', async () => {
    router.addRoute({
      name: 'warnings-up',
      messenger,
      channel: '#alerts',
      minSeverity: 'warning',
    });

    // Info events should be filtered
    await router.dispatch({ type: 'pipeline-complete', data: {} });
    expect(messenger.sendNotification).not.toHaveBeenCalled();

    // Warning events should pass
    await router.dispatch({ type: 'cost-alert', data: { utilization: 80, spent: 80, budget: 100 } });
    expect(messenger.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('dispatches to multiple routes', async () => {
    const messenger2 = makeMockMessenger();
    router.addRoute({ name: 'slack', messenger, channel: '#general' });
    router.addRoute({ name: 'teams', messenger: messenger2, channel: '#general' });

    await router.dispatch({ type: 'pr-created', data: { prUrl: 'https://github.com/pr/1' } });

    expect(messenger.sendNotification).toHaveBeenCalledTimes(1);
    expect(messenger2.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('uses threads when configured', async () => {
    router.addRoute({ name: 'threaded', messenger, channel: '#ops', useThreads: true });

    // First event creates thread
    await router.dispatch({
      type: 'pipeline-start',
      data: { runId: 'r1', issueNumber: 42 },
    });
    expect(messenger.createThread).toHaveBeenCalledTimes(1);

    // Second event for same issue updates thread
    await router.dispatch({
      type: 'agent-complete',
      data: { agentName: 'dev', filesChanged: 3, issueNumber: 42 },
    });
    expect(messenger.postUpdate).toHaveBeenCalledTimes(1);
    expect(messenger.postUpdate).toHaveBeenCalledWith('thread-1', expect.any(String));
  });

  it('renders template variables', async () => {
    router.addRoute({ name: 'slack', messenger, channel: '#general' });

    await router.dispatch({
      type: 'gate-failure',
      data: { gateName: 'coverage', issueNumber: 42, details: 'Below 80%' },
    });

    const msg = messenger.sendNotification.mock.calls[0][0].message;
    expect(msg).toContain('coverage');
    expect(msg).toContain('Below 80%');
  });

  it('uses custom templates', async () => {
    const customRouter = new NotificationRouter({
      'pipeline-complete': { title: 'Done!', body: 'Run {runId} is done.' },
    });
    customRouter.addRoute({ name: 'slack', messenger, channel: '#general' });

    await customRouter.dispatch({ type: 'pipeline-complete', data: { runId: 'r1' } });

    const msg = messenger.sendNotification.mock.calls[0][0].message;
    expect(msg).toContain('Done!');
    expect(msg).toContain('Run r1 is done.');
  });

  it('removes route by name', async () => {
    router.addRoute({ name: 'slack', messenger, channel: '#general' });
    router.removeRoute('slack');

    await router.dispatch({ type: 'pipeline-complete', data: {} });
    expect(messenger.sendNotification).not.toHaveBeenCalled();
  });

  it('reports route count', () => {
    expect(router.routeCount).toBe(0);
    router.addRoute({ name: 'a', messenger, channel: '#a' });
    router.addRoute({ name: 'b', messenger, channel: '#b' });
    expect(router.routeCount).toBe(2);
  });

  it('handles messenger errors gracefully', async () => {
    messenger.sendNotification.mockRejectedValue(new Error('network error'));
    router.addRoute({ name: 'failing', messenger, channel: '#ch' });

    // Should not throw
    await router.dispatch({ type: 'pipeline-complete', data: {} });
  });

  it('uses error severity for failure events', async () => {
    router.addRoute({ name: 'slack', messenger, channel: '#general' });

    await router.dispatch({ type: 'pipeline-failed', data: { runId: 'r1', error: 'boom' } });

    expect(messenger.sendNotification.mock.calls[0][0].severity).toBe('error');
  });

  it('allows severity override in event', async () => {
    router.addRoute({ name: 'slack', messenger, channel: '#general', minSeverity: 'error' });

    // Pipeline-complete is normally 'info', but override to 'error'
    await router.dispatch({
      type: 'pipeline-complete',
      data: {},
      severity: 'error',
    });
    expect(messenger.sendNotification).toHaveBeenCalledTimes(1);
  });
});
