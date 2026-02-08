# GitLab Adapter

SourceControl and CIPipeline adapter for GitLab.

## Status

**Planned** — Contributions welcome.

## Interfaces

Implements:
- [`SourceControl`](../../../spec/adapters.md#22-sourcecontrol)
- [`CIPipeline`](../../../spec/adapters.md#23-cipipeline)

## Configuration

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AdapterBinding
metadata:
  name: gitlab-source
spec:
  interface: SourceControl
  type: gitlab
  version: "0.1.0"
  config:
    baseUrl: "https://gitlab.com"
    token:
      secretRef: gitlab-token
    projectId: "12345"
```

## License

Apache-2.0
