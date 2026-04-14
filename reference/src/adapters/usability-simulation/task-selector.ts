/**
 * Task auto-selection algorithm for usability simulation (RFC-0006 §A.5.3.1).
 *
 * Selects task prompts from the task library based on component type,
 * with fallback generation and gap tracking.
 */

import type { TaskPrompt, StoryEntry } from '../interfaces.js';

export interface TaskLibrary {
  tasks: TaskPrompt[];
}

export interface TaskSelectionResult {
  selectedTasks: TaskPrompt[];
  isGeneric: boolean;
  gaps: string[];
}

/**
 * Select tasks from the library for a given component.
 *
 * Algorithm (§A.5.3.1):
 * 1. Determine component type from story metadata
 * 2. Filter tasks where component type is in applicableTo
 * 3. If multiple, run ALL (cap at maxTasksPerComponent)
 * 4. If none match, generate a generic task with 0.6 confidence ceiling
 * 5. Log TaskLibraryGap for unmatched component types
 */
export function selectTasks(
  story: StoryEntry,
  library: TaskLibrary,
  maxTasksPerComponent: number = 5,
): TaskSelectionResult {
  const componentType = story.componentName;

  // Step 2: Filter by applicableTo
  const matching = library.tasks.filter(
    (t) => t.applicableTo && t.applicableTo.includes(componentType),
  );

  // Step 3: Cap at max
  if (matching.length > 0) {
    const selected = matching.slice(0, maxTasksPerComponent);
    return { selectedTasks: selected, isGeneric: false, gaps: [] };
  }

  // Step 4: No match — generate generic task
  const genericTask = generateGenericTask(story);
  if (genericTask) {
    return {
      selectedTasks: [genericTask],
      isGeneric: true,
      gaps: [componentType],
    };
  }

  // Container/layout components — skip simulation
  return {
    selectedTasks: [],
    isGeneric: false,
    gaps: [componentType],
  };
}

/**
 * Generate a generic task prompt based on story metadata.
 *
 * - Interactive elements → "Interact with the primary action"
 * - Display-only → "Identify the key information"
 * - Container → null (skip)
 */
function generateGenericTask(story: StoryEntry): TaskPrompt | null {
  const kind = story.kind.toLowerCase();

  // Container/layout components — no meaningful task
  if (kind.includes('layout') || kind.includes('page') || kind.includes('section')) {
    return null;
  }

  // Interactive components
  if (
    kind.includes('input') ||
    kind.includes('form') ||
    kind.includes('button') ||
    kind.includes('modal') ||
    kind.includes('dialog')
  ) {
    return {
      id: `generic-interactive-${story.id}`,
      instruction: 'Interact with the primary action in this component',
      successCriteria: {
        type: 'element-state',
        target: '[data-testid], button, input, [role="button"]',
      },
      expectedActions: 3,
    };
  }

  // Display components
  return {
    id: `generic-display-${story.id}`,
    instruction: 'Identify the key information presented by this component',
    successCriteria: {
      type: 'element-state',
      target: '[data-testid], h1, h2, h3, [role="heading"]',
    },
    expectedActions: 2,
  };
}

/**
 * Parse a task library from YAML-like data (.ai-sdlc/usability-tasks.yaml).
 */
export function parseTaskLibrary(data: {
  tasks: Array<{
    id: string;
    instruction: string;
    successCriteria: { type: string; target: string };
    expectedActions?: number;
    applicableTo?: string[];
  }>;
}): TaskLibrary {
  return {
    tasks: data.tasks.map((t) => ({
      id: t.id,
      instruction: t.instruction,
      successCriteria: {
        type: t.successCriteria.type as TaskPrompt['successCriteria']['type'],
        target: t.successCriteria.target,
      },
      expectedActions: t.expectedActions,
      applicableTo: t.applicableTo,
    })),
  };
}
