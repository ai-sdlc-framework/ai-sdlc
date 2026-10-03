/**
 * Agent History Filter — prevents sending previous agent conversations.
 *
 * Common hidden token killer: reusing full agent transcripts across iterations.
 * Instead, extract only the actionable findings and discard the reasoning.
 */

export interface AgentHistoryEntry {
  agentName: string;
  timestamp: string;
  prompt: string;
  response: string;
  tokensUsed?: number;
}

export interface FilteredHistoryEntry {
  agentName: string;
  summary: string; // Single sentence summary of the finding
  actionItems: string[];
  outcome: 'success' | 'failure' | 'escalation';
}

/**
 * Extract only actionable findings from agent history.
 * Discard reasoning, full prompts, and verbose outputs.
 */
export function filterAgentHistory(
  history: AgentHistoryEntry[],
  maxEntries = 3,
): FilteredHistoryEntry[] {
  return history.slice(-maxEntries).map((entry) => {
    const summary = extractSummary(entry.response);
    const actionItems = extractActionItems(entry.response);
    const outcome = determineOutcome(entry.response);

    return {
      agentName: entry.agentName,
      summary,
      actionItems,
      outcome,
    };
  });
}

/**
 * Extract one-sentence summary from agent response.
 */
function extractSummary(response: string): string {
  // Look for "## Summary" or similar markers
  const summaryMatch = response.match(/##\s*Summary\n+([^\n]+)/);
  if (summaryMatch) return summaryMatch[1].trim().slice(0, 200);

  // Fall back to first sentence
  const sentences = response.match(/[^.!?]+[.!?]/);
  if (sentences) return sentences[0].trim().slice(0, 200);

  return response.slice(0, 200);
}

/**
 * Extract action items from agent response.
 */
function extractActionItems(response: string): string[] {
  const items: string[] = [];

  // Look for bullet points or numbered lists
  const matches = response.match(/^[\s]*[-*•]\s+(.+?)$/gm) || [];
  for (const match of matches.slice(0, 5)) {
    const item = match.replace(/^[\s]*[-*•]\s+/, '').trim();
    if (item.length > 0 && item.length < 150) {
      items.push(item);
    }
  }

  return items;
}

/**
 * Determine outcome from agent response.
 */
function determineOutcome(response: string): 'success' | 'failure' | 'escalation' {
  const lower = response.toLowerCase();

  if (
    lower.includes('escalat') ||
    lower.includes('unresolved') ||
    lower.includes('requires manual')
  ) {
    return 'escalation';
  }
  if (lower.includes('failed') || lower.includes('error') || lower.includes('unable')) {
    return 'failure';
  }
  return 'success';
}

/**
 * Format filtered history for prompt injection.
 * Much more compact than sending full conversations.
 */
export function formatFilteredHistoryForPrompt(history: FilteredHistoryEntry[]): string {
  if (history.length === 0) {
    return '';
  }

  const lines = ['## Previous Agent Attempts (Summary Only)', ''];

  for (const entry of history) {
    const outcomeEmoji =
      entry.outcome === 'success' ? '✓' : entry.outcome === 'failure' ? '✗' : '⚠️ ';
    lines.push(`### ${outcomeEmoji} ${entry.agentName}`);
    lines.push(entry.summary);

    if (entry.actionItems.length > 0) {
      lines.push('');
      lines.push('Action items from this attempt:');
      for (const item of entry.actionItems) {
        lines.push(`- ${item}`);
      }
    }

    lines.push('');
  }

  lines.push('**Do not repeat what previous agents did.** Build on their progress.');

  return lines.join('\n');
}

/**
 * Check if history should be included at all.
 * For first attempts, don't include history.
 */
export function shouldIncludeHistory(iteration: number): boolean {
  return iteration > 1; // Only include on iterations 2+
}
