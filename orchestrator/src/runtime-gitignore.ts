/**
 * The runtime .gitignore list and its text logic live in pipeline-cli so `cli-init`
 * and the orchestrator share one list (AISDLC-1407); this re-export keeps the
 * orchestrator's import path.
 */
export {
  ARTIFACTS_GITIGNORE_ENTRY,
  RUNTIME_GITIGNORE_PATHS,
  RUNTIME_GITIGNORE_SENTINEL,
  gitCheckIgnoreArgs,
  gitignoreCovers,
  hasSentinelLine,
  insertIntoSentinelBlock,
  interpretCheckIgnoreExit,
  missingRuntimeGitignorePaths,
  writeRuntimeGitignore,
} from '@ai-sdlc/pipeline-cli/config-manifest';
