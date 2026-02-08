# Jira Adapter

IssueTracker adapter for Atlassian Jira.

## Status

**Planned** — Contributions welcome.

## Interface

Implements [`IssueTracker`](../../../spec/adapters.md#21-issuetracker).

## Configuration

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AdapterBinding
metadata:
  name: jira-tracker
spec:
  interface: IssueTracker
  type: jira
  version: "0.1.0"
  config:
    baseUrl: "https://your-org.atlassian.net"
    apiToken:
      secretRef: jira-api-token
    projectKey: ENG
```

## License

Apache-2.0
