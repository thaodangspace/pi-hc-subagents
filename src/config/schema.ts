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

/**
 * Model compression for over-budget, handoff-less child reports.
 *
 * `off` keeps the deterministic digest only; `model` allows at most one
 * bounded summarizer call per settled turn.
 */
export type ResultSummarizerMode = "off" | "model";

/**
 * Footer status verbosity.
 *
 * `off` never writes a status, `count` keeps the legacy `N active` string, and
 * `detail` names the single running child and counts blocked children.
 */
export type UiStatusMode = "off" | "count" | "detail";

export interface UiConfig {
  /** Footer status verbosity; never carries task or result text. */
  status: UiStatusMode;
}

export interface IntertoolConfig {
  exposeService: boolean;
  emitEvents: boolean;
  includeTaskPreview: boolean;
}

/**
 * How the parent reaches herdr-core when it is not running inside an `hc`
 * terminal. Inside `hc`, the `HC_TERMINAL_*` environment always wins.
 */
export interface HcConnectionConfig {
  /** Core socket; equivalent to `PI_HC_SUBAGENTS_SOCKET`. Must be absolute. */
  socketPath: string | null;
  /**
   * Anchor terminal for children. When null, children start as root terminals
   * (no hc parent, no die-with-parent). Equivalent to
   * `PI_HC_SUBAGENTS_PARENT_TERMINAL`.
   */
  parentTerminal: string | null;
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
  /** Remove this parent's own finished terminals when a session starts. */
  sweepFinishedTerminals: boolean;
  retentionDays: number;
  /** Wake waiters on the child's settled pipe notification; false is poll-only. */
  wakeOnSettle: boolean;
  /** Compress an over-budget, handoff-less report once per settled turn. */
  resultSummarizer: ResultSummarizerMode;
  excludeTools: string[];
  exposure: Exposure;
  intertool: IntertoolConfig;
  ui: UiConfig;
  hc: HcConnectionConfig;
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
  sweepFinishedTerminals: true,
  retentionDays: 14,
  wakeOnSettle: true,
  resultSummarizer: "off",
  excludeTools: ["hc_subagent", "hc_subagent_control"],
  exposure: "direct",
  intertool: {
    exposeService: true,
    emitEvents: true,
    includeTaskPreview: false,
  },
  ui: {
    status: "detail" as UiStatusMode,
  },
  hc: {
    socketPath: null,
    parentTerminal: null,
  },
});

export type ConfigSource = "global" | "project" | "env" | "defaults";

export interface ConfigWarning {
  source: ConfigSource;
  field: string;
  message: string;
  value?: unknown;
}

export type ConfigLayer = Omit<Partial<HcSubagentsConfig>, "intertool" | "hc" | "ui"> & {
  intertool?: Partial<IntertoolConfig>;
  ui?: Partial<UiConfig>;
  hc?: Partial<HcConnectionConfig>;
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
const RESULT_SUMMARIZER_MODES: readonly ResultSummarizerMode[] = ["off", "model"];
const UI_STATUS_MODES: readonly UiStatusMode[] = ["off", "count", "detail"];

export function cloneDefaultConfig(): HcSubagentsConfig {
  return {
    ...DEFAULT_CONFIG,
    excludeTools: [...DEFAULT_CONFIG.excludeTools],
    intertool: { ...DEFAULT_CONFIG.intertool },
    ui: { ...DEFAULT_CONFIG.ui },
    hc: { ...DEFAULT_CONFIG.hc },
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

function validateOptionalString(
  raw: Record<string, unknown>,
  key: string,
  field: string,
  source: ConfigSource,
  warnings: ConfigWarning[],
  invalid: (value: string) => string | null,
): string | null | undefined {
  if (!(key in raw)) return undefined;
  const value = raw[key];
  if (value === null) return null;
  if (typeof value !== "string") {
    warnings.push({ source, field, message: "expected a string or null", value });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    warnings.push({ source, field, message: "expected a non-empty string or null", value });
    return undefined;
  }
  const problem = invalid(trimmed);
  if (problem !== null) {
    warnings.push({ source, field, message: problem, value });
    return undefined;
  }
  return trimmed;
}

function validateParentTerminal(value: string): string | null {
  if (value.length > 64) return "terminal id is longer than 64 characters";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) return "expected an hc terminal id";
  return null;
}

function validateSocketPath(value: string): string | null {
  // Windows named pipes (M4) are absolute in their own namespace; on Unix a
  // relative socket would depend on the launch directory, so reject it.
  return /^(?:\/|\\\\\.\\pipe\\)/.test(value) ? null : "expected an absolute socket path";
}

function validateHc(
  raw: Record<string, unknown>,
  source: ConfigSource,
  warnings: ConfigWarning[],
): Partial<HcConnectionConfig> | undefined {
  if (!("hc" in raw)) return undefined;
  const value = raw.hc;
  if (!isRecord(value)) {
    warnings.push({ source, field: "hc", message: "expected an object", value });
    return undefined;
  }
  const result: Partial<HcConnectionConfig> = {};
  const socketPath = validateOptionalString(value, "socketPath", "hc.socketPath", source, warnings, validateSocketPath);
  if (socketPath !== undefined) result.socketPath = socketPath;
  const parentTerminal = validateOptionalString(
    value,
    "parentTerminal",
    "hc.parentTerminal",
    source,
    warnings,
    validateParentTerminal,
  );
  if (parentTerminal !== undefined) result.parentTerminal = parentTerminal;
  return result;
}

function validateUi(
  raw: Record<string, unknown>,
  source: ConfigSource,
  warnings: ConfigWarning[],
): Partial<UiConfig> | undefined {
  if (!("ui" in raw)) return undefined;
  const value = raw.ui;
  if (!isRecord(value)) {
    warnings.push({ source, field: "ui", message: "expected an object", value });
    return undefined;
  }
  const result: Partial<UiConfig> = {};
  if ("status" in value) {
    const status = value.status;
    if (typeof status === "string" && (UI_STATUS_MODES as readonly string[]).includes(status)) {
      result.status = status as UiStatusMode;
    } else {
      warnings.push({
        source,
        field: "ui.status",
        message: `expected one of ${UI_STATUS_MODES.join(", ")}`,
        value: status,
      });
    }
  }
  return result;
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
  boolean("sweepFinishedTerminals");
  boolean("wakeOnSettle");
  enumeration("defaultMode", DEFAULT_MODES);
  enumeration("notify", NOTIFY_MODES);
  enumeration("agentScope", AGENT_SCOPES);
  enumeration("cleanup", CLEANUP_POLICIES);
  enumeration("exposure", EXPOSURES);
  enumeration("resultSummarizer", RESULT_SUMMARIZER_MODES);

  const excludeTools = validateStringArray(raw, "excludeTools", source, warnings);
  if (excludeTools !== undefined) value.excludeTools = excludeTools;

  const intertool = validateIntertool(raw, source, warnings);
  if (intertool !== undefined) value.intertool = intertool;

  const ui = validateUi(raw, source, warnings);
  if (ui !== undefined) value.ui = ui;

  const hc = validateHc(raw, source, warnings);
  if (hc !== undefined) value.hc = hc;

  return { value, warnings };
}

/** Apply one validated layer over a base config. */
export function applyConfigLayer(base: HcSubagentsConfig, layer: ConfigLayer): HcSubagentsConfig {
  return {
    ...base,
    ...layer,
    excludeTools: layer.excludeTools ? [...layer.excludeTools] : [...base.excludeTools],
    intertool: layer.intertool ? { ...base.intertool, ...layer.intertool } : { ...base.intertool },
    ui: layer.ui ? { ...base.ui, ...layer.ui } : { ...base.ui },
    hc: layer.hc ? { ...base.hc, ...layer.hc } : { ...base.hc },
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

const BOOLEAN_ENV_FIELDS: Array<{
  env: string;
  field: "wakeOnSettle" | "sweepFinishedTerminals";
}> = [
  { env: "PI_HC_SUBAGENTS_WAKE_ON_SETTLE", field: "wakeOnSettle" },
  { env: "PI_HC_SUBAGENTS_SWEEP_FINISHED_TERMINALS", field: "sweepFinishedTerminals" },
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

  for (const { env: name, field } of BOOLEAN_ENV_FIELDS) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    if (raw === "1" || raw === "true") value[field] = true;
    else if (raw === "0" || raw === "false") value[field] = false;
    else {
      warnings.push({
        source: "env",
        field: name,
        message: "expected 1, true, 0, or false",
        value: raw,
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

  const resultSummarizer = env.PI_HC_SUBAGENTS_RESULT_SUMMARIZER;
  if (resultSummarizer !== undefined && resultSummarizer !== "") {
    if ((RESULT_SUMMARIZER_MODES as readonly string[]).includes(resultSummarizer)) {
      value.resultSummarizer = resultSummarizer as ResultSummarizerMode;
    } else {
      warnings.push({
        source: "env",
        field: "PI_HC_SUBAGENTS_RESULT_SUMMARIZER",
        message: `expected one of ${RESULT_SUMMARIZER_MODES.join(", ")}`,
        value: resultSummarizer,
      });
    }
  }

  const socketPath = env.PI_HC_SUBAGENTS_SOCKET?.trim();
  if (socketPath) {
    const problem = validateSocketPath(socketPath);
    if (problem === null) value.hc = { ...value.hc, socketPath };
    else {
      warnings.push({
        source: "env",
        field: "PI_HC_SUBAGENTS_SOCKET",
        message: problem,
        value: socketPath,
      });
    }
  }

  const parentTerminal = env.PI_HC_SUBAGENTS_PARENT_TERMINAL?.trim();
  if (parentTerminal) {
    const problem = validateParentTerminal(parentTerminal);
    if (problem === null) value.hc = { ...value.hc, parentTerminal };
    else {
      warnings.push({
        source: "env",
        field: "PI_HC_SUBAGENTS_PARENT_TERMINAL",
        message: problem,
        value: parentTerminal,
      });
    }
  }

  return { value, warnings };
}

export function isDebugEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.PI_HC_SUBAGENTS_DEBUG;
  return value === "1" || value === "true";
}
