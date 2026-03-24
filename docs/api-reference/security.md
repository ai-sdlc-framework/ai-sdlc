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

  // OpenShell sandbox
  createOpenShellSandbox,
  isOpenShellAvailable,
  buildSandboxExecPrefix,
  generateOpenShellPolicy,
  serializePolicy,
  type OpenShellSandboxConfig,
  type OpenShellPolicy,
  type ProviderCredential,

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

### `createOpenShellSandbox(exec, config)`

Create a `Sandbox` backed by [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) for kernel-level agent isolation using Landlock LSM, seccomp, and network policy enforcement.

```typescript
function createOpenShellSandbox(exec: ShellExec, config?: OpenShellSandboxConfig): Sandbox;
```

**Config options:**

| Field | Type | Description |
|---|---|---|
| `blockedPaths` | `string[]` | Paths the agent is blocked from accessing |
| `workDir` | `string` | Working directory to mount into the sandbox |
| `networkEndpoints` | `Record<string, ...>` | Named network endpoints to allow |
| `providers` | `string[]` | Pre-existing OpenShell providers to attach |
| `autoProviders` | `ProviderCredential[]` | Credentials to auto-create as providers |
| `binaryPath` | `string` | Path to `openshell` binary (default: `'openshell'`) |

**Example:**

```typescript
import { createOpenShellSandbox, isOpenShellAvailable } from '@ai-sdlc/reference';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = (cmd: string) => promisify(exec)(cmd).then(r => r.stdout);

if (await isOpenShellAvailable(execAsync)) {
  const sandbox = createOpenShellSandbox(execAsync, {
    workDir: '/home/runner/work/repo',
    blockedPaths: ['.github/workflows/**', '.ai-sdlc/**'],
    autoProviders: [
      { name: 'claude', type: 'claude' },
      { name: 'github', type: 'github' },
    ],
    networkEndpoints: {
      anthropic: [{ host: 'api.anthropic.com', port: 443, access: 'full' }],
      github: [{ host: 'api.github.com', port: 443, access: 'read-write' }],
    },
  });

  const id = await sandbox.isolate('task-42', {
    maxMemoryMb: 512,
    maxCpuPercent: 80,
    networkPolicy: 'egress-only',
    timeoutMs: 1_800_000,
    allowedPaths: ['/home/runner/work/repo'],
  });

  // Agent runs inside sandbox via: openshell sandbox connect <id> -- claude ...
  // ...

  await sandbox.destroy(id); // downloads results, deletes sandbox, purges credentials
}
```

### `generateOpenShellPolicy(options)`

Generate an OpenShell policy YAML structure from AI-SDLC configuration.

```typescript
function generateOpenShellPolicy(options: PolicyGenerationOptions): OpenShellPolicy;
```

Maps `SandboxConstraints`, `blockedPaths`, and `networkEndpoints` to OpenShell policy format. The `autonomyLevel` parameter controls policy strictness:

| Level | Landlock | Network |
|---|---|---|
| 0 (Observer) | `hard_requirement` | No network (deny all) |
| 1 (Junior) | `best_effort` | Configured endpoints only |
| 2+ | `best_effort` | Full configured network |

### `serializePolicy(policy)`

Serialize an `OpenShellPolicy` object to YAML string.

### `isOpenShellAvailable(exec)`

Check if the `openshell` CLI is available on the system.

### `buildSandboxExecPrefix(sandboxName, binaryPath?)`

Build the command prefix array for executing a command inside an OpenShell sandbox. Used by runners to spawn agents within isolated environments.

```typescript
const prefix = buildSandboxExecPrefix('my-sandbox');
// ['openshell', 'sandbox', 'connect', 'my-sandbox', '--']
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
