/**
 * Minimal type declarations for @ai-sdlc-enterprise/plugins.
 * The enterprise package is an optional dependency — loaded dynamically.
 */
declare module '@ai-sdlc-enterprise/plugins' {
  import type { OrchestratorPlugin } from '@ai-sdlc/orchestrator';

  export class ManagedSettingsPlugin implements OrchestratorPlugin {
    readonly name: string;
    constructor(config?: Record<string, unknown>);
    initialize(ctx: unknown): void;
  }

  export class ClaudeCodeAuditHookPlugin implements OrchestratorPlugin {
    readonly name: string;
    constructor(config: { relayEndpoint: string; tokenEnvVar?: string });
    initialize(ctx: unknown): void;
  }

  export class PermissionHookPlugin implements OrchestratorPlugin {
    readonly name: string;
    constructor(config?: { orgPolicy?: string });
    initialize(ctx: unknown): void;
  }

  export class TelemetryPushPlugin implements OrchestratorPlugin {
    readonly name: string;
    constructor(config: { endpoint: string; headers?: Record<string, string> });
    initialize(ctx: unknown): void;
  }

  export class RemotePolicyPlugin implements OrchestratorPlugin {
    readonly name: string;
    constructor(config: { endpoint: string; failOpen?: boolean });
    initialize(ctx: unknown): void;
  }

  export class SiemExportPlugin implements OrchestratorPlugin {
    readonly name: string;
    constructor(config: { provider: string; endpoint: string; tokenEnvVar?: string });
    initialize(ctx: unknown): Promise<void>;
  }
}
