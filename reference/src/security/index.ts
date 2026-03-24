export type {
  NetworkPolicy,
  SandboxConstraints,
  SandboxStatus,
  Sandbox,
  SecretStore,
  JITCredential,
  JITCredentialIssuer,
  KillSwitch,
  ApprovalTier,
  ApprovalStatus,
  ApprovalRequest,
  ApprovalWorkflow,
} from './interfaces.js';

export {
  classifyApprovalTier,
  compareTiers,
  type ApprovalClassificationInput,
} from './approval-tier.js';

export {
  createStubSandbox,
  createStubJITCredentialIssuer,
  createStubKillSwitch,
  createStubApprovalWorkflow,
} from './stubs.js';

export {
  createGitHubSandbox,
  type CodespacesClient,
  type GitHubSandboxConfig,
} from './github-sandbox.js';

export {
  createGitHubJITCredentialIssuer,
  type SecretsClient,
  type SecretEncryptor,
  type GitHubJITConfig,
} from './github-jit.js';

export { createEnvSecretStore } from './env-secret-store.js';

export { createDockerSandbox, type ShellExec, type DockerSandboxConfig } from './docker-sandbox.js';

export {
  createOpenShellSandbox,
  isOpenShellAvailable,
  buildSandboxExecPrefix,
  type OpenShellSandboxConfig,
  type ProviderCredential,
} from './openshell-sandbox.js';

export {
  generateOpenShellPolicy,
  serializePolicy,
  type OpenShellPolicy,
  type OpenShellFilesystemPolicy,
  type OpenShellNetworkPolicy,
  type OpenShellEndpoint,
  type PolicyGenerationOptions,
} from './openshell-policy.js';
