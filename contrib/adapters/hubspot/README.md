# HubSpot Adapter

CrmProvider adapter for HubSpot.

## Status

**Planned** — Contributions welcome.

## Interface

Implements [`CrmProvider`](../../../spec/adapters.md#21-crmprovider).

## Configuration

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AdapterBinding
metadata:
  name: hubspot-crm
spec:
  interface: CrmProvider
  type: hubspot
  version: "0.1.0"
  config:
    portalId: "your-portal-id"
    apiKey:
      secretRef: hubspot-api-key
```

## License

Apache-2.0
