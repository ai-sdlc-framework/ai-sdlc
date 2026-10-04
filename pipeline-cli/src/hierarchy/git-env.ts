/**
 * The git environment variables that redirect git away from the repository in
 * its working directory, and the one helper that removes them.
 *
 * Every place that runs git on behalf of the hierarchy (the policy and identity
 * lookups in `trusted-root.ts`, the playbook runner in `system-runner.ts`) goes
 * through {@link stripGitRedirects}, so the two cannot drift apart.
 */

/** Variables that name a repository, work tree, index, object store or discovery limit. */
const GIT_REDIRECT_VARS = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
]);

/**
 * `base` without any variable that redirects git: the names above and every
 * `GIT_CONFIG*` setting, matched case-insensitively. Pure; the input is not changed.
 */
export function stripGitRedirects(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    const upper = key.toUpperCase();
    if (GIT_REDIRECT_VARS.has(upper) || upper.startsWith('GIT_CONFIG')) continue;
    env[key] = value;
  }
  return env;
}
