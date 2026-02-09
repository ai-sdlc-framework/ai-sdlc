/**
 * Security context module — integrates enterprise security primitives
 * (sandbox, JIT credentials, kill switch, approval workflow) into the
 * dogfood pipeline.
 *
 * Uses stub implementations from the reference for testability.
 */

import {
  createStubSandbox,
  createStubJITCredentialIssuer,
  createStubKillSwitch,
  createStubApprovalWorkflow,
  createGitHubSandbox,
  createGitHubJITCredentialIssuer,
  classifyApprovalTier,
  compareTiers,
  type Sandbox,
  type JITCredentialIssuer,
  type JITCredential,
  type KillSwitch,
  type ApprovalWorkflow,
  type ApprovalTier,
  type ApprovalRequest,
  type CodespacesClient,
  type GitHubSandboxConfig,
  type SecretsClient,
  type SecretEncryptor,
  type GitHubJITConfig,
  type NetworkPolicy,
  type SandboxConstraints,
  type SandboxStatus,
  type ApprovalStatus,
  type ApprovalClassificationInput,
} from '@ai-sdlc/reference';

export interface SecurityContext {
  sandbox: Sandbox;
  jitCredentials: JITCredentialIssuer;
  killSwitch: KillSwitch;
  approvalWorkflow: ApprovalWorkflow;
}

/**
 * Create a pipeline security context using stub implementations.
 * Accepts optional partial overrides to replace individual primitives.
 */
export function createPipelineSecurity(overrides?: Partial<SecurityContext>): SecurityContext {
  return {
    sandbox: overrides?.sandbox ?? createStubSandbox(),
    jitCredentials: overrides?.jitCredentials ?? createStubJITCredentialIssuer(),
    killSwitch: overrides?.killSwitch ?? createStubKillSwitch(),
    approvalWorkflow: overrides?.approvalWorkflow ?? createStubApprovalWorkflow(),
  };
}

/**
 * Check the kill switch and throw if active.
 */
export async function checkKillSwitch(security: SecurityContext): Promise<void> {
  const active = await security.killSwitch.isActive();
  if (active) {
    const reason = await security.killSwitch.getReason();
    throw new Error(`Pipeline aborted: kill switch active — ${reason ?? 'no reason given'}`);
  }
}

/**
 * Issue JIT credentials for an agent with a scoped TTL.
 */
export async function issueAgentCredentials(
  security: SecurityContext,
  agentId: string,
  scope: string[] = ['repo:read', 'repo:write'],
  ttlMs: number = 600_000,
): Promise<JITCredential> {
  return security.jitCredentials.issue(agentId, scope, ttlMs);
}

/**
 * Revoke agent credentials after execution.
 */
export async function revokeAgentCredentials(
  security: SecurityContext,
  credentialId: string,
): Promise<void> {
  await security.jitCredentials.revoke(credentialId);
}

/**
 * Classify the required approval tier and submit an approval request.
 * Returns the request (auto-approved if tier is 'auto').
 */
export async function classifyAndSubmitApproval(
  security: SecurityContext,
  complexityScore: number,
  requester: string,
  description: string,
  opts?: { securitySensitive?: boolean; isInfraChange?: boolean },
): Promise<ApprovalRequest> {
  const tier = classifyApprovalTier({
    complexityScore,
    securitySensitive: opts?.securitySensitive,
    isInfraChange: opts?.isInfraChange,
  });
  return security.approvalWorkflow.submit(tier, requester, description);
}

/**
 * Create a GitHub Codespace-backed sandbox (requires CodespacesClient).
 */
export function createGitHubSandboxProvider(
  client: CodespacesClient,
  config: GitHubSandboxConfig,
): Sandbox {
  return createGitHubSandbox(client, config);
}

/**
 * Create a GitHub Secrets-backed JIT credential issuer (requires SecretsClient).
 * Encryptor can be provided via config.encryptor.
 */
export function createGitHubJITProvider(
  client: SecretsClient,
  config: GitHubJITConfig,
): JITCredentialIssuer {
  return createGitHubJITCredentialIssuer(client, config);
}

export { classifyApprovalTier, compareTiers, createGitHubSandbox, createGitHubJITCredentialIssuer };
export type {
  ApprovalTier,
  ApprovalRequest,
  JITCredential,
  CodespacesClient,
  GitHubSandboxConfig,
  SecretsClient,
  SecretEncryptor,
  GitHubJITConfig,
  NetworkPolicy,
  SandboxConstraints,
  SandboxStatus,
  ApprovalStatus,
  ApprovalClassificationInput,
};
