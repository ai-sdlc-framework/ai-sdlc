/**
 * Public surface of the session-hierarchy bootstrap.
 */

export {
  generateBrief,
  isTrustSensitivePath,
  planBrief,
  renderBrief,
  selectTasks,
  type BriefOptions,
  type BriefPlan,
  type BriefResult,
  type BriefSelection,
  type BriefTask,
  type SequenceGroup,
} from './brief.js';
export {
  BRIEF_BLOCK_KEY,
  parseBrief,
  renderBriefBlock,
  type BriefEntry,
  type ParsedBrief,
} from './brief-format.js';
export {
  briefMessage,
  createTmuxBriefSender,
  notifyDispatch,
  type BriefSender,
} from './brief-notify.js';
export { hierarchyDown, type DownOutcome, type DownResult } from './down.js';
export { listInflight, type InflightItem } from './inflight.js';
export {
  checkCrossSessionInbound,
  evaluateResourceGate,
  MIN_AVAILABLE_BYTES,
  parseMemInfo,
  parseVmStat,
  readSettingsView,
  REQUIRED_INBOUND_VALUE,
  SKIP_RESOURCE_GATE_ENV,
  systemResourceSnapshot,
  type InboundCheck,
  type SettingsView,
} from './preflight.js';
export { findStartedSession, readSessionRegistry } from './registry.js';
export {
  emptyRoster,
  readRoster,
  readRosterChecked,
  ROSTER_FILENAME,
  rosterPath,
  unsafeEntryReason,
  writeRoster,
} from './roster.js';
export {
  formatStatus,
  hierarchyStatus,
  type LiveState,
  type StatusResult,
  type StatusRow,
} from './status.js';
export { attachTmuxSession, createSystemRunner } from './system-runner.js';
export {
  HIERARCHY_TMUX_SESSION,
  type CommandResult,
  type CommandRunner,
  type HierarchyDeps,
  type HierarchyRole,
  type RegistrySession,
  type ResourceSnapshot,
  type Roster,
  type RosterEntry,
  type RosterStatus,
} from './types.js';
export {
  buildClaudeCommand,
  FALLBACK_PLANNER_MODE,
  hierarchyUp,
  type UpOptions,
  type UpResult,
} from './up.js';
export {
  executorNames,
  GREEK_LETTERS,
  isValidSessionName,
  isValidTaskId,
  MAX_EXECUTORS,
  parseExecutorCount,
  roleOfDefaultName,
  shellQuote,
} from './validate.js';
