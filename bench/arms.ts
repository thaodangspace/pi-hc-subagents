/**
 * Arm definitions.
 *
 * Fairness rules this file enforces:
 * - `solo` and `transcript` get the exact same system prompt (agent body plus
 *   the delegation contract) and tool allowlist as the child in `subagent`,
 *   so the only difference is which session holds the exploration tokens.
 * - `subagent` is a real parent pi with only the delegation tools enabled, so
 *   it cannot silently do the work itself.
 * - Every arm runs with extensions, skills, context files, MCP, and prompt
 *   templates disabled except for the explicit `-e index.ts` in `subagent`.
 */
import type { Arm, TaskSpec, TaskSuite } from "./types.ts";

export interface ArmInput {
  arm: Arm;
  suite: TaskSuite;
  task: TaskSpec;
  model: string;
  thinking?: string | null;
  piPath: string;
  extensionPath: string;
  sessionDir: string;
  systemFile: string;
  runName: string;
  /** Model for the delegated child; pinning it keeps both arms on one model. */
  childModel?: string | null;
  transcript?: string;
}

export interface ArmInvocation {
  argv: string[];
  prompt: string;
}

export const SUBAGENT_TOOLS = ["hc_subagent", "hc_subagent_control"];

export const ORCHESTRATOR_PROMPT = `You are the orchestrator for a delegated task.
Call hc_subagent exactly once with the arguments given in the message: same agent,
same model, and the task text unchanged. Then reply with the subagent's final text
verbatim. Do not do the work yourself, do not call any other tool, and do not add
commentary.`;

function baseFlags(input: ArmInput): string[] {
  return [
    input.piPath,
    "--print",
    "--model",
    input.model,
    ...(input.thinking ? ["--thinking", input.thinking] : []),
    "--session-dir",
    input.sessionDir,
    "--name",
    input.runName,
    // Parity rule: the child receives project context files and skills from
    // pi's normal discovery (the extension only adds --tools and a system
    // prompt), so the baseline arms must load them too. Disabling them here
    // made the child carry AGENTS.md while `solo` did not, which biased cost.
    // --no-extensions stays: a user-installed extension would otherwise hand
    // `solo` the delegation tool and break the treatment.
    "--no-extensions",
    "--no-mcp",
    "--no-prompt-templates",
  ];
}

export function buildArmInvocation(input: ArmInput): ArmInvocation {
  const prompt = input.task.prompt;

  if (input.arm === "subagent" || input.arm === "routing") {
    // `routing` runs the same delegation as `subagent` with a different child
    // model. Everything else — prompt, tools, flags, context parity — is
    // identical so the child model is the only experimental variable.
    const delegation = [
      "Call hc_subagent once with exactly these arguments, then reply with the subagent's final text verbatim.",
      "",
      `- agent: ${input.suite.agent}`,
      ...(input.childModel ? [`- model: ${input.childModel}`] : []),
      `- task: ${prompt}`,
      "",
      "Do not read files yourself and do not add commentary.",
    ].join("\n");
    return {
      argv: [
        ...baseFlags(input),
        "-e",
        input.extensionPath,
        "--tools",
        SUBAGENT_TOOLS.join(","),
        "--append-system-prompt",
        ORCHESTRATOR_PROMPT,
        "--",
        delegation,
      ],
      prompt: delegation,
    };
  }

  if (input.arm === "transcript") {
    const transcript = input.transcript?.trim() ?? "";
    const delegated = transcript.length > 0
      ? `${prompt}\n\nAnother agent already explored this workspace. Its transcript is below; use it instead of re-reading everything.\n\n<transcript>\n${transcript}\n</transcript>`
      : prompt;
    return {
      argv: [
        ...baseFlags(input),
        "--tools",
        input.suite.tools.join(","),
        "--append-system-prompt",
        input.systemFile,
        "--",
        delegated,
      ],
      prompt: delegated,
    };
  }

  return {
    argv: [
      ...baseFlags(input),
      "--tools",
      input.suite.tools.join(","),
      "--append-system-prompt",
      input.systemFile,
      "--",
      prompt,
    ],
    prompt,
  };
}
