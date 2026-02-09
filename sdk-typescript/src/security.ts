/**
 * Enterprise security interfaces, approval tiers, and stubs.
 * Subpath: @ai-sdlc/sdk/security
 */
export {
  // Interfaces
  type NetworkPolicy,
  type SandboxConstraints,
  type SandboxStatus,
  type Sandbox,
  type JITCredential,
  type JITCredentialIssuer,
  type KillSwitch,
  type ApprovalTier,
  type ApprovalStatus,
  type ApprovalRequest,
  type ApprovalWorkflow,

  // Approval classification
  classifyApprovalTier,
  compareTiers,
  type ApprovalClassificationInput,

  // Stubs
  createStubSandbox,
  createStubJITCredentialIssuer,
  createStubKillSwitch,
  createStubApprovalWorkflow,

  // GitHub implementations
  createGitHubSandbox,
  type CodespacesClient,
  type GitHubSandboxConfig,
  createGitHubJITCredentialIssuer,
  type SecretsClient,
  type SecretEncryptor,
  type GitHubJITConfig,
} from '@ai-sdlc/reference';
