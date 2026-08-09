/**
 * Logging for sonarqube-mcp.
 *
 * The server speaks JSON-RPC to Claude Code over stdio, so **stdout must stay
 * pristine** — a stray `console.log` would corrupt the protocol stream. Every
 * log line here is written to stderr.
 */

export const LOG_LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
  CRITICAL: 50,
};

let currentLevel: LogLevel = 'INFO';

/** Set the global log level. Safe to call repeatedly. */
export function configureLogging(level: LogLevel = 'INFO'): void {
  currentLevel = level;
}

function emit(level: LogLevel, name: string, message: string): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[currentLevel]) return;
  const timestamp = new Date().toISOString();
  // stderr only — see the module docstring.
  process.stderr.write(`${timestamp} | ${level.padEnd(8)} | ${name} | ${message}\n`);
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
  critical(message: string): void;
}

/** Return a module-scoped logger. */
export function getLogger(name: string): Logger {
  return {
    debug: (message) => emit('DEBUG', name, message),
    info: (message) => emit('INFO', name, message),
    warning: (message) => emit('WARNING', name, message),
    error: (message) => emit('ERROR', name, message),
    critical: (message) => emit('CRITICAL', name, message),
  };
}
