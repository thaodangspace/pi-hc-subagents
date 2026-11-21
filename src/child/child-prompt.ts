/**
 * Task and system prompt content for a child run.
 *
 * The task is user/model-authored data. It is written to a 0600 file and passed
 * as `@task.md`; it is never interpolated into a shell line.
 */

export const DELEGATION_CONTRACT = `You are a delegated subagent in a separate pi session.
Complete the task autonomously. Your caller sees only your final message, not your session.
Do not spawn subagents. Do not ask for confirmation unless truly blocked.
If you need a human decision, stop and state exactly what you need.
Stay within the assigned files and scope.

## Report contract
End your final message with one handoff section and nothing after it:

## Handoff
### Status
one line: done | done-with-caveats | blocked | failed
### Changed
- path/to/file.ext:LINE — what changed and why
### Findings
- what the caller must know to act: facts, decisions, risks
### Next step
one concrete action, or "none"

- Keep the whole final message within ~1500 tokens (about 6 KiB).
- If Findings would exceed that, keep the most important items and add "(more in the session file)".
- If no files changed, write "(no files changed)" under ### Changed.
- Never paste file contents, diffs, logs, command output, or JSON blobs.
  Reference paths, line numbers, and commands instead.
- No progress narration and no restating of the task.`;

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
