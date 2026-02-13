/**
 * Orchestration patterns example — all five patterns with execution.
 *
 * Run: npx tsx docs/examples/orchestration-patterns.ts
 */

import {
  AgentRoleBuilder,
  sequential,
  parallel,
  hybrid,
  hierarchical,
  swarm,
  executeOrchestration,
  validateHandoff,
  createAuditLog,
  type AgentRole,
  type OrchestrationPlan,
} from '@ai-sdlc/reference';

// ── Build agent roles ─────────────────────────────────────────────────

const codeAgent = new AgentRoleBuilder('code-agent', 'Engineer', 'Implement features')
  .tools(['code-editor', 'terminal', 'test-runner'])
  .addHandoff({
    target: 'review-agent',
    trigger: 'implementation complete',
    contract: { requiredFields: ['prUrl', 'testResults'] },
  })
  .build();

const reviewAgent = new AgentRoleBuilder('review-agent', 'Reviewer', 'Review code quality')
  .tools(['code-editor', 'file-search'])
  .addHandoff({
    target: 'deploy-agent',
    trigger: 'review approved',
    contract: { requiredFields: ['prUrl', 'approved'] },
  })
  .build();

const deployAgent = new AgentRoleBuilder('deploy-agent', 'DevOps', 'Deploy changes')
  .tools(['terminal', 'deploy-cli'])
  .build();

const frontendAgent = new AgentRoleBuilder('frontend-agent', 'Frontend Dev', 'Build UI')
  .tools(['code-editor', 'browser'])
  .build();

const backendAgent = new AgentRoleBuilder('backend-agent', 'Backend Dev', 'Build API')
  .tools(['code-editor', 'terminal'])
  .build();

const supervisorAgent = new AgentRoleBuilder('supervisor', 'Tech Lead', 'Coordinate work')
  .tools(['planner'])
  .build();

// Helper to build agent map
function agentMap(...agents: AgentRole[]): Map<string, AgentRole> {
  return new Map(agents.map((a) => [a.metadata.name, a]));
}

// Mock task function
async function mockTask(agent: AgentRole, input?: unknown): Promise<unknown> {
  const name = agent.metadata.name;
  console.log(`    Executing ${name}${input ? ' (with input)' : ''}`);
  return { agent: name, status: 'completed', output: `${name} done` };
}

// ── 1. Sequential ─────────────────────────────────────────────────────

console.log('=== Sequential Pattern ===');
const seqPlan = sequential([codeAgent, reviewAgent, deployAgent]);
console.log('  Steps:', seqPlan.steps.map((s) => s.agent).join(' → '));

const seqResult = await executeOrchestration(
  seqPlan,
  agentMap(codeAgent, reviewAgent, deployAgent),
  mockTask,
);
console.log('  Success:', seqResult.success);

// ── 2. Parallel ───────────────────────────────────────────────────────

console.log('\n=== Parallel Pattern ===');
const parPlan = parallel([frontendAgent, backendAgent, codeAgent]);
console.log('  Steps:', parPlan.steps.map((s) => s.agent).join(' | '));

const parResult = await executeOrchestration(
  parPlan,
  agentMap(frontendAgent, backendAgent, codeAgent),
  mockTask,
);
console.log('  Success:', parResult.success);

// ── 3. Hybrid (Router) ───────────────────────────────────────────────

console.log('\n=== Hybrid (Router) Pattern ===');
const hybridPlan = hybrid(supervisorAgent, [frontendAgent, backendAgent]);
console.log(
  '  Dispatcher:',
  hybridPlan.steps[0].agent,
  '→ Workers:',
  hybridPlan.steps
    .slice(1)
    .map((s) => s.agent)
    .join(', '),
);

const hybridResult = await executeOrchestration(
  hybridPlan,
  agentMap(supervisorAgent, frontendAgent, backendAgent),
  mockTask,
);
console.log('  Success:', hybridResult.success);

// ── 4. Hierarchical ──────────────────────────────────────────────────

console.log('\n=== Hierarchical Pattern ===');
const hierPlan = hierarchical(supervisorAgent, [codeAgent, reviewAgent, deployAgent]);
console.log(
  '  Manager:',
  hierPlan.steps[0].agent,
  '→ Workers:',
  hierPlan.steps
    .slice(1)
    .map((s) => s.agent)
    .join(', '),
);

const hierResult = await executeOrchestration(
  hierPlan,
  agentMap(supervisorAgent, codeAgent, reviewAgent, deployAgent),
  mockTask,
);
console.log('  Success:', hierResult.success);

// ── 5. Swarm ──────────────────────────────────────────────────────────

console.log('\n=== Swarm Pattern ===');
const swarmPlan = swarm([codeAgent, reviewAgent, deployAgent]);
console.log('  Steps:');
for (const step of swarmPlan.steps) {
  const deps = step.dependsOn?.join(', ') ?? 'none';
  console.log(`    ${step.agent} (depends on: ${deps})`);
}

const swarmResult = await executeOrchestration(
  swarmPlan,
  agentMap(codeAgent, reviewAgent, deployAgent),
  mockTask,
);
console.log('  Success:', swarmResult.success);

// ── Handoff Validation ────────────────────────────────────────────────

console.log('\n=== Handoff Validation ===');

// Valid handoff
const validError = validateHandoff(codeAgent, reviewAgent, {
  prUrl: 'https://github.com/org/repo/pull/42',
  testResults: { passed: 100, failed: 0 },
});
console.log('Valid handoff:', validError === null ? 'OK' : validError.message);

// Invalid handoff — missing required field
const invalidError = validateHandoff(codeAgent, reviewAgent, {
  prUrl: 'https://github.com/org/repo/pull/42',
  // testResults missing!
});
console.log('Invalid handoff:', invalidError?.message);

// No handoff declaration
const noHandoff = validateHandoff(deployAgent, codeAgent, { data: 'test' });
console.log('No declaration:', noHandoff?.message);

// ── Execution with Audit Log ──────────────────────────────────────────

console.log('\n=== Execution with Audit Logging ===');
const auditLog = createAuditLog();

const auditedResult = await executeOrchestration(
  sequential([codeAgent, reviewAgent]),
  agentMap(codeAgent, reviewAgent),
  mockTask,
  { auditLog },
);

console.log('  Audit entries:', auditLog.entries().length);
for (const entry of auditLog.entries()) {
  console.log(`    ${entry.actor}: ${entry.action} → ${entry.decision}`);
}
