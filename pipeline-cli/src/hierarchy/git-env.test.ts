import { describe, expect, it } from 'vitest';

import { stripGitRedirects } from './git-env.js';

describe('stripGitRedirects', () => {
  it('removes every variable that redirects git and keeps the rest', () => {
    const input = {
      PATH: '/usr/bin',
      HOME: '/home/x',
      GIT_DIR: '/e/.git',
      GIT_WORK_TREE: '/e',
      GIT_INDEX_FILE: '/e/index',
      GIT_COMMON_DIR: '/e/.git',
      GIT_OBJECT_DIRECTORY: '/e/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/e/alt',
      GIT_CEILING_DIRECTORIES: '/e',
      GIT_DISCOVERY_ACROSS_FILESYSTEM: '1',
      GIT_CONFIG: '/evil',
      GIT_CONFIG_GLOBAL: '/evil',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/evil/hooks',
      GIT_CONFIG_PARAMETERS: "'core.fsmonitor=/evil'",
      GIT_SSH_COMMAND: 'ssh -i /keys/deploy',
    };
    expect(stripGitRedirects(input)).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/x',
      GIT_SSH_COMMAND: 'ssh -i /keys/deploy',
    });
  });

  it('matches names case-insensitively and does not change its input', () => {
    const input = { git_dir: '/x', Git_Common_Dir: '/y', Git_Config_Count: '2', KEEP: 'z' };
    expect(stripGitRedirects(input)).toEqual({ KEEP: 'z' });
    expect(input.git_dir).toBe('/x');
  });
});
