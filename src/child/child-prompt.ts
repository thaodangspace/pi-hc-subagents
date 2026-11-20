/**
 * Task and system prompt content for a child run.
 *
 * The task is user/model-authored data. It is written to a 0600 file and passed
 * as `@task.md`; it is never interpolated into a shell line.
 */

export const DELEGATION_CONTRACT = `You are a delegated subagent in a separate pi session.
Complete the task autonomously. Your final assistant message is the result;
make it self-contained and concise.
Do not spawn subagents. Do not ask for confirmation unless truly blocked.
If you need a human decision, stop and state exactly what you need.
Stay within the assigned files and scope.`;

export interface TaskFileInput {
  task: string;
  parentSessionId: string;
  cwd: string;
  agentName: string;
  runId: string;
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function buildTaskFile(input: TaskFileInput): string {
  return [
    "# Delegated task",
    "",
    normalize(input.task).trim(),
    "",
    "## Context",
    "",
    `- Parent session: ${input.parentSessionId}`,
    `- Working directory: ${input.cwd}`,
    `- Agent: ${input.agentName}`,
    `- Run: ${input.runId}`,
    "",
  ].join("\n");
}

export function buildSystemFile(agentSystemPrompt: string): string {
  const prompt = normalize(agentSystemPrompt).trim();
  if (prompt.length === 0) return `${DELEGATION_CONTRACT}\n`;
  return `${prompt}\n\n---\n\n## Delegation contract\n\n${DELEGATION_CONTRACT}\n`;
}
