# Compliance

Regulatory compliance mapping and coverage checking across six frameworks: EU AI Act, NIST AI RMF, ISO 42001, ISO 12207, OWASP ASI, and CSA AI Trust Framework.

## Import

```typescript
import {
  // Control mappings
  AI_SDLC_CONTROLS,
  EU_AI_ACT_MAPPINGS,
  NIST_AI_RMF_MAPPINGS,
  ISO_42001_MAPPINGS,
  ISO_12207_MAPPINGS,
  OWASP_ASI_MAPPINGS,
  CSA_ATF_MAPPINGS,
  REGULATORY_FRAMEWORKS,
  getMappingsForFramework,

  // Checker
  checkCompliance,
  checkAllFrameworks,
  getAllControlIds,
  type ComplianceCoverageReport,

  // Types
  type RegulatoryFramework,
  type ComplianceControl,
  type ControlMapping,
} from '@ai-sdlc/reference';
```

## Types

### `RegulatoryFramework`

One of the six supported frameworks:
- `'EU_AI_ACT'`
- `'NIST_AI_RMF'`
- `'ISO_42001'`
- `'ISO_12207'`
- `'OWASP_ASI'`
- `'CSA_ATF'`

### `ComplianceCoverageReport`

```typescript
interface ComplianceCoverageReport {
  framework: RegulatoryFramework;
  totalControls: number;
  coveredControls: number;
  gaps: ControlMapping[];
  coveragePercent: number;
}
```

## Functions

### `checkCompliance(enabledControls, framework)`

Check compliance coverage for a specific regulatory framework.

```typescript
function checkCompliance(
  enabledControls: ReadonlySet<string>,
  framework: RegulatoryFramework,
): ComplianceCoverageReport;
```

```typescript
import { checkCompliance, getAllControlIds } from '@ai-sdlc/reference';

// Check with all controls enabled
const allControls = getAllControlIds();
const report = checkCompliance(allControls, 'EU_AI_ACT');
console.log(`EU AI Act coverage: ${report.coveragePercent.toFixed(1)}%`);
console.log(`Gaps: ${report.gaps.length}`);

// Check with a subset of controls
const partial = new Set(['AISDLC-001', 'AISDLC-002', 'AISDLC-003']);
const partialReport = checkCompliance(partial, 'NIST_AI_RMF');
for (const gap of partialReport.gaps) {
  console.log(`Gap: ${gap.controlId} — ${gap.description}`);
}
```

### `checkAllFrameworks(enabledControls)`

Check compliance coverage across all six regulatory frameworks at once.

```typescript
function checkAllFrameworks(
  enabledControls: ReadonlySet<string>,
): ComplianceCoverageReport[];
```

```typescript
import { checkAllFrameworks, getAllControlIds } from '@ai-sdlc/reference';

const reports = checkAllFrameworks(getAllControlIds());
for (const report of reports) {
  console.log(`${report.framework}: ${report.coveragePercent.toFixed(1)}% (${report.gaps.length} gaps)`);
}
```

### `getAllControlIds()`

Get all available AI-SDLC control IDs. Useful for enabling full coverage.

```typescript
function getAllControlIds(): Set<string>;
```

### `getMappingsForFramework(framework)`

Get the control mappings for a specific framework.

## Constants

### `AI_SDLC_CONTROLS`

Array of all AI-SDLC compliance controls with their IDs, descriptions, and categories.

### `REGULATORY_FRAMEWORKS`

Array of all supported framework identifiers.

### Framework-Specific Mappings

| Constant | Framework |
|---|---|
| `EU_AI_ACT_MAPPINGS` | EU Artificial Intelligence Act |
| `NIST_AI_RMF_MAPPINGS` | NIST AI Risk Management Framework |
| `ISO_42001_MAPPINGS` | ISO/IEC 42001 AI Management Systems |
| `ISO_12207_MAPPINGS` | ISO/IEC 12207 Software Lifecycle |
| `OWASP_ASI_MAPPINGS` | OWASP AI Security Initiative |
| `CSA_ATF_MAPPINGS` | Cloud Security Alliance AI Trust Framework |
