/**
 * ai-sdlc dashboard — live TUI monitoring dashboard.
 *
 * Uses setInterval + ANSI repainting. Ctrl-C to exit.
 * D1: Zero dependencies — pure ANSI escape codes.
 */

import { Command } from 'commander';
import { Orchestrator } from '../../orchestrator.js';
import { renderDashboardFrame } from '../dashboard-renderer.js';
import { DEFAULT_DASHBOARD_REFRESH_MS } from '../../defaults.js';

export const dashboardCommand = new Command('dashboard')
  .description('Live monitoring dashboard (Ctrl-C to exit)')
  .option('--refresh <ms>', 'Refresh interval in ms', String(DEFAULT_DASHBOARD_REFRESH_MS))
  .option('--state <path>', 'SQLite state database path')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.parent?.opts() ?? {};
    const refreshMs = parseInt(opts.refresh, 10) || DEFAULT_DASHBOARD_REFRESH_MS;

    const orchestrator = new Orchestrator({
      configDir: globalOpts.config,
      statePath: opts.state,
    });

    // Clear screen and hide cursor
    process.stdout.write('\x1B[?25l\x1B[2J\x1B[H');

    const render = async () => {
      try {
        const data = await orchestrator.dashboard();
        const width = process.stdout.columns || 80;
        const frame = renderDashboardFrame(data, width);
        // Move cursor to top-left and write frame
        process.stdout.write('\x1B[H' + frame);
      } catch {
        // Dashboard rendering is best-effort
      }
    };

    // Initial render
    await render();

    // Polling loop
    const interval = setInterval(render, refreshMs);

    // Graceful shutdown
    const cleanup = () => {
      clearInterval(interval);
      process.stdout.write('\x1B[?25h\n'); // Show cursor
      orchestrator.close();
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  });
