# SonarQube Adapter

CodeAnalysis adapter for SonarQube.

## Status

**Planned** — Contributions welcome.

## Interface

Implements [`CodeAnalysis`](../../../spec/adapters.md#24-codeanalysis).

## Configuration

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AdapterBinding
metadata:
  name: sonarqube-analysis
spec:
  interface: CodeAnalysis
  type: sonarqube
  version: "0.1.0"
  config:
    baseUrl: "https://sonarqube.example.com"
    token:
      secretRef: sonarqube-token
    projectKey: "my-project"
```

## License

Apache-2.0
