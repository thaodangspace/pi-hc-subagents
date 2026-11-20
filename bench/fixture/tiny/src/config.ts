import { ConfigurationError } from "./errors.ts";

export interface Config {
  port: number;
  timeoutMs: number;
  retries: number;
}

export const DEFAULT_PORT = 8080;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_RETRIES = 3;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: readInt("PORT", env.PORT, DEFAULT_PORT),
    timeoutMs: readInt("TIMEOUT_MS", env.TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    retries: readInt("RETRIES", env.RETRIES, DEFAULT_RETRIES),
  };
}

function readInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new ConfigurationError(`${name} must be a non-negative integer, got ${raw}`);
  }
  return value;
}

export function validateConfig(config: Config): void {
  if (config.port <= 0 || config.port > 65_535) {
    throw new ConfigurationError(`port out of range: ${config.port}`);
  }
  if (config.timeoutMs <= 0) {
    throw new ConfigurationError(`timeoutMs must be positive: ${config.timeoutMs}`);
  }
  if (config.retries < 0) {
    throw new ConfigurationError(`retries must not be negative: ${config.retries}`);
  }
}
