import pino from "pino";

/**
 * Bun-safe pino setup: stdout only, NO worker-thread transports
 * (thread-stream is unreliable under Bun). Shipping is Fly's job —
 * it captures stdout natively. Local pretty-print: pipe through
 * `bun run dev | bunx pino-pretty` instead of a transport.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
});

export function moduleLogger(name: string): pino.Logger {
  return logger.child({ module: name });
}
