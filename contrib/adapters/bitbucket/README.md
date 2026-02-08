# Bitbucket Adapter

SourceControl adapter for Atlassian Bitbucket.

## Status

**Planned** — Contributions welcome.

## Interface

Implements [`SourceControl`](../../../spec/adapters.md#22-sourcecontrol).

## Configuration

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AdapterBinding
metadata:
  name: bitbucket-source
spec:
  interface: SourceControl
  type: bitbucket
  version: "0.1.0"
  config:
    workspace: "your-workspace"
    appPassword:
      secretRef: bitbucket-app-password
```

## License

Apache-2.0
