import { describe, it, expect } from 'vitest';
import { renderTemplate } from './notifications.js';
import type { NotificationTemplate } from '@ai-sdlc/reference';

describe('renderTemplate()', () => {
  it('renders title and body with variables', () => {
    const template: NotificationTemplate = {
      target: 'issue',
      title: 'AI-SDLC: Gate Failed',
      body: 'Details: {details}',
    };
    const result = renderTemplate(template, { details: 'coverage below 80%' });
    expect(result.title).toBe('AI-SDLC: Gate Failed');
    expect(result.body).toBe('Details: coverage below 80%');
  });

  it('renders notification template on gate failure', () => {
    const template: NotificationTemplate = {
      target: 'issue',
      title: 'AI-SDLC: Quality Gate Failed',
      body: '{details}',
    };
    const result = renderTemplate(template, { details: 'missing acceptance criteria' });
    expect(result.body).toBe('missing acceptance criteria');
  });

  it('renders notification template on agent failure', () => {
    const template: NotificationTemplate = {
      target: 'issue',
      title: 'AI-SDLC: Agent Failed',
      body: 'Error during {stageName}: {details}',
    };
    const result = renderTemplate(template, { stageName: 'code', details: 'compilation error' });
    expect(result.body).toBe('Error during code: compilation error');
  });

  it('renders notification template on PR creation', () => {
    const template: NotificationTemplate = {
      target: 'issue',
      title: 'AI-SDLC: PR Created',
      body: 'Pull request: {prUrl}',
    };
    const result = renderTemplate(template, { prUrl: 'https://github.com/org/repo/pull/123' });
    expect(result.body).toBe('Pull request: https://github.com/org/repo/pull/123');
  });

  it('leaves unknown placeholders intact', () => {
    const template: NotificationTemplate = {
      target: 'both',
      title: '{unknown} title',
      body: 'body with {missing}',
    };
    const result = renderTemplate(template, {});
    expect(result.title).toBe('{unknown} title');
    expect(result.body).toBe('body with {missing}');
  });

  it('handles template with no body', () => {
    const template: NotificationTemplate = {
      target: 'pr',
      title: 'Title only',
    };
    const result = renderTemplate(template, {});
    expect(result.title).toBe('Title only');
    expect(result.body).toBe('');
  });
});
