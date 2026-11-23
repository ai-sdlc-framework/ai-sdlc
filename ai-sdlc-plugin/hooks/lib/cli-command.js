'use strict';
/**
 * AISDLC-1359: the command text a hook message suggests for a pipeline-cli bin.
 * Names the resolved path when one exists (`PIPELINE_CLI_BIN`, the plugin install,
 * the monorepo copy), else the bin file name and where it lives. Message text only:
 * no refusal depends on it.
 */
const { existsSync } = require('fs');
const { join } = require('path');

const PIPELINE_CLI_REL = join('node_modules', '@ai-sdlc', 'pipeline-cli', 'bin');

/** First existing path of `binName`, or undefined. */
function resolveCliBin(binName, env = process.env, pluginDir = join(__dirname, '..', '..')) {
  const candidates = [];
  if (env.PIPELINE_CLI_BIN) candidates.push(join(env.PIPELINE_CLI_BIN, binName));
  if (env.CLAUDE_PLUGIN_ROOT)
    candidates.push(join(env.CLAUDE_PLUGIN_ROOT, PIPELINE_CLI_REL, binName));
  candidates.push(join(pluginDir, PIPELINE_CLI_REL, binName));
  candidates.push(join(pluginDir, '..', 'pipeline-cli', 'bin', binName));
  return candidates.find((c) => existsSync(c));
}

/** `node <path>` when resolved, else `<binName> (in the pipeline-cli bin directory, $PIPELINE_CLI_BIN)`. */
function cliCommand(binName, env = process.env, pluginDir) {
  const found = resolveCliBin(binName, env, pluginDir);
  return found
    ? `node ${found}`
    : `${binName} (in the pipeline-cli bin directory, $PIPELINE_CLI_BIN)`;
}

module.exports = { resolveCliBin, cliCommand };
