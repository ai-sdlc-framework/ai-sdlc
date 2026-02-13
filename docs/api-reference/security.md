# Security

Enterprise security primitives: sandboxed execution, JIT credential issuance, kill switches, and approval workflows.

## Import

```typescript
import {
  // Interfaces
  type NetworkPolicy,
  type SandboxConstraints,
  type SandboxStatus,
  type Sandbox,
  type SecretStore,
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

  // Stubs (for testing)
  createStubSandbox,
  createStubJITCredentialIssuer,
  createStubKillSwitch,
  createStubApprovalWorkflow,

  // GitHub implementations
  createGitHubSandbox,
  createGitHubJITCredentialIssuer,
  type GitHubSandboxConfig,
  type GitHubJITConfig,

  // Docker sandbox
  createDockerSandbox,
  type DockerSandboxConfig,

  // Secret store
  createEnvSecretStore,
} from '@ai-sdlc/reference';
```

## Interfaces

### `Sandbox`

Sandboxed execution environment for agent code.

```typescript
interface Sandbox {
  create(constraints: SandboxConstraints): Promise<SandboxStatus>;
  destroy(id: string): Promise<void>;
  getStatus(id: string): Promise<SandboxStatus>;
  execute(id: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
```

### `JITCredentialIssuer`

Just-in-time credential issuance with automatic expiration.

```typescript
interface JITCredentialIssuer {
  issue(scope: string[], ttl: string): Promise<JITCredential>;
  revoke(credentialId: string): Promise<void>;
}
```

### `KillSwitch`

Emergency stop mechanism for agent operations.

```typescript
interface KillSwitch {
  activate(reason: string): Promise<void>;
  deactivate(): Promise<void>;
  isActive(): Promise<boolean>;
  getReason(): Promise<string | undefined>;
}
```

### `ApprovalWorkflow`

Multi-tier approval workflow for sensitive operations.

```typescript
interface ApprovalWorkflow {
  request(request: ApprovalRequest): Promise<string>;  // returns request ID
  approve(requestId: string, approver: string): Promise<ApprovalStatus>;
  reject(requestId: string, approver: string, reason: string): Promise<ApprovalStatus>;
  getStatus(requestId: string): Promise<ApprovalStatus>;
}
```

### `SecretStore`

```typescript
interface SecretStore {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
}
```

## Functions

### `classifyApprovalTier(input)`

Classify an operation into an approval tier based on its characteristics.

```typescript
function classifyApprovalTier(input: ApprovalClassificationInput): ApprovalTier;
```

Tiers: `'auto'`, `'peer-review'`, `'team-lead'`, `'security-review'`.

### `compareTiers(a, b)`

Compare two approval tiers. Returns negative if `a < b`, zero if equal, positive if `a > b`.

## Implementations

### `createGitHubSandbox(config)`

Create a `Sandbox` backed by GitHub Codespaces.

```typescript
function createGitHubSandbox(config: GitHubSandboxConfig): Sandbox;
```

### `createGitHubJITCredentialIssuer(config)`

Create a `JITCredentialIssuer` backed by GitHub repository secrets.

```typescript
function createGitHubJITCredentialIssuer(config: GitHubJITConfig): JITCredentialIssuer;
```

### `createDockerSandbox(config)`

Create a `Sandbox` backed by Docker containers.

```typescript
function createDockerSandbox(config: DockerSandboxConfig): Sandbox;
```

### `createEnvSecretStore()`

Create a `SecretStore` backed by environment variables. Secret names are converted from kebab-case to `UPPER_SNAKE_CASE`.

## Stubs (Testing)

| Factory | Returns |
|---|---|
| `createStubSandbox()` | In-memory `Sandbox` |
| `createStubJITCredentialIssuer()` | In-memory `JITCredentialIssuer` |
| `createStubKillSwitch()` | In-memory `KillSwitch` |
| `createStubApprovalWorkflow()` | In-memory `ApprovalWorkflow` |

```typescript
import { createStubKillSwitch } from '@ai-sdlc/reference';

const ks = createStubKillSwitch();
console.log(await ks.isActive()); // false
await ks.activate('Security incident detected');
console.log(await ks.isActive()); // true
console.log(await ks.getReason()); // 'Security incident detected'
await ks.deactivate();
```
