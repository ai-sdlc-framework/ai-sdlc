export {
  createStubCodeAnalysis,
  type StubCodeAnalysisConfig,
  type StubCodeAnalysisAdapter,
} from './code-analysis.js';

export {
  createStubMessenger,
  type NotificationLogEntry,
  type StubMessengerAdapter,
} from './messenger.js';

export {
  createStubDeploymentTarget,
  type StubDeploymentTargetAdapter,
} from './deployment-target.js';

// Community adapter stubs
export {
  createStubGitLabCI,
  createStubGitLabSource,
  type StubGitLabCIAdapter,
  type StubGitLabSourceAdapter,
} from './gitlab.js';

export { createStubJira, type StubJiraAdapter } from './jira.js';

export { createStubBitbucket, type StubBitbucketAdapter } from './bitbucket.js';

export {
  createStubSonarQube,
  type StubSonarQubeConfig,
  type StubSonarQubeAdapter,
} from './sonarqube.js';

export { createStubSemgrep, type StubSemgrepConfig, type StubSemgrepAdapter } from './semgrep.js';
