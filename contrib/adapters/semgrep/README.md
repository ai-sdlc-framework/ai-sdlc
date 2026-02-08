# Semgrep Adapter

CodeAnalysis adapter for Semgrep.

## Status

**Planned** — Contributions welcome.

## Interface

Implements [`CodeAnalysis`](../../../spec/adapters.md#24-codeanalysis).

## Configuration

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AdapterBinding
metadata:
  name: semgrep-analysis
spec:
  interface: CodeAnalysis
  type: semgrep
  version: "0.1.0"
  config:
    rulesets:
      - owasp-top-10
      - typescript
    token:
      secretRef: semgrep-token
```

## License

Apache-2.0
