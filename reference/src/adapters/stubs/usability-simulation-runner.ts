/**
 * Stub UsabilitySimulationRunner adapter for testing.
 * Configurable completion rates and pre-built simulation results.
 */

import type {
  UsabilitySimulationRunner,
  StoryEntry,
  BrowserSession,
  Persona,
  SimulationResult,
  AggregatedUsabilityReport,
  UsabilityFinding,
} from '../interfaces.js';

export interface StubUsabilitySimulationConfig {
  /** Default completion rate for simulations (0.0-1.0). */
  completionRate?: number;
  /** Pre-built findings to inject into results. */
  findings?: UsabilityFinding[];
}

export interface StubUsabilitySimulationRunnerAdapter extends UsabilitySimulationRunner {
  /** Get the number of simulations run. */
  getSimulationCount(): number;
  /** Get all deployed sessions. */
  getDeployedSessions(): BrowserSession[];
}

export function createStubUsabilitySimulationRunner(
  config: StubUsabilitySimulationConfig = {},
): StubUsabilitySimulationRunnerAdapter {
  let simulationCount = 0;
  const sessions: BrowserSession[] = [];
  const completionRate = config.completionRate ?? 1.0;
  const prebuiltFindings = config.findings ?? [];

  return {
    async deployStory(
      story: StoryEntry,
      options: { viewport: number; theme?: string; locale?: string },
    ): Promise<BrowserSession> {
      const session: BrowserSession = {
        sessionId: `session-${sessions.length + 1}`,
        storyUrl: `http://localhost:6006/iframe.html?id=${story.id}`,
        environment: {
          browser: 'chromium',
          viewport: { width: options.viewport, height: 800 },
          theme: options.theme,
          locale: options.locale,
        },
        isActive: true,
        createdAt: new Date().toISOString(),
        ttl: 'PT5M',
        connector: {
          async getPageState() {
            return {
              url: `http://localhost:6006/iframe.html?id=${story.id}`,
              title: story.name,
              elements: [
                {
                  selector: 'button',
                  tagName: 'button',
                  text: 'Submit',
                  role: 'button',
                  visible: true,
                  interactive: true,
                },
              ],
            };
          },
          async executeAction(_action) {
            return { success: true };
          },
          async captureScreenshot() {
            return 'data:image/png;base64,stub-screenshot';
          },
        },
      };
      sessions.push(session);
      return session;
    },

    async generatePersonas(config): Promise<Persona[]> {
      const personas: Persona[] = [];
      for (let i = 0; i < config.count; i++) {
        personas.push({
          id: `persona-${i + 1}`,
          name: `Test User ${i + 1}`,
          techConfidence: config.demographics?.techConfidence ?? 'medium',
          ageRange: config.demographics?.ageRange,
          accessibilityNeeds: config.demographics?.accessibilityNeeds,
        });
      }
      return personas;
    },

    async runSimulation(_session, options): Promise<SimulationResult> {
      simulationCount++;
      const completed = Math.random() < completionRate;
      const actionsTaken = completed
        ? (options.task.expectedActions ?? 5)
        : (options.task.expectedActions ?? 5) + 3;
      const expected = options.task.expectedActions ?? 5;

      return {
        persona: options.persona,
        task: options.task,
        completed,
        metrics: {
          actionsTaken,
          expectedActions: expected,
          efficiency: expected / actionsTaken,
          timeElapsed: 'PT30S',
          errorsEncountered: completed ? 0 : 1,
          backtrackCount: completed ? 0 : 1,
          hesitationCount: completed ? 0 : 2,
        },
        actionTrace: [
          {
            action: 'click',
            target: 'button[type="submit"]',
            timestamp: new Date().toISOString(),
            agentReasoning: 'Found the primary action button',
          },
        ],
        findings: completed ? [] : [...prebuiltFindings],
      };
    },

    async aggregateResults(results: SimulationResult[]): Promise<AggregatedUsabilityReport> {
      const totalSimulations = results.length;
      const completedCount = results.filter((r) => r.completed).length;
      const allFindings = results.flatMap((r) => r.findings);

      return {
        totalSimulations,
        completionRate: totalSimulations > 0 ? completedCount / totalSimulations : 0,
        averageEfficiency:
          totalSimulations > 0
            ? results.reduce((sum, r) => sum + r.metrics.efficiency, 0) / totalSimulations
            : 0,
        findings: allFindings,
        personaBreakdown: results.map((r) => ({
          persona: r.persona,
          completed: r.completed,
          efficiency: r.metrics.efficiency,
          findingsCount: r.findings.length,
        })),
      };
    },

    // Test helpers
    getSimulationCount() {
      return simulationCount;
    },
    getDeployedSessions() {
      return [...sessions];
    },
  };
}
