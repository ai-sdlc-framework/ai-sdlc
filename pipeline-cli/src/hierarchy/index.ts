/**
 * Public surface of the session-hierarchy bootstrap.
 */

export { attachEntry, hierarchyAttach, insideTmux } from './attach.js';
export {
  buildVscodeTasks,
  hierarchyTerminals,
  OPEN_ALL_LABEL,
  type TerminalsOptions,
  type TerminalsResult,
} from './terminals.js';
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
  GROUP_PATTERN,
  MAX_BRIEF_BYTES,
  MAX_BRIEF_ENTRIES,
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
export {
  clearExecutor,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_SETTLE_MS,
  HIERARCHY_CLEAR_CAPABILITY,
  type ClearDeps,
  type ClearOptions,
  type ClearResult,
} from './clear.js';
export {
  briefToEnqueueEntries,
  DEFAULT_REPORT_EVERY_MS,
  LOOP_STATE_FILENAME,
  readLoopState,
  runDispatchTick,
  type ClearReport,
  type LoopDeps,
  type LoopState,
  type PlannerReport,
  type TickResult,
  type VerdictReport,
} from './dispatch-loop.js';
export { hierarchyDown, type DownOutcome, type DownResult } from './down.js';
export {
  checkDispatchCaller,
  defaultInstallDir,
  defaultInstallGit,
  type DispatchCallerInputs,
  type GitProbe,
  type InstallGit,
} from './dispatch-caller.js';
export { stripGitRedirects } from './git-env.js';
export { createStreamEmitter, type EventEmitter, type HierarchyEvent } from './emit.js';
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
export {
  DEFAULT_PROTECTED_BRANCHES,
  checkOwnWorktree,
  checkOwnWorktreeForOperator,
  checkOwnWorktreeStrict,
  isProtectedBranch,
  type ForcePushMode,
} from './lease-policy.js';
export {
  loadOperational,
  loadOperationalPolicy,
  OPERATIONAL_ACTIONS,
  parseOperational,
  parseOperationalPolicy,
  type OperationalAction,
  type OperationalPolicy,
} from './operational.js';
export {
  createSystemIdentity,
  isClaudeCommand,
  requireDispatchCaller,
  resolveCaller,
  CALLER_NEXT_STEP,
  SAFE_SESSION_NAME,
  type CallerCheck,
  type CallerIdentity,
  type CallerSession,
  type IdentityDeps,
} from './caller-identity.js';
export {
  classifyFailure,
  isOwnTaskBranch,
  isSafeTaskPush,
  MECHANICAL_SHAPES,
  REQUEUEABLE_CAUSES,
  REQUIRED_GRANTS,
  runPlaybook,
  STALE_MERGE_REF_CAUSE,
  type Classification,
  type PlaybookAction,
  type PlaybookDeps,
  type PlaybookOutcome,
} from './playbook.js';
export {
  checkDispatchSender,
  checkRepoMatch,
  NOT_MY_DISPATCH,
  SENDER_UNVERIFIED_WARNING,
  rosterProject,
  type RepoCheck,
  type SenderCheck,
  type SenderIdentity,
} from './peer-guard.js';
export { findStartedSession, readSessionRegistry } from './registry.js';
export { resolveCallerRole, type SessionRoleDeps } from './session-role.js';
export {
  mainCheckoutRoot,
  realpathLoose,
  resolveTrustedBoard,
  safeReal,
  trustedPolicyRoot,
  verifiedMainRoot,
  type GitRunner,
} from './trusted-root.js';
export {
  emptyRoster,
  isLegacyLayoutEntry,
  readRoster,
  defaultProjectForBoard,
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
export {
  attachTmuxSession,
  buildGitEnv,
  createGitRunner,
  createSystemRunner,
  DEFAULT_GIT_PUSH_TIMEOUT_MS,
  DEFAULT_GIT_TIMEOUT_MS,
  killProcessGroup,
  type GitRunnerOptions,
} from './system-runner.js';
export {
  HIERARCHY_TMUX_SESSION,
  type AsyncCommandRunner,
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
  findForeignSessions,
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
  PROJECT_SEPARATOR,
  qualifiedName,
  roleOfDefaultName,
  sanitizeProject,
  shellQuote,
  splitSessionName,
} from './validate.js';
