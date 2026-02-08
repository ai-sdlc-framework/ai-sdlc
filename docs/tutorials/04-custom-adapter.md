# Tutorial 4: Building a Custom Adapter

Adapters are the integration layer between AI-SDLC and external tools. The
[AdapterBinding](../../spec/spec.md#55-adapterbinding) resource declares a tool
integration as a swappable provider behind a uniform
[interface contract](../../spec/glossary.md#interface-contract). By coding to a
standard interface, you can swap one tool for another -- for example, replacing
Linear with Jira -- without touching your pipeline definitions.

This tutorial walks through building a custom Jira adapter that implements the
`IssueTracker` interface.

---

## Interface Types Overview

The AI-SDLC spec defines six interface contracts. Every adapter implements at
least one:

| Interface | Purpose | Example Tools |
| --- | --- | --- |
| `IssueTracker` | Issue and project management | Jira, Linear, GitHub Issues |
| `SourceControl` | Source code management | GitHub, GitLab, Bitbucket |
| `CIPipeline` | Continuous integration | GitHub Actions, GitLab CI, Jenkins |
| `CodeAnalysis` | Static analysis and security scanning | SonarQube, Semgrep, CodeQL |
| `Messenger` | Communication platforms | Slack, Microsoft Teams |
| `DeploymentTarget` | Deployment platforms | Kubernetes, AWS, Vercel |

See [spec/adapters.md](../../spec/adapters.md) for the full contract definitions.

---

## Prerequisites

- Node.js 18+ and npm/pnpm installed
- TypeScript knowledge (the reference implementation is TypeScript-based)
- A Jira Cloud instance and API token for testing
- Familiarity with the [Jira REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/)
- Completion of Tutorials 01-03 (recommended)

---

## Step 1: Define the AdapterBinding Resource

Create a file called `jira-adapter.yaml`. This declares your Jira integration
as an AI-SDLC resource:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AdapterBinding
metadata:
  name: jira-issue-tracker
  namespace: my-team
  labels:
    adapter: jira
    interface: issue-tracker
spec:
  interface: IssueTracker
  type: jira
  version: 1.0.0
  source: registry.ai-sdlc.io/adapters/jira@1.0.0
  config:
    projectKey: "ENG"
    baseUrl: "https://mycompany.atlassian.net"
    apiToken:
      secretRef: jira-api-token
  healthCheck:
    interval: 60s
    timeout: 10s
```

Key fields:

- **`spec.interface`** -- The abstract contract this adapter fulfills (`IssueTracker`).
- **`spec.type`** -- The concrete implementation identifier (`jira`).
- **`spec.version`** -- The adapter version following SemVer.
- **`spec.source`** -- Where to fetch the adapter from (registry, local path, or git reference).
- **`spec.config`** -- Adapter-specific configuration; note how `apiToken` uses a `secretRef` instead of a plaintext value.
- **`spec.healthCheck`** -- Defines how often the runtime checks adapter connectivity.

---

## Step 2: Implement the IssueTracker Interface

The `@ai-sdlc/reference` package exports typed interfaces for every contract.
Create `src/jira-adapter.ts`:

```typescript
import type {
  IssueTracker,
  Issue,
  IssueFilter,
  CreateIssueInput,
  UpdateIssueInput,
  EventStream,
  IssueEvent,
} from "@ai-sdlc/reference";

interface JiraConfig {
  projectKey: string;
  baseUrl: string;
  apiToken: string; // Already resolved from secretRef
}

export function createJiraIssueTracker(config: JiraConfig): IssueTracker {
  const headers = {
    Authorization: `Basic ${Buffer.from(`email:${config.apiToken}`).toString("base64")}`,
    "Content-Type": "application/json",
  };

  return {
    async listIssues(filter: IssueFilter): Promise<Issue[]> {
      // Build JQL from the generic IssueFilter
      const jqlParts: string[] = [`project = ${config.projectKey}`];
      if (filter.status) jqlParts.push(`status = "${filter.status}"`);
      if (filter.assignee) jqlParts.push(`assignee = "${filter.assignee}"`);
      if (filter.labels?.length) {
        jqlParts.push(`labels in (${filter.labels.join(",")})`);
      }

      const response = await fetch(
        `${config.baseUrl}/rest/api/3/search?jql=${encodeURIComponent(jqlParts.join(" AND "))}`,
        { headers }
      );
      const data = await response.json();

      // Map Jira issues to the AI-SDLC Issue type
      return data.issues.map(mapJiraIssue);
    },

    async getIssue(id: string): Promise<Issue> {
      const response = await fetch(
        `${config.baseUrl}/rest/api/3/issue/${id}`,
        { headers }
      );
      const data = await response.json();
      return mapJiraIssue(data);
    },

    async createIssue(input: CreateIssueInput): Promise<Issue> {
      const response = await fetch(
        `${config.baseUrl}/rest/api/3/issue`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            fields: {
              project: { key: config.projectKey },
              summary: input.title,
              description: input.description,
              issuetype: { name: "Task" },
              // Map additional fields as needed
            },
          }),
        }
      );
      const created = await response.json();
      return getIssue(created.id);
    },

    async updateIssue(id: string, input: UpdateIssueInput): Promise<Issue> {
      await fetch(`${config.baseUrl}/rest/api/3/issue/${id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          fields: {
            ...(input.title && { summary: input.title }),
            ...(input.description && { description: input.description }),
          },
        }),
      });
      return getIssue(id);
    },

    async transitionIssue(id: string, transition: string): Promise<Issue> {
      // First, look up the transition ID from the name
      const transitionsRes = await fetch(
        `${config.baseUrl}/rest/api/3/issue/${id}/transitions`,
        { headers }
      );
      const { transitions } = await transitionsRes.json();
      const match = transitions.find(
        (t: { name: string }) => t.name.toLowerCase() === transition.toLowerCase()
      );

      if (!match) {
        throw new Error(`Transition "${transition}" not found for issue ${id}`);
      }

      await fetch(`${config.baseUrl}/rest/api/3/issue/${id}/transitions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ transition: { id: match.id } }),
      });
      return getIssue(id);
    },

    watchIssues(_filter: IssueFilter): EventStream<IssueEvent> {
      // Jira uses webhooks; return a stream that bridges webhook events
      // Implementation depends on your webhook ingestion layer
      throw new Error("watchIssues requires webhook configuration");
    },
  };

  // --- Helper ---------------------------------------------------

  async function getIssue(id: string): Promise<Issue> {
    const response = await fetch(
      `${config.baseUrl}/rest/api/3/issue/${id}`,
      { headers }
    );
    return mapJiraIssue(await response.json());
  }
}

/** Map a Jira REST response to the AI-SDLC Issue type. */
function mapJiraIssue(jiraIssue: Record<string, any>): Issue {
  return {
    id: jiraIssue.key,
    title: jiraIssue.fields.summary,
    description: jiraIssue.fields.description ?? undefined,
    status: jiraIssue.fields.status.name,
    labels: jiraIssue.fields.labels ?? [],
    assignee: jiraIssue.fields.assignee?.displayName ?? undefined,
    url: `${jiraIssue.self.split("/rest")[0]}/browse/${jiraIssue.key}`,
  };
}
```

The factory function `createJiraIssueTracker` receives an already-resolved
config object (secrets have been substituted by the runtime). It returns an
object satisfying the `IssueTracker` contract. Every method maps between the
Jira-specific REST API and the tool-agnostic AI-SDLC types.

---

## Step 3: Secret Resolution with secretRef

Sensitive values like API tokens MUST NOT appear in plain text inside YAML
resources. The `secretRef` pattern defers resolution to runtime:

```yaml
config:
  apiToken:
    secretRef: jira-api-token
```

The reference implementation resolves `secretRef` values from environment
variables by converting the kebab-case name to `UPPER_SNAKE_CASE`:

```
jira-api-token  -->  JIRA_API_TOKEN
```

At runtime, the framework calls `resolveSecret("jira-api-token")`, which reads
`process.env.JIRA_API_TOKEN`. Your adapter receives the resolved string value
in its config object -- it never needs to handle secret resolution itself.

To set the secret locally:

```bash
export JIRA_API_TOKEN="your-jira-api-token-here"
```

For production, use your organization's secret management solution (Vault,
AWS Secrets Manager, etc.) and configure the runtime's secret store accordingly.

---

## Step 4: Health Checks

The `healthCheck` block in the AdapterBinding tells the runtime how to monitor
adapter connectivity:

```yaml
healthCheck:
  interval: 60s
  timeout: 10s
```

- **`interval`** -- How often to probe the adapter. The runtime calls a
  lightweight connectivity check at this cadence.
- **`timeout`** -- Maximum time to wait for a health check response before
  marking the adapter unhealthy.

Both values use the duration shorthand pattern `^\d+[smhdw]$` (seconds,
minutes, hours, days, weeks). Examples: `30s`, `5m`, `1h`.

The health check for an IssueTracker adapter typically verifies that:

1. The API endpoint is reachable.
2. The credentials are valid (e.g., call the Jira `/myself` endpoint).
3. The configured project exists and is accessible.

The runtime reports adapter health via the resource's `status` field:

```yaml
status:
  connected: true
  lastHealthCheck: "2025-06-15T10:30:00Z"
  adapterVersion: "1.0.0"
  specVersionSupported: "v1alpha1"
```

---

## Validation

Validate your AdapterBinding YAML against the schema to catch errors before
deployment:

```bash
npx ajv validate \
  -s spec/schemas/adapter-binding.schema.json \
  -r "spec/schemas/common.schema.json" \
  -d jira-adapter.yaml
```

A successful run prints no errors. Common validation failures include:

- Missing required fields (`interface`, `type`, `version`).
- Invalid `version` format (must be SemVer: `1.0.0`, not `v1.0.0`).
- Invalid `healthCheck` duration (must match `^\d+[smhdw]$`).
- Using an `interface` value not in the enum (must be one of the six defined interfaces).

---

## Summary

In this tutorial you:

1. Defined an **AdapterBinding** resource declaring a Jira IssueTracker integration.
2. Implemented the **IssueTracker interface** in TypeScript, mapping Jira REST API responses to AI-SDLC types.
3. Used the **secretRef** pattern to keep API tokens out of configuration files.
4. Configured **health checks** so the runtime can monitor adapter connectivity.
5. **Validated** the resource YAML against the JSON Schema.

---

## Next Steps

- **[Tutorial 05: Multi-Agent Orchestration](./05-multi-agent-orchestration.md)** -- Wire multiple agents together with handoff contracts and orchestration patterns.
- **[Adapter Layer Specification](../../spec/adapters.md)** -- Full reference for all six interface contracts, adapter registration, and the custom distribution builder.
