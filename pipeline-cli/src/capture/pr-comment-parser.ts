/**
 * RFC-0024 §5.2 — PR-comment marker parser.
 *
 * Parses `<!-- ai-sdlc:capture ... -->` markers embedded in GitHub PR review
 * comments and converts them to capture record fields.
 *
 * Marker syntax (single line):
 *
 *   <!-- ai-sdlc:capture severity=<value> triage=<value> -->
 *   <body text that becomes the `finding`>
 *
 * The marker must appear on its own line (first line of the comment or a
 * dedicated line). The body text following the marker line is the finding.
 * If the marker appears inline (not on its own line) the whole comment text
 * becomes the finding.
 *
 * OQ-3 resolution: a PR comment CAN include the capture marker so it
 * appears in both the GitHub UI (as a standard review comment) AND in the
 * capture corpus. Both channels are visible — the PR comment is human-
 * readable context; the capture record is machine-triageable.
 *
 * @module capture/pr-comment-parser
 */

import type { CaptureSeverity, CaptureTriageValue } from './capture-record.js';
import { VALID_SEVERITIES, VALID_TRIAGE_VALUES } from './capture-record.js';

// ── Marker ────────────────────────────────────────────────────────────────────

/**
 * The HTML comment marker that triggers capture from a PR comment body.
 * Must be on a line by itself (leading/trailing whitespace tolerated).
 */
export const PR_CAPTURE_MARKER = 'ai-sdlc:capture';
export const PR_CAPTURE_COMMENT_START = '<!-- ai-sdlc:capture';

// ── Parsed marker attributes ──────────────────────────────────────────────────

export interface ParsedPrMarker {
  /** Whether the capture marker was present. */
  found: boolean;
  /** Severity parsed from `severity=<value>`. Undefined when not present. */
  severity?: CaptureSeverity;
  /** Triage parsed from `triage=<value>`. Undefined when not present. */
  triage?: CaptureTriageValue;
  /**
   * The finding text: body text after the marker line, or the full
   * comment body when the marker is inline.
   */
  finding: string;
  /** Offset of the marker line in the comment (0-based). -1 if not found. */
  markerLineIndex: number;
}

/**
 * Parse a GitHub PR review comment body for an `ai-sdlc:capture` marker.
 *
 * Returns a `ParsedPrMarker` with `found: false` when no marker is present
 * so callers can skip non-capture comments cheaply.
 */
export function parsePrCommentMarker(commentBody: string): ParsedPrMarker {
  const lines = commentBody.split('\n');
  let markerLineIndex = -1;
  let severity: CaptureSeverity | undefined;
  let triage: CaptureTriageValue | undefined;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith(PR_CAPTURE_COMMENT_START)) continue;

    markerLineIndex = i;

    // Extract key=value attributes from the comment tag.
    // Pattern: <!-- ai-sdlc:capture key=value key=value ... -->
    const attrSection = trimmed.replace(/^<!--\s*ai-sdlc:capture\s*/, '').replace(/\s*-->$/, '');

    for (const token of attrSection.split(/\s+/)) {
      const [key, val] = token.split('=');
      if (!key || !val) continue;
      if (key === 'severity' && VALID_SEVERITIES.includes(val as CaptureSeverity)) {
        severity = val as CaptureSeverity;
      }
      if (key === 'triage' && VALID_TRIAGE_VALUES.includes(val as CaptureTriageValue)) {
        triage = val as CaptureTriageValue;
      }
    }

    break; // First marker wins.
  }

  if (markerLineIndex === -1) {
    return { found: false, finding: commentBody.trim(), markerLineIndex: -1 };
  }

  // Finding = everything after the marker line, trimmed.
  const bodyLines = lines.slice(markerLineIndex + 1);
  const finding = bodyLines.join('\n').trim() || commentBody.trim();

  return { found: true, severity, triage, finding, markerLineIndex };
}

// ── GitHub PR comment shape ───────────────────────────────────────────────────

/** Minimal GitHub PR review comment shape used by the parser. */
export interface GhPrReviewComment {
  /** GitHub's stable comment database ID. */
  databaseId?: number;
  /** Comment body text. */
  body: string;
  /** Author login. */
  author?: { login: string };
  /** PR number this comment belongs to. */
  prNumber?: number;
  /** Direct URL to the comment on GitHub. */
  url?: string;
  /** Permalink URL (more stable than `url` for review threads). */
  path?: string;
}

/** A capture-eligible comment with its parsed marker. */
export interface ParsedPrComment {
  comment: GhPrReviewComment;
  marker: ParsedPrMarker;
}

/**
 * Filter a list of PR review comments to those that contain the
 * `ai-sdlc:capture` marker. Parsing is cheap — only checks for the
 * marker prefix, no regex.
 */
export function findCaptureComments(comments: GhPrReviewComment[]): ParsedPrComment[] {
  const results: ParsedPrComment[] = [];
  for (const comment of comments) {
    if (!comment.body.includes(PR_CAPTURE_MARKER)) continue;
    const marker = parsePrCommentMarker(comment.body);
    if (marker.found) {
      results.push({ comment, marker });
    }
  }
  return results;
}
