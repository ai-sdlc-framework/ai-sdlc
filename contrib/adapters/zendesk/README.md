# Zendesk Adapter

SupportChannel adapter for Zendesk.

## Status

**Planned** — Contributions welcome.

## Interface

Implements [`SupportChannel`](../../../spec/adapters.md#21-supportchannel).

## Configuration

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AdapterBinding
metadata:
  name: zendesk-support
spec:
  interface: SupportChannel
  type: zendesk
  version: "0.1.0"
  config:
    baseUrl: "https://your-org.zendesk.com"
    apiToken:
      secretRef: zendesk-api-token
```

## License

Apache-2.0
