# Examples

Complete working examples demonstrating AI-SDLC configurations.

## Available Examples

| Example | Description |
| --- | --- |
| [complete-pipeline.yaml](complete-pipeline.yaml) | Full pipeline with all resource types configured together |

## Running Examples

Validate any example against the schemas:

```bash
pnpm --filter @ai-sdlc/reference validate-schemas
```

Or use the TypeScript API:

```typescript
import { validateResource } from '@ai-sdlc/reference';
import { parse } from 'yaml';
import { readFileSync } from 'fs';

const docs = parse(readFileSync('complete-pipeline.yaml', 'utf-8'));
// Validate each document in a multi-document YAML
```
