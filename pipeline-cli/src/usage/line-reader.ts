/**
 * Bounded, incremental line reader for untrusted transcript files.
 *
 * Reads from a byte offset in fixed-size chunks so memory stays flat however
 * large the file is, drops lines longer than a cap (counting each as an error),
 * and reports the offset just after the last COMPLETE line so a truncated final
 * line is retried on the next run rather than skipped.
 */

import { closeSync, openSync, readSync } from 'node:fs';

export const CHUNK_BYTES = 1024 * 1024;
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

export interface ReadLinesOptions {
  /** Byte offset to start from. */
  start: number;
  /** Stop after reading this many bytes from `start`. */
  maxBytes: number;
  maxLineBytes?: number;
  /**
   * Called for every complete, non-empty line with its start offset and the
   * offset just past its newline. Return false to stop reading.
   */
  onLine: (line: string, lineStart: number, endOffset: number) => boolean;
}

export interface ReadLinesResult {
  /** Offset just past the last complete line consumed. */
  consumed: number;
  /** Lines dropped for exceeding the length cap. */
  oversizeLines: number;
  /** True when the reader was stopped by the callback or the byte cap. */
  stoppedEarly: boolean;
}

export function readLines(path: string, opts: ReadLinesOptions): ReadLinesResult {
  const maxLine = opts.maxLineBytes ?? MAX_LINE_BYTES;
  const fd = openSync(path, 'r');
  const chunk = Buffer.alloc(CHUNK_BYTES);
  let carry: Buffer[] = [];
  let carryLen = 0;
  let discarding = false;
  let oversizeLines = 0;
  let consumed = opts.start;
  let lineStart = opts.start;
  let filePos = opts.start;
  let stoppedEarly = false;

  try {
    outer: while (filePos - opts.start < opts.maxBytes) {
      const n = readSync(fd, chunk, 0, CHUNK_BYTES, filePos);
      if (n <= 0) break;
      const base = filePos;
      filePos += n;
      let pos = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, pos);
        if (nl === -1 || nl >= n) {
          const rest = n - pos;
          if (!discarding) {
            if (carryLen + rest > maxLine) {
              discarding = true;
              oversizeLines++;
              carry = [];
              carryLen = 0;
            } else if (rest > 0) {
              carry.push(Buffer.from(chunk.subarray(pos, n)));
              carryLen += rest;
            }
          }
          break;
        }
        const endOffset = base + nl + 1;
        if (discarding) {
          discarding = false;
        } else {
          const pieceLen = nl - pos;
          if (carryLen + pieceLen > maxLine) {
            oversizeLines++;
          } else {
            carry.push(chunk.subarray(pos, nl));
            const text = Buffer.concat(carry).toString('utf-8');
            if (text.trim().length > 0 && !opts.onLine(text, lineStart, endOffset)) {
              consumed = endOffset;
              stoppedEarly = true;
              break outer;
            }
          }
        }
        carry = [];
        carryLen = 0;
        consumed = endOffset;
        lineStart = endOffset;
        pos = nl + 1;
      }
    }
    if (!stoppedEarly && filePos - opts.start >= opts.maxBytes) stoppedEarly = true;
  } finally {
    closeSync(fd);
  }
  return { consumed, oversizeLines, stoppedEarly };
}
