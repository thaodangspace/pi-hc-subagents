/**
 * Conservative command allowlist for write-capable child agents.
 *
 * This is a guardrail, not a sandbox: a prefix allowlist cannot prove that a
 * shell command is safe. It rejects any command that could chain, redirect,
 * substitute, or continue onto another command, then accepts only an exact
 * prefix match ("git status" also allows "git status --short").
 */
export const MAX_ALLOWED_COMMANDS = 32;
export const MAX_ALLOWED_COMMAND_LENGTH = 200;

/**
 * Control characters and every shell metacharacter that can introduce a
 * second command, redirection, or substitution. Quotes are allowed so a prefix
 * such as `npm run test -- --grep "unit"` remains usable.
 */
const UNSAFE_SHELL_TEXT = /[\u0000-\u001f\u007f;&|`$<>\\]/;

export function validateAllowedCommand(value: unknown): string | null {
  if (typeof value !== "string") return "allowed command must be a string";
  const command = value.trim();
  if (command.length === 0) return "allowed command must not be empty";
  if (command.length > MAX_ALLOWED_COMMAND_LENGTH) {
    return `allowed command exceeds ${MAX_ALLOWED_COMMAND_LENGTH} characters`;
  }
  if (UNSAFE_SHELL_TEXT.test(command)) {
    return "allowed command must be one command: shell metacharacters are not allowed";
  }
  return null;
}

/** Parse the JSON-encoded child env marker. An invalid value fails closed. */
export function parseAllowedCommands(raw: string | undefined | null): {
  allowed: string[];
  valid: boolean;
} {
  if (typeof raw !== "string" || raw.trim().length === 0) return { allowed: [], valid: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { allowed: [], valid: false };
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_ALLOWED_COMMANDS) {
    return { allowed: [], valid: false };
  }
  const allowed: string[] = [];
  for (const entry of parsed) {
    if (validateAllowedCommand(entry) !== null) return { allowed: [], valid: false };
    allowed.push((entry as string).trim());
  }
  return { allowed, valid: true };
}

export function isCommandAllowed(command: string, allowed: readonly string[]): boolean {
  const value = command.trim();
  if (value.length === 0 || UNSAFE_SHELL_TEXT.test(value)) return false;
  return allowed.some((prefix) => value === prefix || value.startsWith(`${prefix} `));
}
