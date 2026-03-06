export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        'reference',
        'conformance',
        'sdk',
        'sdk-typescript',
        'orchestrator',
        'mcp-advisor',
        'sdk-python',
        'sdk-go',
        'dashboard',
        'dogfood',
        'deps',
        'ci',
        'spec',
        'docs',
      ],
    ],
    'scope-empty': [0], // allow unscoped commits
    'body-max-line-length': [0], // disable — long URLs are common
    'footer-max-line-length': [0], // disable — long URLs are common
  },
};
