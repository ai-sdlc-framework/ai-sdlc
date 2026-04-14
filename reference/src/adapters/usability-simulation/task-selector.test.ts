import { describe, it, expect } from 'vitest';
import { selectTasks, parseTaskLibrary, type TaskLibrary } from './task-selector.js';
import type { StoryEntry } from '../interfaces.js';

const sampleLibrary: TaskLibrary = {
  tasks: [
    {
      id: 'form-submission',
      instruction: 'Fill out and submit the form',
      successCriteria: { type: 'form-submission', target: 'form' },
      expectedActions: 5,
      applicableTo: ['Form', 'ContactForm'],
    },
    {
      id: 'button-click',
      instruction: 'Click the primary action button',
      successCriteria: { type: 'element-state', target: 'button' },
      expectedActions: 2,
      applicableTo: ['Button', 'Card'],
    },
    {
      id: 'error-recovery',
      instruction: 'Submit with invalid data, then fix and resubmit',
      successCriteria: { type: 'form-submission', target: 'form' },
      expectedActions: 8,
      applicableTo: ['Form'],
    },
  ],
};

describe('selectTasks', () => {
  it('selects matching tasks by component type', () => {
    const story: StoryEntry = {
      id: 'form--default',
      name: 'Default',
      componentName: 'Form',
      kind: 'inputs',
    };
    const result = selectTasks(story, sampleLibrary);
    expect(result.selectedTasks).toHaveLength(2); // form-submission + error-recovery
    expect(result.isGeneric).toBe(false);
    expect(result.gaps).toHaveLength(0);
  });

  it('caps at maxTasksPerComponent', () => {
    const story: StoryEntry = {
      id: 'form--default',
      name: 'Default',
      componentName: 'Form',
      kind: 'inputs',
    };
    const result = selectTasks(story, sampleLibrary, 1);
    expect(result.selectedTasks).toHaveLength(1);
  });

  it('generates generic task when no match', () => {
    const story: StoryEntry = {
      id: 'modal--default',
      name: 'Default',
      componentName: 'Modal',
      kind: 'overlays/modal',
    };
    const result = selectTasks(story, sampleLibrary);
    expect(result.isGeneric).toBe(true);
    expect(result.selectedTasks).toHaveLength(1);
    expect(result.selectedTasks[0].id).toContain('generic');
    expect(result.gaps).toContain('Modal');
  });

  it('skips container/layout components', () => {
    const story: StoryEntry = {
      id: 'page--default',
      name: 'Default',
      componentName: 'PageLayout',
      kind: 'layout/page',
    };
    const result = selectTasks(story, sampleLibrary);
    expect(result.selectedTasks).toHaveLength(0);
    expect(result.gaps).toContain('PageLayout');
  });

  it('generates interactive task for button-like components', () => {
    const story: StoryEntry = {
      id: 'submit--default',
      name: 'Default',
      componentName: 'SubmitButton',
      kind: 'inputs/button',
    };
    const result = selectTasks(story, sampleLibrary);
    expect(result.isGeneric).toBe(true);
    expect(result.selectedTasks[0].instruction).toContain('primary action');
  });

  it('generates display task for display components', () => {
    const story: StoryEntry = {
      id: 'badge--default',
      name: 'Default',
      componentName: 'Badge',
      kind: 'display/badge',
    };
    const result = selectTasks(story, sampleLibrary);
    expect(result.isGeneric).toBe(true);
    expect(result.selectedTasks[0].instruction).toContain('key information');
  });
});

describe('parseTaskLibrary', () => {
  it('parses YAML-like data', () => {
    const data = {
      tasks: [
        {
          id: 'test-task',
          instruction: 'Do something',
          successCriteria: { type: 'element-state', target: 'button' },
          expectedActions: 3,
          applicableTo: ['Button'],
        },
      ],
    };
    const library = parseTaskLibrary(data);
    expect(library.tasks).toHaveLength(1);
    expect(library.tasks[0].id).toBe('test-task');
    expect(library.tasks[0].applicableTo).toContain('Button');
  });
});
