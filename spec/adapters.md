# AI-SDLC Adapter Layer Specification

<!-- Source: PRD Section 9 -->

**Document type:** Normative
**Status:** Draft
**Spec version:** v1alpha1

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Interface Contracts](#2-interface-contracts)
3. [Adapter Registration](#3-adapter-registration)
4. [Adapter Discovery](#4-adapter-discovery)
5. [Configuration and Secret Handling](#5-configuration-and-secret-handling)
6. [Custom Distribution Builder](#6-custom-distribution-builder)

---

## 1. Introduction

The adapter layer provides tool-agnostic integration by defining typed [interface contracts](glossary.md#interface-contract) for each integration category. Following Terraform's provider model, each [adapter](glossary.md#adapter) is a standalone module implementing one or more interfaces. Swapping one tool for another (e.g., Linear for Jira, GitHub for GitLab) requires changing only the `type` field in the [AdapterBinding](spec.md#55-adapterbinding) resource — pipeline definitions remain unchanged.

---

## 2. Interface Contracts

Every adapter MUST implement at least one of the following interface contracts. Each contract defines the methods an adapter MUST provide.

### 2.1 IssueTracker

Adapters for issue and project management tools (e.g., Linear, Jira, GitHub Issues).

```
listIssues(filter: IssueFilter): Issue[]
getIssue(id: string): Issue
createIssue(input: CreateIssueInput): Issue
updateIssue(id: string, input: UpdateIssueInput): Issue
transitionIssue(id: string, transition: string): Issue
watchIssues(filter: IssueFilter): EventStream<IssueEvent>
```

**IssueFilter:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `status` | string | MAY | Filter by issue status. |
| `labels` | array[string] | MAY | Filter by labels. |
| `assignee` | string | MAY | Filter by assignee. |
| `project` | string | MAY | Filter by project or team. |

**Issue:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | MUST | Unique identifier. |
| `title` | string | MUST | Issue title. |
| `description` | string | MAY | Issue description (Markdown). |
| `status` | string | MUST | Current status. |
| `labels` | array[string] | MAY | Applied labels. |
| `assignee` | string | MAY | Assigned user. |
| `url` | string (URI) | MUST | URL to the issue in the source tool. |

### 2.2 SourceControl

Adapters for source code management platforms (e.g., GitHub, GitLab, Bitbucket).

```
createBranch(input: CreateBranchInput): Branch
createPR(input: CreatePRInput): PullRequest
mergePR(id: string, strategy: MergeStrategy): MergeResult
getFileContents(path: string, ref: string): FileContent
listChangedFiles(prId: string): ChangedFile[]
setCommitStatus(sha: string, status: CommitStatus): void
watchPREvents(filter: PRFilter): EventStream<PREvent>
```

**MergeStrategy:** One of `merge`, `squash`, `rebase`.

**PullRequest:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | MUST | Unique identifier. |
| `title` | string | MUST | PR title. |
| `description` | string | MAY | PR description (Markdown). |
| `sourceBranch` | string | MUST | Source branch name. |
| `targetBranch` | string | MUST | Target branch name. |
| `status` | string | MUST | Current status (open, merged, closed). |
| `author` | string | MUST | PR author. |
| `url` | string (URI) | MUST | URL to the PR in the source tool. |

**CommitStatus:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `state` | string | MUST | One of: `pending`, `success`, `failure`, `error`. |
| `context` | string | MUST | Status check name. |
| `description` | string | MAY | Human-readable description. |
| `targetUrl` | string (URI) | MAY | URL for details. |

### 2.3 CIPipeline

Adapters for continuous integration systems (e.g., GitHub Actions, GitLab CI, Jenkins).

```
triggerBuild(input: TriggerBuildInput): Build
getBuildStatus(id: string): BuildStatus
getTestResults(buildId: string): TestResults
getCoverageReport(buildId: string): CoverageReport
watchBuildEvents(filter: BuildFilter): EventStream<BuildEvent>
```

**TestResults:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `passed` | integer | MUST | Number of passed tests. |
| `failed` | integer | MUST | Number of failed tests. |
| `skipped` | integer | MUST | Number of skipped tests. |
| `duration` | number | MAY | Total duration in seconds. |

**CoverageReport:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `lineCoverage` | number | MUST | Line coverage percentage (0-100). |
| `branchCoverage` | number | MAY | Branch coverage percentage (0-100). |
| `functionCoverage` | number | MAY | Function coverage percentage (0-100). |

### 2.4 CodeAnalysis

Adapters for static analysis and security scanning tools (e.g., SonarQube, Semgrep, CodeQL).

```
runScan(input: ScanInput): ScanResult
getFindings(scanId: string): Finding[]
getSeveritySummary(scanId: string): SeveritySummary
```

**Finding:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | MUST | Unique identifier. |
| `severity` | string | MUST | One of: `low`, `medium`, `high`, `critical`. |
| `message` | string | MUST | Finding description. |
| `file` | string | MUST | Affected file path. |
| `line` | integer | MAY | Affected line number. |
| `rule` | string | MUST | Rule identifier. |

**SeveritySummary:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `critical` | integer | MUST | Count of critical findings. |
| `high` | integer | MUST | Count of high findings. |
| `medium` | integer | MUST | Count of medium findings. |
| `low` | integer | MUST | Count of low findings. |

### 2.5 Messenger

Adapters for communication platforms (e.g., Slack, Microsoft Teams).

```
sendNotification(input: NotificationInput): void
createThread(input: ThreadInput): Thread
postUpdate(threadId: string, message: string): void
```

**NotificationInput:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `channel` | string | MUST | Target channel or recipient. |
| `message` | string | MUST | Notification message (Markdown). |
| `severity` | string | MAY | Message severity for formatting: `info`, `warning`, `error`. |

### 2.6 DeploymentTarget

Adapters for deployment platforms (e.g., Kubernetes, AWS, Vercel).

```
deploy(input: DeployInput): Deployment
getDeploymentStatus(id: string): DeploymentStatus
rollback(id: string): Deployment
watchDeploymentEvents(filter: DeployFilter): EventStream<DeployEvent>
```

**DeploymentStatus:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | MUST | Deployment identifier. |
| `status` | string | MUST | One of: `pending`, `in-progress`, `succeeded`, `failed`, `rolled-back`. |
| `environment` | string | MUST | Target environment name. |
| `timestamp` | string (date-time) | MUST | Deployment timestamp. |

---

## 3. Adapter Registration

<!-- Source: PRD Section 9.2 -->

Every adapter MUST include a `metadata.yaml` file at its root. This file declares the adapter's identity, capabilities, and compatibility.

```yaml
name: linear
displayName: "Linear Issue Tracker"
description: "Adapter for Linear project management"
version: "1.2.0"
stability: beta
interfaces:
  - IssueTracker@v1
owner: "@reliable-genius/adapters-team"
repository: "https://github.com/ai-sdlc-framework/adapter-linear"
specVersions: ["v1alpha1"]
dependencies:
  runtime: ">=0.1.0"
```

**Required metadata fields:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | MUST | Adapter identifier. MUST match `^[a-z][a-z0-9-]*$`. |
| `displayName` | string | MUST | Human-readable name. |
| `description` | string | MUST | Brief description. |
| `version` | string | MUST | Adapter version (SemVer). |
| `stability` | string | MUST | One of: `alpha`, `beta`, `stable`, `deprecated`. |
| `interfaces` | array[string] | MUST | Interface contracts implemented, with version (e.g., `IssueTracker@v1`). |
| `owner` | string | MUST | Maintainer identity. |
| `repository` | string (URI) | SHOULD | Source repository URL. |
| `specVersions` | array[string] | MUST | Supported AI-SDLC spec versions. |
| `dependencies` | object | MAY | Runtime or other dependency requirements. |

---

## 4. Adapter Discovery

<!-- Source: PRD Section 9.3 -->

Adapters MUST be discoverable from one of three sources:

### 4.1 Registry

The primary discovery mechanism. Adapters are published to a registry and referenced by name and version:

```
registry.ai-sdlc.io/adapters/<name>@<version>
```

Implementations MUST resolve registry references to their metadata and download the adapter.

### 4.2 Local Directory

For development and testing, adapters MAY be loaded from a local directory:

```
./adapters/<name>/
```

The directory MUST contain a valid `metadata.yaml` file.

### 4.3 Git Reference

Adapters MAY be referenced by git repository and version tag:

```
github.com/org/adapter-name@version
```

Implementations SHOULD cache git-referenced adapters locally after initial resolution.

---

## 5. Configuration and Secret Handling

Adapter configuration is declared in the [AdapterBinding](spec.md#55-adapterbinding) resource's `spec.config` field. This field is an open object (`additionalProperties: true`) to accommodate adapter-specific configuration.

### 5.1 Secret References

Sensitive configuration values (API keys, tokens) MUST NOT be embedded directly in resource definitions. Instead, they MUST use the [secret reference](glossary.md#secret-reference) pattern:

```yaml
config:
  apiKey:
    secretRef: linear-api-key
  teamId: "ENG"
```

Implementations MUST resolve `secretRef` values at runtime from a configured secret store. The secret resolution mechanism is implementation-defined but MUST support at least environment variables.

### 5.2 Configuration Validation

Adapters SHOULD provide a JSON Schema for their `config` object. When provided, implementations SHOULD validate adapter configuration against this schema during resource admission.

---

## 6. Custom Distribution Builder

<!-- Source: PRD Section 9.4 -->

Following OpenTelemetry's Collector Builder pattern, implementations MAY provide a builder tool that assembles custom distributions from a manifest declaring the desired set of adapters.

```yaml
# builder-manifest.yaml
spec_version: v1alpha1
adapters:
  - name: linear
    version: "1.2.0"
  - name: github
    version: "2.0.0"
  - name: semgrep
    version: "1.0.0"
  - name: slack
    version: "1.1.0"
output:
  name: my-ai-sdlc
  version: "1.0.0"
```

The builder manifest MUST declare:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `spec_version` | string | MUST | The AI-SDLC spec version. |
| `adapters` | array[AdapterRef] | MUST | List of adapters to include. |
| `output` | OutputConfig | MUST | Output distribution configuration. |

This enables organizations to build minimal, auditable distributions containing only the adapters they need.
