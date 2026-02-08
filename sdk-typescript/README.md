# @ai-sdlc/sdk

TypeScript SDK for building AI-SDLC Framework implementations.

## Status

**v0.1.0 — Early Development**

This package provides a convenience layer over the reference implementation for building tools, integrations, and custom implementations.

## Installation

```bash
pnpm add @ai-sdlc/sdk
```

## Usage

```typescript
import { validate, type Pipeline, API_VERSION } from '@ai-sdlc/sdk';

const pipeline = {
  apiVersion: API_VERSION,
  kind: 'Pipeline' as const,
  metadata: { name: 'my-pipeline' },
  spec: {
    triggers: [{ event: 'issue.assigned' }],
    providers: { issueTracker: { type: 'linear' } },
    stages: [{ name: 'implement' }],
  },
};

const result = validate('Pipeline', pipeline);
console.log(result.valid); // true
```

## License

Apache-2.0
