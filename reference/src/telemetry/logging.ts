/**
 * Structured logging for AI-SDLC Framework (PRD Section 14).
 * Provides structured log entries with level, message, attributes, and timestamps.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  logger?: string;
  attributes?: Record<string, unknown>;
  error?: string;
}

export interface StructuredLogger {
  debug(msg: string, attrs?: Record<string, unknown>): void;
  info(msg: string, attrs?: Record<string, unknown>): void;
  warn(msg: string, attrs?: Record<string, unknown>): void;
  error(msg: string, attrs?: Record<string, unknown>, err?: Error): void;
}

export interface BufferLogger extends StructuredLogger {
  getEntries(): readonly LogEntry[];
  clear(): void;
}

function createEntry(
  level: LogLevel,
  message: string,
  logger?: string,
  attrs?: Record<string, unknown>,
  err?: Error,
): LogEntry {
  return {
    level,
    message,
    timestamp: new Date().toISOString(),
    logger,
    attributes: attrs,
    error: err?.message,
  };
}

/**
 * Create a no-op logger that silently discards all messages.
 */
export function createNoOpLogger(): StructuredLogger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

/**
 * Create a buffer logger that stores entries in-memory for testing.
 */
export function createBufferLogger(name?: string): BufferLogger {
  const entries: LogEntry[] = [];

  return {
    debug(msg: string, attrs?: Record<string, unknown>) {
      entries.push(createEntry('debug', msg, name, attrs));
    },
    info(msg: string, attrs?: Record<string, unknown>) {
      entries.push(createEntry('info', msg, name, attrs));
    },
    warn(msg: string, attrs?: Record<string, unknown>) {
      entries.push(createEntry('warn', msg, name, attrs));
    },
    error(msg: string, attrs?: Record<string, unknown>, err?: Error) {
      entries.push(createEntry('error', msg, name, attrs, err));
    },
    getEntries(): readonly LogEntry[] {
      return entries;
    },
    clear() {
      entries.length = 0;
    },
  };
}

/**
 * Create a console logger that writes JSON-formatted structured logs.
 */
export function createConsoleLogger(name?: string): StructuredLogger {
  function write(level: LogLevel, msg: string, attrs?: Record<string, unknown>, err?: Error) {
    const entry = createEntry(level, msg, name, attrs, err);
    const json = JSON.stringify(entry);
    switch (level) {
      case 'debug':
        console.debug(json);
        break;
      case 'info':
        console.log(json);
        break;
      case 'warn':
        console.warn(json);
        break;
      case 'error':
        console.error(json);
        break;
    }
  }

  return {
    debug(msg: string, attrs?: Record<string, unknown>) {
      write('debug', msg, attrs);
    },
    info(msg: string, attrs?: Record<string, unknown>) {
      write('info', msg, attrs);
    },
    warn(msg: string, attrs?: Record<string, unknown>) {
      write('warn', msg, attrs);
    },
    error(msg: string, attrs?: Record<string, unknown>, err?: Error) {
      write('error', msg, attrs, err);
    },
  };
}
