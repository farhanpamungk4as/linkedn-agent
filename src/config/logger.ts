import type { AppConfig } from "./index.js";

const levels = { debug: 0, info: 1, warn: 2, error: 3 } as const;

export function createLogger(level: AppConfig["logLevel"] = "info") {
  function write(messageLevel: keyof typeof levels, message: string, details?: Record<string, unknown>) {
    if (levels[messageLevel] < levels[level]) return;
    const suffix = details ? ` ${JSON.stringify(details)}` : "";
    console.error(`${new Date().toISOString()} ${messageLevel.toUpperCase()} ${message}${suffix}`);
  }

  return {
    debug: (message: string, details?: Record<string, unknown>) => write("debug", message, details),
    info: (message: string, details?: Record<string, unknown>) => write("info", message, details),
    warn: (message: string, details?: Record<string, unknown>) => write("warn", message, details),
    error: (message: string, details?: Record<string, unknown>) => write("error", message, details),
  };
}

export type Logger = ReturnType<typeof createLogger>;
