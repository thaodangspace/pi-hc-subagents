/**
 * Configuration contract for pi-hc-subagents.
 *
 * Invalid known fields warn once and keep the lower-precedence value; they
 * never crash the extension.
 */

export type AgentScope = "user" | "project" | "both";
export type DefaultMode = "sync" | "async";
export type NotifyMode = "async" | "none";
export type CleanupPolicy = "keep" | "remove";
export type Exposure = "direct" | "model-only";

export interface IntertoolConfig {
  exposeService: boolean;
  emitEvents: boolean;
  includeTaskPreview: boolean;
}

export interface HcSubagentsConfig {
  maxConcurrency: number;
  maxDepth: number;
  defaultMode: DefaultMode;
  startupTimeoutMs: number;
  waitTimeoutMs: number;
  pollIntervalMs: number;
  killOnAbort: boolean;
  killOnTimeout: boolean;
  monitorAfterReturn: boolean;
  notify: NotifyMode;
  agentScope: AgentScope;
  parallelWrites: boolean;
  cleanup: CleanupPolicy;
  retentionDays: number;
  excludeTools: string[];
  exposure: Exposure;
  intertool: IntertoolConfig;
}

export const DEFAULT_CONFIG: Readonly<HcSubagentsConfig> = Object.freeze({
  maxConcurrency: 4,
  maxDepth: 1,
  defaultMode: "sync",
  startupTimeoutMs: 60_000,
  waitTimeoutMs: 600_000,
  pollIntervalMs: 750,
  killOnAbort: true,
  killOnTimeout: false,
  monitorAfterReturn: false,
  notify: "async",
  agentScope: "user",
  parallelWrites: false,
  cleanup: "keep",
  retentionDays: 14,
  excludeTools: ["hc_subagent", "hc_subagent_control"],
  exposure: "direct",
  intertool: {
    exposeService: true,
    emitEvents: true,
    includeTaskPreview: false,
  },
});

export type ConfigSource = "global" | "project" | "env" | "defaults";

export interface ConfigWarning {
  source: ConfigSource;
  field: string;
  message: string;
  value?: unknown;
}

export type ConfigLayer = Omit<Partial<HcSubagentsConfig>, "intertool"> & {
  intertool?: Partial<IntertoolConfig>;
};

export interface ValidationResult {
  value: ConfigLayer;
  warnings: ConfigWarning[];
}

const AGENT_SCOPES: readonly AgentScope[] = ["user", "project", "both"];
const DEFAULT_MODES: readonly DefaultMode[] = ["sync", "async"];
const NOTIFY_MODES: readonly NotifyMode[] = ["async", "none"];
const CLEANUP_POLICIES: readonly CleanupPolicy[] = ["keep", "remove"];
const EXPOSURES: readonly Exposure[] = ["direct", "model-only"];

export function cloneDefaultConfig(): HcSubagentsConfig {
  return {
    ...DEFAULT_CONFIG,
    excludeTools: [...DEFAULT_CONFIG.excludeTools],
    intertool: { ...DEFAULT_CONFIG.intertool },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateBoolean(
  raw: Record<string, unknown>,
  key: keyof HcSubagentsConfig,
  source: ConfigSource,
  warnings: ConfigWarning[],
): boolean | undefined {
  if (!(key in raw)) return undefined;
  const value = raw[key];
  if (typeof value === "boolean") return value;
  warnings.push({ source, field: key, message: "expected a boolean", value });
  return undefined;
}

function validateInteger(
  raw: Record<string, unknown>,
  key: keyof HcSubagentsConfig,
  source: ConfigSource,
  warnings: ConfigWarning[],
  min: number,
  max: number,
): number | undefined {
  if (!(key in raw)) return undefined;
  const value = raw[key];
  if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) return value;
  warnings.push({ source, field: key, message: `expected an integer between ${min} and ${max}`, value });
  return undefined;
}

function validateEnum<T extends string>(
  raw: Record<string, unknown>,
  key: keyof HcSubagentsConfig,
  source: ConfigSource,
  warnings: ConfigWarning[],
  allowed: readonly T[],
): T | undefined {
  if (!(key in raw)) return undefined;
  const value = raw[key];
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  warnings.push({ source, field: key, message: `expected one of ${allowed.join(", ")}`, value });
  return undefined;
}

function validateStringArray(
  raw: Record<string, unknown>,
  key: keyof HcSubagentsConfig,
  source: ConfigSource,
  warnings: ConfigWarning[],
): string[] | undefined {
  if (!(key in raw)) return undefined;
  const value = raw[key];
  if (!Array.isArray(value)) {
    warnings.push({ source, field: key, message: "expected an array of strings", value });
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (items.length !== value.length) {
    warnings.push({ source, field: key, message: "ignored non-string or empty entries", value });
  }
  return [...new Set(items.map((item) => item.trim()))];
}

function validateIntertool(
  raw: Record<string, unknown>,
  source: ConfigSource,
  warnings: ConfigWarning[],
): Partial<IntertoolConfig> | undefined {
  if (!("intertool" in raw)) return undefined;
  const value = raw.intertool;
  if (!isRecord(value)) {
    warnings.push({ source, field: "intertool", message: "expected an object", value });
    return undefined;
  }
  const result: Partial<IntertoolConfig> = {};
  for (const key of ["exposeService", "emitEvents", "includeTaskPreview"] as const) {
    if (!(key in value)) continue;
    if (typeof value[key] === "boolean") result[key] = value[key];
    else warnings.push({ source, field: `intertool.${key}`, message: "expected a boolean", value: value[key] });
  }
  return result;
}

/** Validate one config layer. Unknown fields are ignored. */
export function validateConfig(raw: unknown, source: ConfigSource): ValidationResult {
  const warnings: ConfigWarning[] = [];
  if (!isRecord(raw)) {
    if (raw !== undefined && raw !== null) {
      warnings.push({ source, field: "<root>", message: "expected a JSON object", value: raw });
    }
    return { value: {}, warnings };
  }

  const value: ConfigLayer = {};
  const integer = (key: keyof HcSubagentsConfig, min: number, max: number) => {
    const parsed = validateInteger(raw, key, source, warnings, min, max);
    if (parsed !== undefined) (value as Record<string, unknown>)[key] = parsed;
  };
  const boolean = (key: keyof HcSubagentsConfig) => {
    const parsed = validateBoolean(raw, key, source, warnings);
    if (parsed !== undefined) (value as Record<string, unknown>)[key] = parsed;
  };
  const enumeration = <T extends string>(key: keyof HcSubagentsConfig, allowed: readonly T[]) => {
    const parsed = validateEnum(raw, key, source, warnings, allowed);
    if (parsed !== undefined) (value as Record<string, unknown>)[key] = parsed;
  };

  integer("maxConcurrency", 1, 16);
  integer("maxDepth", 0, 8);
  integer("startupTimeoutMs", 1_000, 600_000);
  integer("waitTimeoutMs", 1_000, 1_800_000);
  integer("pollIntervalMs", 250, 60_000);
  integer("retentionDays", 0, 3_650);
  boolean("killOnAbort");
  boolean("killOnTimeout");
  boolean("monitorAfterReturn");
  boolean("parallelWrites");
  enumeration("defaultMode", DEFAULT_MODES);
  enumeration("notify", NOTIFY_MODES);
  enumeration("agentScope", AGENT_SCOPES);
  enumeration("cleanup", CLEANUP_POLICIES);
  enumeration("exposure", EXPOSURES);

  const excludeTools = validateStringArray(raw, "excludeTools", source, warnings);
  if (excludeTools !== undefined) value.excludeTools = excludeTools;

  const intertool = validateIntertool(raw, source, warnings);
  if (intertool !== undefined) value.intertool = intertool;

  return { value, warnings };
}

/** Apply one validated layer over a base config. */
export function applyConfigLayer(base: HcSubagentsConfig, layer: ConfigLayer): HcSubagentsConfig {
  return {
    ...base,
    ...layer,
    excludeTools: layer.excludeTools ? [...layer.excludeTools] : [...base.excludeTools],
    intertool: layer.intertool ? { ...base.intertool, ...layer.intertool } : { ...base.intertool },
  };
}

const INTEGER_ENV_FIELDS: Array<{
  env: string;
  field: "maxConcurrency" | "waitTimeoutMs" | "startupTimeoutMs" | "pollIntervalMs";
  min: number;
  max: number;
}> = [
  { env: "PI_HC_SUBAGENTS_MAX_CONCURRENCY", field: "maxConcurrency", min: 1, max: 16 },
  { env: "PI_HC_SUBAGENTS_WAIT_TIMEOUT_MS", field: "waitTimeoutMs", min: 1_000, max: 1_800_000 },
  { env: "PI_HC_SUBAGENTS_STARTUP_TIMEOUT_MS", field: "startupTimeoutMs", min: 1_000, max: 600_000 },
  { env: "PI_HC_SUBAGENTS_POLL_MS", field: "pollIntervalMs", min: 250, max: 60_000 },
];

/** Parse environment overrides. Only the documented variables are honored. */
export function envOverrides(env: NodeJS.ProcessEnv): ValidationResult {
  const warnings: ConfigWarning[] = [];
  const value: ConfigLayer = {};

  for (const { env: name, field, min, max } of INTEGER_ENV_FIELDS) {
    const rawValue = env[name];
    if (rawValue === undefined || rawValue === "") continue;
    const parsed = Number(rawValue);
    if (Number.isInteger(parsed) && parsed >= min && parsed <= max) {
      (value as Record<string, unknown>)[field] = parsed;
    } else {
      warnings.push({
        source: "env",
        field: name,
        message: `expected an integer between ${min} and ${max}`,
        value: rawValue,
      });
    }
  }

  const scope = env.PI_HC_SUBAGENTS_AGENT_SCOPE;
  if (scope !== undefined && scope !== "") {
    if ((AGENT_SCOPES as readonly string[]).includes(scope)) value.agentScope = scope as AgentScope;
    else {
      warnings.push({
        source: "env",
        field: "PI_HC_SUBAGENTS_AGENT_SCOPE",
        message: `expected one of ${AGENT_SCOPES.join(", ")}`,
        value: scope,
      });
    }
  }

  return { value, warnings };
}

export function isDebugEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.PI_HC_SUBAGENTS_DEBUG;
  return value === "1" || value === "true";
}
