# Amplitude Adapter

AnalyticsProvider adapter for Amplitude.

## Status

**Planned** — Contributions welcome.

## Interface

Implements [`AnalyticsProvider`](../../../spec/adapters.md#21-analyticsprovider).

## Configuration

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AdapterBinding
metadata:
  name: amplitude-analytics
spec:
  interface: AnalyticsProvider
  type: amplitude
  version: "0.1.0"
  config:
    apiKey:
      secretRef: amplitude-api-key
```

## License

Apache-2.0
