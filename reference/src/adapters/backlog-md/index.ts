/**
 * Backlog.md adapter — implements IssueTracker via local markdown files.
 * Uses injectable filesystem interface for testability (parallel to Jira's HttpClient).
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type {
  IssueTracker,
  Issue,
  IssueFilter,
  IssueComment,
  CreateIssueInput,
  UpdateIssueInput,
  EventStream,
  IssueEvent,
} from '../interfaces.js';

// ── Types ────────────────────────────────────────────────────────────

export interface BacklogMdConfig {
  /** Path to the backlog directory (contains config.yml and tasks/). */
  backlogDir: string;
  /** Override task ID prefix; otherwise read from config.yml. */
  taskPrefix?: string;
}

/** Injectable filesystem interface for testability. */
export interface BacklogFs {
  readdir(dirPath: string): Promise<string[]>;
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  exists(filePath: string): Promise<boolean>;
}

interface TaskFrontmatter {
  id: string;
  title: string;
  status: string;
  assignee?: string[];
  labels?: string[];
  [key: string]: unknown;
}

interface BacklogConfig {
  task_prefix: string;
  statuses: string[];
}

// ── Internal Helpers ─────────────────────────────────────────────────

function createDefaultFs(): BacklogFs {
  return {
    async readdir(dirPath: string): Promise<string[]> {
      const { readdir } = await import('node:fs/promises');
      return readdir(dirPath);
    },
    async readFile(filePath: string): Promise<string> {
      const { readFile } = await import('node:fs/promises');
      return readFile(filePath, 'utf-8');
    },
    async writeFile(filePath: string, content: string): Promise<void> {
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, 'utf-8');
    },
    async exists(filePath: string): Promise<boolean> {
      const { access } = await import('node:fs/promises');
      try {
        await access(filePath);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function parseFrontmatter(content: string): { frontmatter: TaskFrontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error('Invalid task file: missing frontmatter delimiters');
  }
  const frontmatter = parseYaml(match[1]) as TaskFrontmatter;
  const body = match[2];
  return { frontmatter, body };
}

function serializeTask(frontmatter: TaskFrontmatter, body: string): string {
  const yamlStr = stringifyYaml(frontmatter).trimEnd();
  return `---\n${yamlStr}\n---\n${body}`;
}

function mapToIssue(frontmatter: TaskFrontmatter, body: string, filePath: string): Issue {
  return {
    id: frontmatter.id,
    title: frontmatter.title,
    description: extractDescription(body),
    status: frontmatter.status,
    labels: frontmatter.labels ?? [],
    assignee: Array.isArray(frontmatter.assignee) ? frontmatter.assignee[0] : frontmatter.assignee,
    url: `file://${filePath}`,
  };
}

function extractDescription(body: string): string {
  const beginMarker = '<!-- SECTION:DESCRIPTION:BEGIN -->';
  const endMarker = '<!-- SECTION:DESCRIPTION:END -->';
  const beginIdx = body.indexOf(beginMarker);
  const endIdx = body.indexOf(endMarker);
  if (beginIdx === -1 || endIdx === -1) {
    // Fall back to first ## Description section content
    const descMatch = body.match(/## Description\s*\n([\s\S]*?)(?=\n## |\n<!-- |$)/);
    return descMatch ? descMatch[1].trim() : '';
  }
  return body.slice(beginIdx + beginMarker.length, endIdx).trim();
}

async function findTaskFile(
  fs: BacklogFs,
  tasksDir: string,
  id: string,
): Promise<{ fileName: string; content: string }> {
  const files = await fs.readdir(tasksDir);
  const normalizedId = id.toLowerCase();
  const match = files.find((f) => f.toLowerCase().startsWith(normalizedId) && f.endsWith('.md'));
  if (!match) {
    throw new Error(`Task "${id}" not found in ${tasksDir}`);
  }
  const content = await fs.readFile(`${tasksDir}/${match}`);
  return { fileName: match, content };
}

async function loadConfig(fs: BacklogFs, backlogDir: string): Promise<BacklogConfig> {
  const configPath = `${backlogDir}/config.yml`;
  if (!(await fs.exists(configPath))) {
    return { task_prefix: 'TASK', statuses: ['To Do', 'In Progress', 'Done'] };
  }
  const content = await fs.readFile(configPath);
  const parsed = parseYaml(content) as Record<string, unknown>;
  return {
    task_prefix: (parsed.task_prefix as string) ?? 'TASK',
    statuses: (parsed.statuses as string[]) ?? ['To Do', 'In Progress', 'Done'],
  };
}

async function getNextTaskNumber(fs: BacklogFs, tasksDir: string, prefix: string): Promise<number> {
  if (!(await fs.exists(tasksDir))) return 1;
  const files = await fs.readdir(tasksDir);
  let max = 0;
  const pattern = new RegExp(`^${prefix.toLowerCase()}-(\\d+)`, 'i');
  for (const file of files) {
    const match = file.match(pattern);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > max) max = num;
    }
  }
  return max + 1;
}

function createStubEventStream<T>(): EventStream<T> {
  return {
    async *[Symbol.asyncIterator]() {
      // Stub — filesystem watching not implemented
    },
  };
}

function buildFileName(id: string, title: string): string {
  const slug = title
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return `${id.toLowerCase()} - ${slug}.md`;
}

// ── IssueTracker ─────────────────────────────────────────────────────

export function createBacklogMdIssueTracker(
  config: BacklogMdConfig,
  injectedFs?: BacklogFs,
): IssueTracker {
  const fs = injectedFs ?? createDefaultFs();
  const tasksDir = `${config.backlogDir}/tasks`;

  return {
    async listIssues(filter: IssueFilter): Promise<Issue[]> {
      if (!(await fs.exists(tasksDir))) return [];

      const files = await fs.readdir(tasksDir);
      const issues: Issue[] = [];

      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const filePath = `${tasksDir}/${file}`;
        const content = await fs.readFile(filePath);
        try {
          const { frontmatter, body } = parseFrontmatter(content);
          const issue = mapToIssue(frontmatter, body, filePath);

          // Apply filters
          if (filter.status && issue.status.toLowerCase() !== filter.status.toLowerCase()) continue;
          if (filter.labels?.length) {
            const issueLabels = (issue.labels ?? []).map((l) => l.toLowerCase());
            if (!filter.labels.some((l) => issueLabels.includes(l.toLowerCase()))) continue;
          }
          if (filter.assignee && issue.assignee?.toLowerCase() !== filter.assignee.toLowerCase())
            continue;

          issues.push(issue);
        } catch {
          // Skip malformed files
        }
      }

      return issues;
    },

    async getIssue(id: string): Promise<Issue> {
      if (!(await fs.exists(tasksDir))) {
        throw new Error(`Backlog tasks directory not found: ${tasksDir}`);
      }
      const { fileName, content } = await findTaskFile(fs, tasksDir, id);
      const { frontmatter, body } = parseFrontmatter(content);
      return mapToIssue(frontmatter, body, `${tasksDir}/${fileName}`);
    },

    async createIssue(input: CreateIssueInput): Promise<Issue> {
      if (!(await fs.exists(config.backlogDir))) {
        throw new Error(`Backlog directory not found: ${config.backlogDir}`);
      }

      const backlogConfig = await loadConfig(fs, config.backlogDir);
      const prefix = config.taskPrefix ?? backlogConfig.task_prefix;
      const nextNum = await getNextTaskNumber(fs, tasksDir, prefix);
      const id = `${prefix}-${nextNum}`;

      const frontmatter: TaskFrontmatter = {
        id,
        title: input.title,
        status: backlogConfig.statuses[0] ?? 'To Do',
        assignee: input.assignee ? [input.assignee] : [],
        labels: input.labels ?? [],
        created_date: new Date().toISOString().slice(0, 16).replace('T', ' '),
        dependencies: [],
      };

      const descSection = input.description
        ? `<!-- SECTION:DESCRIPTION:BEGIN -->\n${input.description}\n<!-- SECTION:DESCRIPTION:END -->`
        : `<!-- SECTION:DESCRIPTION:BEGIN -->\n<!-- SECTION:DESCRIPTION:END -->`;

      const body = `\n## Description\n\n${descSection}\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n<!-- AC:END -->\n`;

      const fileName = buildFileName(id, input.title);
      const filePath = `${tasksDir}/${fileName}`;
      await fs.writeFile(filePath, serializeTask(frontmatter, body));

      return mapToIssue(frontmatter, body, filePath);
    },

    async updateIssue(id: string, input: UpdateIssueInput): Promise<Issue> {
      if (!(await fs.exists(tasksDir))) {
        throw new Error(`Backlog tasks directory not found: ${tasksDir}`);
      }
      const { fileName, content } = await findTaskFile(fs, tasksDir, id);
      const { frontmatter, body } = parseFrontmatter(content);

      if (input.title !== undefined) frontmatter.title = input.title;
      if (input.labels !== undefined) frontmatter.labels = input.labels;
      if (input.assignee !== undefined) frontmatter.assignee = [input.assignee];

      let updatedBody = body;
      if (input.description !== undefined) {
        const beginMarker = '<!-- SECTION:DESCRIPTION:BEGIN -->';
        const endMarker = '<!-- SECTION:DESCRIPTION:END -->';
        const beginIdx = updatedBody.indexOf(beginMarker);
        const endIdx = updatedBody.indexOf(endMarker);
        if (beginIdx !== -1 && endIdx !== -1) {
          updatedBody =
            updatedBody.slice(0, beginIdx + beginMarker.length) +
            `\n${input.description}\n` +
            updatedBody.slice(endIdx);
        }
      }

      const filePath = `${tasksDir}/${fileName}`;
      await fs.writeFile(filePath, serializeTask(frontmatter, updatedBody));
      return mapToIssue(frontmatter, updatedBody, filePath);
    },

    async transitionIssue(id: string, transition: string): Promise<Issue> {
      if (!(await fs.exists(tasksDir))) {
        throw new Error(`Backlog tasks directory not found: ${tasksDir}`);
      }

      const backlogConfig = await loadConfig(fs, config.backlogDir);
      const validStatuses = backlogConfig.statuses.map((s) => s.toLowerCase());
      if (!validStatuses.includes(transition.toLowerCase())) {
        throw new Error(
          `Invalid status "${transition}". Valid statuses: ${backlogConfig.statuses.join(', ')}`,
        );
      }
      // Use the canonical casing from config
      const canonicalStatus =
        backlogConfig.statuses.find((s) => s.toLowerCase() === transition.toLowerCase()) ??
        transition;

      const { fileName, content } = await findTaskFile(fs, tasksDir, id);
      const { frontmatter, body } = parseFrontmatter(content);
      frontmatter.status = canonicalStatus;

      const filePath = `${tasksDir}/${fileName}`;
      await fs.writeFile(filePath, serializeTask(frontmatter, body));
      return mapToIssue(frontmatter, body, filePath);
    },

    async addComment(id: string, body: string): Promise<void> {
      if (!(await fs.exists(tasksDir))) {
        throw new Error(`Backlog tasks directory not found: ${tasksDir}`);
      }
      const { fileName, content } = await findTaskFile(fs, tasksDir, id);
      const { frontmatter, body: taskBody } = parseFrontmatter(content);

      const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const noteSection = `\n### Note (${timestamp})\n\n${body}\n`;

      let updatedBody: string;
      const implNotesIdx = taskBody.indexOf('## Implementation Notes');
      if (implNotesIdx !== -1) {
        // Append after the Implementation Notes heading
        const afterHeading = implNotesIdx + '## Implementation Notes'.length;
        updatedBody =
          taskBody.slice(0, afterHeading) + '\n' + noteSection + taskBody.slice(afterHeading);
      } else {
        // Add a new Implementation Notes section at the end
        updatedBody = taskBody + '\n## Implementation Notes\n' + noteSection;
      }

      const filePath = `${tasksDir}/${fileName}`;
      await fs.writeFile(filePath, serializeTask(frontmatter, updatedBody));
    },

    async getComments(id: string): Promise<IssueComment[]> {
      if (!(await fs.exists(tasksDir))) {
        throw new Error(`Backlog tasks directory not found: ${tasksDir}`);
      }
      const { content } = await findTaskFile(fs, tasksDir, id);
      const { body } = parseFrontmatter(content);

      const comments: IssueComment[] = [];
      const notePattern = /### Note \([^)]+\)\s*\n\n([\s\S]*?)(?=\n### Note \(|$)/g;
      let match: RegExpExecArray | null;
      while ((match = notePattern.exec(body)) !== null) {
        comments.push({ body: match[1].trim() });
      }
      return comments;
    },

    watchIssues(_filter: IssueFilter): EventStream<IssueEvent> {
      return createStubEventStream();
    },
  };
}
