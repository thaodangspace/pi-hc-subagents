/**
 * Project-agent authorization.
 *
 * Project agents always require a trusted project. By default they also require
 * an explicit confirmation when UI is available. A caller may pre-approve them
 * (`confirmProjectAgents: false` or `allowTrustedProjectAgents: true`), but it
 * cannot bypass trust. Background callers without UI are rejected rather than
 * prompting.
 */
import type { AgentDefinition } from "./agents.ts";
import { HcSubagentError } from "../core/error.ts";

export interface ProjectAgentPolicy {
  trusted: boolean;
  /** Caller explicitly pre-approved trusted project agents. */
  allowWithoutPrompt: boolean;
  hasUI: boolean;
  confirm?: (agent: AgentDefinition) => Promise<boolean>;
}

export async function authorizeProjectAgent(agent: AgentDefinition, policy: ProjectAgentPolicy): Promise<void> {
  if (agent.source !== "project") return;
  if (!policy.trusted) {
    throw new HcSubagentError("project_agent_not_trusted", `project agent ${agent.name} requires a trusted project`, {
      hint: "trust this project in pi before using project-local agents",
    });
  }
  if (policy.allowWithoutPrompt) return;
  if (!policy.hasUI || !policy.confirm) {
    throw new HcSubagentError(
      "project_agent_not_trusted",
      `project agent ${agent.name} requires confirmation, but no UI is available`,
      { hint: "pass confirmProjectAgents:false only when you trust this project" },
    );
  }
  const approved = await policy.confirm(agent).catch(() => false);
  if (!approved) {
    throw new HcSubagentError(
      "project_agent_not_trusted",
      `project agent ${agent.name} was not confirmed`,
      { hint: "approve the confirmation dialog or use a user agent" },
    );
  }
}
