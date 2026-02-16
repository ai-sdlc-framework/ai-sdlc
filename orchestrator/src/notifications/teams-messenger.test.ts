import { describe, it, expect, vi, afterEach } from 'vitest';
import { TeamsMessenger } from './teams-messenger.js';

describe('TeamsMessenger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends notification via webhook', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(''),
    } as Response);

    const messenger = new TeamsMessenger({ webhookUrl: 'https://teams.example.com/webhook' });
    await messenger.sendNotification({ channel: '#general', message: 'Pipeline done', severity: 'info' });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://teams.example.com/webhook',
      expect.objectContaining({ method: 'POST' }),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.type).toBe('message');
    expect(body.attachments[0].content.body[0].text).toContain('Pipeline done');
  });

  it('creates thread and returns correlation ID', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(''),
    } as Response);

    const messenger = new TeamsMessenger({ webhookUrl: 'https://teams.example.com/webhook' });
    const thread = await messenger.createThread({
      channel: '#general',
      title: 'Pipeline Run',
      message: 'Started',
    });

    expect(thread.id).toMatch(/^teams-\d+$/);
    expect(thread.url).toBe('https://teams.example.com/webhook');
  });

  it('posts thread update', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(''),
    } as Response);

    const messenger = new TeamsMessenger({ webhookUrl: 'https://teams.example.com/webhook' });
    await messenger.postUpdate('teams-123', 'Stage completed');

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.attachments[0].content.body[0].text).toContain('teams-123');
  });

  it('throws on webhook error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('Bad Request'),
    } as Response);

    const messenger = new TeamsMessenger({ webhookUrl: 'https://teams.example.com/webhook' });
    await expect(
      messenger.sendNotification({ channel: '#general', message: 'test' }),
    ).rejects.toThrow('Teams webhook error');
  });

  it('uses adaptive card format', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(''),
    } as Response);

    const messenger = new TeamsMessenger({ webhookUrl: 'https://teams.example.com/webhook' });
    await messenger.sendNotification({ channel: '#ch', message: 'test' });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(body.attachments[0].content.type).toBe('AdaptiveCard');
  });
});
