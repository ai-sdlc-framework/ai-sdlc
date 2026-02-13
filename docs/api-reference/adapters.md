# Adapters

Interface contracts for external tool integrations, built-in adapters (GitHub, Linear), community stubs, adapter registry, scanner, webhook bridge, and git-based resolution.

## Import

```typescript
import {
  // Interface types
  type IssueTracker,
  type SourceControl,
  type CIPipeline,
  type CodeAnalysis,
  type Messenger,
  type DeploymentTarget,
  type EventBus,
  type AdapterInterfaces,
  type EventStream,
  type Issue,
  type IssueFilter,
  type PullRequest,
  type CommitStatus,
  type TestResults,
  type CoverageReport,
  type Finding,
  type SeveritySummary,
  type DeploymentStatus,

  // Built-in adapters
  createGitHubSourceControl,
  createGitHubCIPipeline,
  createGitHubIssueTracker,
  createLinearIssueTracker,

  // Registry
  createAdapterRegistry,
  validateAdapterMetadata,
  type AdapterRegistry,
  type AdapterMetadata,
  type AdapterFactory,

  // Scanner
  parseMetadataYaml,
  scanLocalAdapters,

  // Stubs
  createStubCodeAnalysis,
  createStubMessenger,
  createStubDeploymentTarget,
  createStubGitLabCI,
  createStubGitLabSource,
  createStubJira,
  createStubBitbucket,
  createStubSonarQube,
  createStubSemgrep,

  // Webhook bridge
  createWebhookBridge,
  type WebhookBridge,

  // Git resolver
  resolveGitAdapter,
  parseGitAdapterRef,

  // EventBus
  createInProcessEventBus,

  // Secret resolution
  resolveSecret,
} from '@ai-sdlc/reference';
```

## Interface Contracts

Six core adapter interfaces define the contracts that adapters MUST implement:

### `IssueTracker`

```typescript
interface IssueTracker {
  listIssues(filter: IssueFilter): Promise<Issue[]>;
  getIssue(id: string): Promise<Issue>;
  createIssue(input: CreateIssueInput): Promise<Issue>;
  updateIssue(id: string, input: UpdateIssueInput): Promise<Issue>;
  transitionIssue(id: string, transition: string): Promise<Issue>;
  addComment(id: string, body: string): Promise<void>;
  getComments(id: string): Promise<IssueComment[]>;
  watchIssues(filter: IssueFilter): EventStream<IssueEvent>;
}
```

### `SourceControl`

```typescript
interface SourceControl {
  createBranch(input: CreateBranchInput): Promise<Branch>;
  createPR(input: CreatePRInput): Promise<PullRequest>;
  mergePR(id: string, strategy: MergeStrategy): Promise<MergeResult>;
  getFileContents(path: string, ref: string): Promise<FileContent>;
  listChangedFiles(prId: string): Promise<ChangedFile[]>;
  setCommitStatus(sha: string, status: CommitStatus): Promise<void>;
  watchPREvents(filter: PRFilter): EventStream<PREvent>;
}
```

### `CIPipeline`

```typescript
interface CIPipeline {
  triggerBuild(input: TriggerBuildInput): Promise<Build>;
  getBuildStatus(id: string): Promise<BuildStatus>;
  getTestResults(buildId: string): Promise<TestResults>;
  getCoverageReport(buildId: string): Promise<CoverageReport>;
  watchBuildEvents(filter: BuildFilter): EventStream<BuildEvent>;
}
```

### `CodeAnalysis`

```typescript
interface CodeAnalysis {
  runScan(input: ScanInput): Promise<ScanResult>;
  getFindings(scanId: string): Promise<Finding[]>;
  getSeveritySummary(scanId: string): Promise<SeveritySummary>;
}
```

### `Messenger`

```typescript
interface Messenger {
  sendNotification(input: NotificationInput): Promise<void>;
  createThread(input: ThreadInput): Promise<Thread>;
  postUpdate(threadId: string, message: string): Promise<void>;
}
```

### `DeploymentTarget`

```typescript
interface DeploymentTarget {
  deploy(input: DeployInput): Promise<Deployment>;
  getDeploymentStatus(id: string): Promise<DeploymentStatus>;
  rollback(id: string): Promise<Deployment>;
  watchDeploymentEvents(filter: DeployFilter): EventStream<DeployEvent>;
}
```

### `EventBus`

```typescript
interface EventBus {
  publish(topic: string, payload: unknown): Promise<void>;
  subscribe(topic: string, handler: (payload: unknown) => void): () => void;
}
```

## Built-in Adapters

### `createGitHubSourceControl(octokit, owner, repo)`

Create a `SourceControl` adapter backed by the GitHub REST API via Octokit.

### `createGitHubCIPipeline(octokit, owner, repo)`

Create a `CIPipeline` adapter backed by GitHub Actions.

### `createGitHubIssueTracker(octokit, owner, repo)`

Create an `IssueTracker` adapter backed by GitHub Issues.

### `createLinearIssueTracker(client, teamId)`

Create an `IssueTracker` adapter backed by the Linear API.

```typescript
import { createLinearIssueTracker } from '@ai-sdlc/reference';

const tracker = createLinearIssueTracker(linearClient, 'ENG');
const issues = await tracker.listIssues({ status: 'In Progress' });
```

## Adapter Registry

### `createAdapterRegistry()`

Create a registry for managing adapter factories.

```typescript
function createAdapterRegistry(): AdapterRegistry;
```

```typescript
interface AdapterRegistry {
  register(metadata: AdapterMetadata, factory: AdapterFactory): void;
  get(interfaceType: string, adapterType: string): AdapterFactory | undefined;
  list(interfaceType?: string): readonly AdapterMetadata[];
  has(interfaceType: string, adapterType: string): boolean;
}
```

```typescript
const registry = createAdapterRegistry();
registry.register(
  {
    name: 'jira',
    interface: 'IssueTracker',
    type: 'jira',
    version: '1.0.0',
    stability: 'stable',
    description: 'Jira Cloud issue tracker adapter',
  },
  (config) => createJiraTracker(config),
);
```

### `validateAdapterMetadata(metadata)`

Validate an adapter metadata object, checking required fields and format.

## Scanner

### `scanLocalAdapters(dir, options?)`

Scan a local directory for adapter packages containing `adapter.yaml` metadata files.

### `parseMetadataYaml(yaml)`

Parse a YAML string into an `AdapterMetadata` object.

## Webhook Bridge

### `createWebhookBridge()`

Create an EventEmitter-based bridge for converting webhook payloads into typed adapter events.

```typescript
function createWebhookBridge(): WebhookBridge;
```

```typescript
interface WebhookBridge {
  on(event: string, handler: (payload: unknown) => void): void;
  emit(event: string, payload: unknown): void;
  transform(event: string, transformer: WebhookTransformer): void;
}
```

## Stubs

Test stubs for all adapter interfaces:

| Factory | Interface |
|---|---|
| `createStubCodeAnalysis(config?)` | `CodeAnalysis` |
| `createStubMessenger()` | `Messenger` |
| `createStubDeploymentTarget()` | `DeploymentTarget` |
| `createStubGitLabCI()` | `CIPipeline` |
| `createStubGitLabSource()` | `SourceControl` |
| `createStubJira()` | `IssueTracker` |
| `createStubBitbucket()` | `SourceControl` |
| `createStubSonarQube(config?)` | `CodeAnalysis` |
| `createStubSemgrep(config?)` | `CodeAnalysis` |

## Git Resolver

### `resolveGitAdapter(ref, fetcher?)`

Resolve an adapter from a git reference (e.g., `github:org/repo@v1.0.0/path/to/adapter`).

### `parseGitAdapterRef(ref)`

Parse a git adapter reference string into its components.

### `createInProcessEventBus()`

Create an in-process `EventBus` implementation using Node.js EventEmitter.

```typescript
const bus = createInProcessEventBus();
const unsub = bus.subscribe('issue.created', (payload) => {
  console.log('New issue:', payload);
});
await bus.publish('issue.created', { id: 'ISS-1', title: 'Bug fix' });
unsub(); // unsubscribe
```

## Secret Resolution

### `resolveSecret(name)`

Resolve a `secretRef` name to its value from environment variables. Converts kebab-case to `UPPER_SNAKE_CASE`:

```
jira-api-token → JIRA_API_TOKEN
```
