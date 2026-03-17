/**
 * Tests that index.ts re-exports are all accessible.
 */

import { describe, it, expect } from 'vitest';
import {
  createMcpServer,
  SessionManager,
  resolveIssue,
  handleSessionStart,
  handleGetContext,
  handleCheckTask,
  handleTrackUsage,
  handleCheckFile,
  handleSessionEnd,
} from './index.js';

describe('index.ts re-exports', () => {
  it('exports createMcpServer function', () => {
    expect(typeof createMcpServer).toBe('function');
  });

  it('exports SessionManager class', () => {
    expect(typeof SessionManager).toBe('function');
    const mgr = new SessionManager();
    expect(mgr).toBeDefined();
  });

  it('exports resolveIssue function', () => {
    expect(typeof resolveIssue).toBe('function');
  });

  it('exports all tool handler functions', () => {
    expect(typeof handleSessionStart).toBe('function');
    expect(typeof handleGetContext).toBe('function');
    expect(typeof handleCheckTask).toBe('function');
    expect(typeof handleTrackUsage).toBe('function');
    expect(typeof handleCheckFile).toBe('function');
    expect(typeof handleSessionEnd).toBe('function');
  });
});
