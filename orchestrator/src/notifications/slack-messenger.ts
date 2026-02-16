/**
 * Slack Messenger — implements the Messenger interface using Slack Web API.
 *
 * Design decision D5: Uses chat.postMessage via Web API.
 */

import type { Messenger, NotificationInput, ThreadInput, Thread } from '@ai-sdlc/reference';

export interface SlackConfig {
  /** Slack Bot OAuth token (xoxb-...). */
  token: string;
  /** Base URL for Slack API. Defaults to https://slack.com/api. */
  apiUrl?: string;
  /** Default channel for notifications (can be overridden per message). */
  defaultChannel?: string;
}

interface SlackAPIResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
}

export class SlackMessenger implements Messenger {
  private config: SlackConfig;
  private apiUrl: string;

  constructor(config: SlackConfig) {
    this.config = config;
    this.apiUrl = config.apiUrl ?? 'https://slack.com/api';
  }

  async sendNotification(input: NotificationInput): Promise<void> {
    const channel = input.channel || this.config.defaultChannel;
    if (!channel) throw new Error('No channel specified for Slack notification');

    const icon = this.severityIcon(input.severity);
    await this.postMessage(channel, `${icon} ${input.message}`);
  }

  async createThread(input: ThreadInput): Promise<Thread> {
    const channel = input.channel || this.config.defaultChannel;
    if (!channel) throw new Error('No channel specified for Slack thread');

    const response = await this.postMessage(channel, `*${input.title}*\n\n${input.message}`);

    return {
      id: response.ts ?? '',
      url: `https://slack.com/archives/${response.channel}/p${response.ts?.replace('.', '')}`,
    };
  }

  async postUpdate(threadId: string, message: string): Promise<void> {
    const channel = this.config.defaultChannel;
    if (!channel) throw new Error('No default channel for thread update');

    await this.callAPI('chat.postMessage', {
      channel,
      text: message,
      thread_ts: threadId,
    });
  }

  private async postMessage(channel: string, text: string): Promise<SlackAPIResponse> {
    return this.callAPI('chat.postMessage', { channel, text });
  }

  private async callAPI(method: string, body: Record<string, unknown>): Promise<SlackAPIResponse> {
    const res = await fetch(`${this.apiUrl}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${this.config.token}`,
      },
      body: JSON.stringify(body),
    });

    const data = (await res.json()) as SlackAPIResponse;
    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error ?? 'unknown'}`);
    }
    return data;
  }

  private severityIcon(severity?: string): string {
    switch (severity) {
      case 'error':
        return ':red_circle:';
      case 'warning':
        return ':warning:';
      default:
        return ':information_source:';
    }
  }
}
