import { describe, it, expect } from 'vitest';
import { createStubUsabilitySimulationRunner } from './usability-simulation-runner.js';
import type { StoryEntry, TaskPrompt, UsabilityFinding } from '../interfaces.js';

const story: StoryEntry = {
  id: 'form--default',
  name: 'Form/Default',
  componentName: 'Form',
  kind: 'inputs',
};

const task: TaskPrompt = {
  id: 'form-submission',
  instruction: 'Fill out and submit the form',
  successCriteria: { type: 'form-submission', target: 'form' },
  expectedActions: 5,
  applicableTo: ['Form'],
};

const sampleFinding: UsabilityFinding = {
  severity: 'major',
  confidence: 0.85,
  category: 'discoverability',
  evidence: {
    taskAttempted: 'form-submission',
    personaProfile: 'low-tech-confidence',
    actionsTaken: 8,
    expectedActions: 5,
    failurePoint: 'submit button',
    failureScenario: 'User could not find the submit button below the fold',
  },
  message: 'Submit button not discoverable on mobile',
};

describe('createStubUsabilitySimulationRunner', () => {
  it('deploys a story and returns a browser session', async () => {
    const runner = createStubUsabilitySimulationRunner();
    const session = await runner.deployStory(story, { viewport: 375 });
    expect(session.sessionId).toBeDefined();
    expect(session.storyUrl).toContain(story.id);
    expect(session.isActive).toBe(true);
    expect(session.environment.viewport.width).toBe(375);
    expect(runner.getDeployedSessions()).toHaveLength(1);
  });

  it('session connector returns page state', async () => {
    const runner = createStubUsabilitySimulationRunner();
    const session = await runner.deployStory(story, { viewport: 1280 });
    const pageState = await session.connector.getPageState();
    expect(pageState.url).toContain(story.id);
    expect(pageState.elements.length).toBeGreaterThan(0);
  });

  it('session connector executes actions', async () => {
    const runner = createStubUsabilitySimulationRunner();
    const session = await runner.deployStory(story, { viewport: 1280 });
    const result = await session.connector.executeAction({
      type: 'click',
      target: 'button',
    });
    expect(result.success).toBe(true);
  });

  it('generates personas', async () => {
    const runner = createStubUsabilitySimulationRunner();
    const personas = await runner.generatePersonas({
      count: 3,
      demographics: { techConfidence: 'low' },
    });
    expect(personas).toHaveLength(3);
    expect(personas[0].techConfidence).toBe('low');
    expect(personas[0].id).toBeDefined();
  });

  it('runs simulation and tracks count', async () => {
    const runner = createStubUsabilitySimulationRunner({ completionRate: 1.0 });
    const session = await runner.deployStory(story, { viewport: 1280 });
    const personas = await runner.generatePersonas({ count: 1 });
    const result = await runner.runSimulation(session, {
      persona: personas[0],
      task,
      maxActions: 20,
      timeout: 'PT60S',
    });
    expect(result.completed).toBe(true);
    expect(result.metrics.actionsTaken).toBe(5);
    expect(result.metrics.efficiency).toBe(1.0);
    expect(result.actionTrace.length).toBeGreaterThan(0);
    expect(runner.getSimulationCount()).toBe(1);
  });

  it('injects prebuilt findings on failure', async () => {
    const runner = createStubUsabilitySimulationRunner({
      completionRate: 0, // always fail
      findings: [sampleFinding],
    });
    const session = await runner.deployStory(story, { viewport: 375 });
    const personas = await runner.generatePersonas({ count: 1 });
    const result = await runner.runSimulation(session, {
      persona: personas[0],
      task,
      maxActions: 20,
      timeout: 'PT60S',
    });
    expect(result.completed).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('major');
    expect(result.findings[0].confidence).toBe(0.85);
  });

  it('aggregates results across personas', async () => {
    const runner = createStubUsabilitySimulationRunner({ completionRate: 1.0 });
    const session = await runner.deployStory(story, { viewport: 1280 });
    const personas = await runner.generatePersonas({ count: 3 });
    const results = [];
    for (const persona of personas) {
      results.push(
        await runner.runSimulation(session, {
          persona,
          task,
          maxActions: 20,
          timeout: 'PT60S',
        }),
      );
    }
    const report = await runner.aggregateResults(results);
    expect(report.totalSimulations).toBe(3);
    expect(report.completionRate).toBe(1.0);
    expect(report.personaBreakdown).toHaveLength(3);
    expect(report.averageEfficiency).toBeGreaterThan(0);
  });
});
