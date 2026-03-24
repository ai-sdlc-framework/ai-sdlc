# Salesforce Adapter

CrmProvider adapter for Salesforce.

## Status

**Planned** — Contributions welcome.

## Interface

Implements [`CrmProvider`](../../../spec/adapters.md#21-crmprovider).

## Configuration

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AdapterBinding
metadata:
  name: salesforce-crm
spec:
  interface: CrmProvider
  type: salesforce
  version: "0.1.0"
  config:
    instanceUrl: "https://your-org.my.salesforce.com"
    clientId: "your-client-id"
    clientSecret:
      secretRef: salesforce-client-secret
```

## License

Apache-2.0
