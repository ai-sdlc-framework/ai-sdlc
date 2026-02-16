/**
 * Microsoft Teams Messenger — implements the Messenger interface using incoming webhooks.
 *
 * Design decision D5: Uses incoming webhook URLs for simplicity.
 */

import type { Messenger, NotificationInput, ThreadInput, Thread } from '@ai-sdlc/reference';

export interface TeamsConfig {
  /** Incoming webhook URL. */
  webhookUrl: string;
}

interface TeamsCard {
  type: string;
  attachments: Array<{
    contentType: string;
    content: {
      $schema: string;
      type: string;
      version: string;
      body: Array<{ type: string; text: string; weight?: string; size?: string; wrap?: boolean }>;
    };
  }>;
}

export class TeamsMessenger implements Messenger {
  private config: TeamsConfig;

  constructor(config: TeamsConfig) {
    this.config = config;
  }

  async sendNotification(input: NotificationInput): Promise<void> {
    const icon = this.severityIcon(input.severity);
    const card = this.buildCard(`${icon} ${input.message}`);
    await this.postWebhook(card);
  }

  async createThread(input: ThreadInput): Promise<Thread> {
    const card = this.buildCard(input.message, input.title);
    await this.postWebhook(card);

    // Teams webhooks don't return thread IDs, so generate a correlation ID
    const threadId = `teams-${Date.now()}`;
    return {
      id: threadId,
      url: this.config.webhookUrl,
    };
  }

  async postUpdate(threadId: string, message: string): Promise<void> {
    // Teams webhooks are fire-and-forget — no thread reply support
    // Send as a new message referencing the thread
    const card = this.buildCard(`[Thread: ${threadId}] ${message}`);
    await this.postWebhook(card);
  }

  private buildCard(message: string, title?: string): TeamsCard {
    const body: TeamsCard['attachments'][0]['content']['body'] = [];

    if (title) {
      body.push({
        type: 'TextBlock',
        text: title,
        weight: 'Bolder',
        size: 'Medium',
        wrap: true,
      });
    }

    body.push({
      type: 'TextBlock',
      text: message,
      wrap: true,
    });

    return {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body,
          },
        },
      ],
    };
  }

  private async postWebhook(card: TeamsCard): Promise<void> {
    const res = await fetch(this.config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Teams webhook error ${res.status}: ${text.slice(0, 200)}`);
    }
  }

  private severityIcon(severity?: string): string {
    switch (severity) {
      case 'error':
        return '🔴';
      case 'warning':
        return '⚠️';
      default:
        return 'ℹ️';
    }
  }
}
