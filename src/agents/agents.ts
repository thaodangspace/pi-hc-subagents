/**
 * Agent definition discovery.
 *
 * Sources, in increasing precedence: package built-ins, user agents, project
 * agents. Project agents require project trust; when trust is absent they are
 * not loaded at all.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HcSubagentError } from "../core/error.ts";
import { normalizeNewlines, parseAgentFile } from "./frontmatter.ts";

export type AgentSourceKind = "user" | "project" | "package";
export type AgentScope = "user" | "project" | "both";
export type AgentAccess = "read-only" | "write";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: string[];
  model?: string;
  thinking?: ThinkingLevel;
  access: AgentAccess;
  skills?: string[];
  extensions?: string[];
  cwd?: string;
  source: AgentSourceKind;
  filePath: string;
}

export interface AgentWarning {
  filePath: string | null;
  field: string;
  message: string;
}

export interface AgentDiscoveryResult {
  agents: AgentDefinition[];
  projectAgentsDir: string | null;
  userAgentsDir: string;
  packageAgentsDir: string;
  warnings: AgentWarning[];
  projectAgentsSkipped: boolean;
}

export interface AgentSource {
  readonly id: string;
  readonly precedence: number;
  discover(cwd: string): Promise<AgentDefinition[]>;
}

export interface DiscoverAgentsOptions {
  cwd: string;
  scope: AgentScope;
  trusted: boolean;
  agentDir: string;
  packageDir?: string;
  /** Intertool agent sources, merged by precedence. */
  extraSources?: readonly AgentSource[];
  maxDescriptionLength?: number;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const WRITE_TOOLS = new Set(["edit", "write", "bash", "powershell"]);
const DEFAULT_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const NAME_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;

const PACKAGE_AGENTS_DIR = fileURLToPath(new URL("../../agents", import.meta.url));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const items = raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? [...new Set(items)] : undefined;
}

function inferAccess(tools: string[] | undefined, explicit: AgentAccess | undefined): AgentAccess {
  if (explicit) return explicit;
  if (!tools) return "write";
  return tools.some((tool) => WRITE_TOOLS.has(tool)) ? "write" : "read-only";
}

export function hasWriteCapableTools(agent: Pick<AgentDefinition, "tools">): boolean {
  return (agent.tools ?? []).some((tool) => WRITE_TOOLS.has(tool));
}

/** The explicit tool allowlist a read-only child receives. */
export function effectiveAgentTools(agent: AgentDefinition): string[] | undefined {
  if (agent.access === "write") return agent.tools;
  const tools = agent.tools && agent.tools.length > 0 ? agent.tools : DEFAULT_READ_ONLY_TOOLS;
  return tools;
}

export function validateAgentForSpawn(agent: AgentDefinition, options: { trusted: boolean }): void {
  if (agent.access === "read-only" && hasWriteCapableTools(agent)) {
    const offending = (agent.tools ?? []).filter((tool) => WRITE_TOOLS.has(tool));
    throw new HcSubagentError(
      "validation",
      `agent ${agent.name} is read-only but allows write-capable tools: ${offending.join(", ")}`,
    );
  }
  if (agent.source === "project" && !options.trusted) {
    throw new HcSubagentError(
      "project_agent_not_trusted",
      `project agent ${agent.name} requires a trusted project`,
      { hint: "trust this project in pi before using project-local agents" },
    );
  }
}

async function readAgentFile(
  filePath: string,
  source: AgentSourceKind,
  warnings: AgentWarning[],
  maxDescriptionLength: number,
): Promise<AgentDefinition | null> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    warnings.push({ filePath, field: "<file>", message: `cannot read: ${String(error)}` });
    return null;
  }

  const parsed = parseAgentFile(content);
  if (!parsed.ok) {
    warnings.push({ filePath, field: "<frontmatter>", message: parsed.error ?? "invalid YAML" });
    return null;
  }
  const frontmatter = parsed.frontmatter;

  const stem = path.basename(filePath, ".md");
  const rawName = typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name.trim() : stem;
  if (rawName.length > 48 || !NAME_PATTERN.test(rawName)) {
    warnings.push({
      filePath,
      field: "name",
      message: `invalid agent name ${JSON.stringify(rawName)}; expected 1-48 characters matching ${NAME_PATTERN}`,
    });
    return null;
  }

  if (typeof frontmatter.description !== "string" || frontmatter.description.trim().length === 0) {
    warnings.push({ filePath, field: "description", message: "missing required description; agent skipped" });
    return null;
  }
  let description = frontmatter.description.trim();
  if (description.length > maxDescriptionLength) {
    warnings.push({
      filePath,
      field: "description",
      message: `description exceeds ${maxDescriptionLength} characters; truncated for listings`,
    });
    description = description.slice(0, maxDescriptionLength);
  }

  const tools = parseStringList(frontmatter.tools);

  let thinking: ThinkingLevel | undefined;
  if (frontmatter.thinking !== undefined) {
    const raw = frontmatter.thinking;
    if (typeof raw === "string" && (THINKING_LEVELS as readonly string[]).includes(raw)) {
      thinking = raw as ThinkingLevel;
    } else {
      warnings.push({
        filePath,
        field: "thinking",
        message: `invalid thinking level ${JSON.stringify(raw)}; inheriting the child default`,
      });
    }
  }

  let access: AgentAccess | undefined;
  if (frontmatter.access !== undefined) {
    if (frontmatter.access === "read-only" || frontmatter.access === "write") {
      access = frontmatter.access;
    } else {
      warnings.push({
        filePath,
        field: "access",
        message: `invalid access ${JSON.stringify(frontmatter.access)}; inferring from tools`,
      });
    }
  }

  let model: string | undefined;
  if (frontmatter.model !== undefined) {
    if (typeof frontmatter.model === "string" && frontmatter.model.trim().length > 0) {
      model = frontmatter.model.trim();
      if (!model.includes("/")) {
        warnings.push({
          filePath,
          field: "model",
          message: "model should look like provider/model; passing it through to pi",
        });
      }
    } else {
      warnings.push({ filePath, field: "model", message: "invalid model; inheriting the parent default" });
    }
  }

  const skills = parseStringList(frontmatter.skills);
  const extensions = parseStringList(frontmatter.extensions);

  let cwd: string | undefined;
  if (frontmatter.cwd !== undefined) {
    if (typeof frontmatter.cwd === "string" && frontmatter.cwd.trim().length > 0) cwd = frontmatter.cwd.trim();
    else warnings.push({ filePath, field: "cwd", message: "invalid cwd; using the parent cwd" });
  }

  return {
    name: rawName,
    description,
    systemPrompt: normalizeNewlines(parsed.body).trim(),
    ...(tools === undefined ? {} : { tools }),
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
    access: inferAccess(tools, access),
    ...(skills === undefined ? {} : { skills }),
    ...(extensions === undefined ? {} : { extensions }),
    ...(cwd === undefined ? {} : { cwd }),
    source,
    filePath,
  };
}

async function loadAgentsFromDir(
  dir: string | null,
  source: AgentSourceKind,
  warnings: AgentWarning[],
  maxDescriptionLength: number,
): Promise<AgentDefinition[]> {
  if (!dir) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const agents: AgentDefinition[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const agent = await readAgentFile(path.join(dir, entry.name), source, warnings, maxDescriptionLength);
    if (agent) agents.push(agent);
  }
  return agents;
}

export async function findNearestProjectAgentsDir(cwd: string): Promise<string | null> {
  let current = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(current, ".pi", "agents");
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch {
      // keep walking
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function discoverAgents(options: DiscoverAgentsOptions): Promise<AgentDiscoveryResult> {
  const warnings: AgentWarning[] = [];
  const maxDescriptionLength = options.maxDescriptionLength ?? 200;
  const userDir = path.join(options.agentDir, "agents");
  const packageDir = options.packageDir ?? PACKAGE_AGENTS_DIR;
  const projectDir = options.scope === "user" ? null : await findNearestProjectAgentsDir(options.cwd);

  const packageAgents = await loadAgentsFromDir(packageDir, "package", warnings, maxDescriptionLength);
  const userAgents =
    options.scope === "project"
      ? []
      : await loadAgentsFromDir(userDir, "user", warnings, maxDescriptionLength);

  let projectAgents: AgentDefinition[] = [];
  let projectAgentsSkipped = false;
  if (projectDir) {
    if (options.trusted) {
      projectAgents = await loadAgentsFromDir(projectDir, "project", warnings, maxDescriptionLength);
    } else {
      projectAgentsSkipped = true;
      warnings.push({
        filePath: projectDir,
        field: "<source>",
        message: "project agents ignored because the project is not trusted",
      });
    }
  }

  const extraLayers: Array<{ agents: AgentDefinition[]; precedence: number; index: number }> = [];
  for (const [index, source] of (options.extraSources ?? []).entries()) {
    let agents: AgentDefinition[] = [];
    try {
      agents = await source.discover(options.cwd);
    } catch (error) {
      warnings.push({
        filePath: null,
        field: `<source:${source.id}>`,
        message: `agent source failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    extraLayers.push({ agents, precedence: source.precedence, index });
  }

  const byName = new Map<string, AgentDefinition>();
  const layers: Array<{ agents: AgentDefinition[] }> = [
    { agents: packageAgents },
    { agents: userAgents },
    { agents: projectAgents },
    ...extraLayers
      .sort((a, b) => a.precedence - b.precedence || a.index - b.index)
      .map((layer) => ({ agents: layer.agents })),
  ];
  for (const layer of layers) {
    for (const agent of layer.agents) {
      const previous = byName.get(agent.name);
      if (previous) {
        warnings.push({
          filePath: agent.filePath,
          field: "name",
          message: `duplicate agent ${agent.name} from ${agent.source} overrides ${previous.source}`,
        });
      }
      byName.set(agent.name, agent);
    }
  }

  return {
    agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    projectAgentsDir: projectDir,
    userAgentsDir: userDir,
    packageAgentsDir: packageDir,
    warnings,
    projectAgentsSkipped,
  };
}

export function resolveAgent(result: AgentDiscoveryResult, name: string): AgentDefinition {
  const agent = result.agents.find((candidate) => candidate.name === name);
  if (!agent) {
    const available = result.agents.map((candidate) => candidate.name).join(", ") || "none";
    throw new HcSubagentError("not_found", `unknown agent "${name}"; available: ${available}`, {
      hint: "create ~/.pi/agent/agents/<name>.md",
    });
  }
  return agent;
}

export function formatAgentList(agents: AgentDefinition[], maxItems = 40): { text: string; remaining: number } {
  if (agents.length === 0) return { text: "none", remaining: 0 };
  const listed = agents.slice(0, maxItems);
  return {
    text: listed.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("; "),
    remaining: agents.length - listed.length,
  };
}
