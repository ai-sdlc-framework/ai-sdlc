import { deriveTaskClass, parseTaskFrontmatter } from '../labels/task-file.js';

/**
 * The task class for a task file: frontmatter `class:`, else its labels, else
 * the code areas it references (RFC-0062 OQ-3); 'uncategorized' only when none
 * of those exist.
 */
export function taskClassOf(rawBody: string | undefined): string {
  return deriveTaskClass(parseTaskFrontmatter(rawBody)).taskClass;
}
