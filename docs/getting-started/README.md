# Getting Started

Get up and running with the AI-SDLC Framework.

## Prerequisites

- Node.js >= 20
- pnpm >= 9

## Install

```bash
git clone https://github.com/ai-sdlc-framework/ai-sdlc.git
cd ai-sdlc
pnpm install
```

## Validate Schemas

```bash
pnpm validate-schemas
```

## Your First Pipeline

Create a `pipeline.yaml`:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: my-first-pipeline
spec:
  triggers:
    - event: issue.assigned
  providers:
    issueTracker:
      type: linear
  stages:
    - name: implement
      agent: code-agent
    - name: review
      agent: reviewer-agent
```

Validate it:

```typescript
import { validate } from '@ai-sdlc/reference';
import { readFileSync } from 'fs';
import { parse } from 'yaml';

const doc = parse(readFileSync('pipeline.yaml', 'utf-8'));
const result = validate('Pipeline', doc);
console.log(result.valid); // true
```

## Next Steps

- Read the [Primer](../spec/primer.md) for concepts and architecture
- Explore [Examples](../examples/) for complete configurations
- See the [Specification](../spec/spec.md) for normative requirements
