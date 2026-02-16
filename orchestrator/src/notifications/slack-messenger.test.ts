import { describe, it, expect, vi, afterEach } from 'vitest';
import { SlackMessenger } from './slack-messenger.js';

function mockSlackAPI(response: { ok: boolean; ts?: string; channel?: string; error?: string }): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(response),
  } as Response);
}

describe('SlackMessenger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends notification to channel', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    const messenger = new SlackMessenger({ token: 'xoxb-test', defaultChannel: '#general' });
    await messenger.sendNotification({
      channel: '#alerts',
      message: 'Pipeline completed',
      severity: 'info',
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.channel).toBe('#alerts');
    expect(body.text).toContain('Pipeline completed');
    expect(body.text).toContain(':information_source:');
  });

  it('uses default channel when none specified', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    const messenger = new SlackMessenger({ token: 'xoxb-test', defaultChannel: '#default' });
    await messenger.sendNotification({ channel: '', message: 'test' });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.channel).toBe('#default');
  });

  it('creates thread and returns URL', async () => {
    mockSlackAPI({ ok: true, ts: '1234567890.123456', channel: 'C0123' });

    const messenger = new SlackMessenger({ token: 'xoxb-test', defaultChannel: '#general' });
    const thread = await messenger.createThread({
      channel: '#general',
      title: 'Pipeline Run',
      message: 'Started',
    });

    expect(thread.id).toBe('1234567890.123456');
    expect(thread.url).toContain('C0123');
  });

  it('posts thread reply', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    const messenger = new SlackMessenger({ token: 'xoxb-test', defaultChannel: '#general' });
    await messenger.postUpdate('1234567890.123456', 'Stage completed');

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.thread_ts).toBe('1234567890.123456');
    expect(body.text).toBe('Stage completed');
  });

  it('throws on API error', async () => {
    mockSlackAPI({ ok: false, error: 'channel_not_found' });

    const messenger = new SlackMessenger({ token: 'xoxb-test' });
    await expect(
      messenger.sendNotification({ channel: '#nonexistent', message: 'test' }),
    ).rejects.toThrow('channel_not_found');
  });

  it('uses error severity icon', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    const messenger = new SlackMessenger({ token: 'xoxb-test', defaultChannel: '#alerts' });
    await messenger.sendNotification({ channel: '#alerts', message: 'Failed', severity: 'error' });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.text).toContain(':red_circle:');
  });

  it('sends auth header', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    const messenger = new SlackMessenger({ token: 'xoxb-secret' });
    await messenger.sendNotification({ channel: '#ch', message: 'test' });

    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer xoxb-secret');
  });
});
