# Intercom Adapter

SupportChannel adapter for Intercom.

## Status

**Planned** — Contributions welcome.

## Interface

Implements [`SupportChannel`](../../../spec/adapters.md#21-supportchannel).

## Configuration

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AdapterBinding
metadata:
  name: intercom-support
spec:
  interface: SupportChannel
  type: intercom
  version: "0.1.0"
  config:
    appId: "your-app-id"
    apiToken:
      secretRef: intercom-api-token
```

## License

Apache-2.0
