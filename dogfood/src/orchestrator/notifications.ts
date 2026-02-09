/**
 * Notification template rendering utility.
 * Replaces {key} placeholders in title and body with provided variable values.
 */

import type { NotificationTemplate } from '@ai-sdlc/reference';

/**
 * Render a notification template by replacing {key} placeholders with values.
 */
export function renderTemplate(
  template: NotificationTemplate,
  vars: Record<string, string>,
): { title: string; body: string } {
  return {
    title: interpolate(template.title, vars),
    body: interpolate(template.body ?? '', vars),
  };
}

function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
}
