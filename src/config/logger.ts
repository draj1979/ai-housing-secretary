/**
 * config/logger.ts
 *
 * Shared pino logger (HLD Sec 5: "pino" in the tech stack; HLD Sec 15 audit
 * logging, Sec 17 90-day log retention). `createLogger(name)` gives each
 * module its own child logger (e.g. `{"module":"webhook"}`) without every
 * call site re-reading LOG_LEVEL from the environment.
 */
import pino from 'pino';
import { loadEnv } from './env.js';

let rootLogger: pino.Logger | undefined;

function getRootLogger(): pino.Logger {
  if (!rootLogger) {
    const env = loadEnv();
    rootLogger = pino({ level: env.LOG_LEVEL });
  }
  return rootLogger;
}

export function createLogger(module: string): pino.Logger {
  return getRootLogger().child({ module });
}
