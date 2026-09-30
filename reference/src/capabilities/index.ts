export { CAPABILITY_OUTCOMES } from './types.js';
export type {
  CapabilityDefinition,
  CapabilityOutcome,
  CapabilityRecord,
  CapabilityStateFile,
  CapabilityStateRow,
  CapabilityStatus,
} from './types.js';
export {
  BUILT_IN_CAPABILITIES,
  getCapability,
  listCapabilities,
  registerCapability,
} from './registry.js';
export {
  deriveCapabilityStatus,
  readCapabilityState,
  reportCapabilityOutcome,
  type ReportCapabilityOptions,
} from './state.js';
