# PostHog Adapter

AnalyticsProvider adapter for PostHog.

## Status

**Planned** — Contributions welcome.

## Interface

Implements [`AnalyticsProvider`](../../../spec/adapters.md#21-analyticsprovider).

## Configuration

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AdapterBinding
metadata:
  name: posthog-analytics
spec:
  interface: AnalyticsProvider
  type: posthog
  version: "0.1.0"
  config:
    host: "https://app.posthog.com"
    projectApiKey:
      secretRef: posthog-api-key
```

## License

Apache-2.0
