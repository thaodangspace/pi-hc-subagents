/**
 * Optional child-side entry (Milestone 3).
 *
 * Loaded explicitly by the parent as `-e <package>/child.ts`. It starts the
 * private follow-up pipe, labels the terminal with its session file, and
 * delivers messages through `pi.sendUserMessage`. It never registers
 * `hc_subagent*` tools, never answers a dialog, and never uses PTY input.
 */
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createCoreClient } from "./src/core/core-client.ts";
import { isCommandAllowed, parseAllowedCommands } from "./src/child/command-allowlist.ts";
import { parseSessionFile } from "./src/child/session-read.ts";
import { PipeRequestError, startChildPipeServer, type ChildPipeServer } from "./src/child/pipe-server.ts";
import { NOTIFICATION_VERSION, validatePipeName } from "./src/child/pipe-protocol.ts";

export default function childPipeExtension(pi: ExtensionAPI): void {
  const pipeName = process.env.PI_HC_PIPE ?? "";
  if (process.env.PI_HC_SUBAGENT !== "1") return;
  if (validatePipeName(pipeName) !== null) return;

  // A write-capable agent can declare a conservative bash/powershell prefix
  // allowlist. An invalid marker fails closed: every shell call is blocked.
  const commandPolicy = parseAllowedCommands(process.env.PI_HC_ALLOWED_COMMANDS);
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event) && !isToolCallEventType("powershell", event)) return;
    if (!commandPolicy.valid) {
      return {
        block: true,
        reason: "this child has an invalid command allowlist; refusing shell commands",
      };
    }
    if (commandPolicy.allowed.length === 0) return;
    const command = typeof event.input.command === "string" ? event.input.command : "";
    if (isCommandAllowed(command, commandPolicy.allowed)) return;
    const preview = commandPolicy.allowed.slice(0, 6).join(", ");
    const more = commandPolicy.allowed.length > 6 ? ` (+${commandPolicy.allowed.length - 6} more)` : "";
    return {
      block: true,
      reason: `command is not in this agent's allowedCommands allowlist (allowed prefixes: ${preview}${more})`,
    };
  });

  const core = createCoreClient(process.env);
  let ctx: ExtensionContext | null = null;
  let server: ChildPipeServer | null = null;
  let starting: Promise<void> | null = null;
  let blockedKind: string | null = null;
  let sessionFile: string | null = null;

  function currentSessionFile(): string | null {
    const file = ctx?.sessionManager.getSessionFile();
    if (typeof file === "string" && file.length > 0) sessionFile = file;
    return sessionFile;
  }

  function labelSession(): void {
    const file = currentSessionFile();
    const terminal = core.caller;
    if (!file || !terminal) return;
    void core.label(terminal, { "pi-hc-session": file }).catch(() => {});
  }

  function rememberContext(context: ExtensionContext): void {
    ctx = context;
    labelSession();
  }

  async function terminalTurn(): Promise<number> {
    const terminal = core.caller ? await core.tryGet(core.caller).catch(() => null) : null;
    return terminal?.turn ?? 0;
  }

  async function blockedState(): Promise<{ kind?: string } | null> {
    const terminal = core.caller ? await core.tryGet(core.caller).catch(() => null) : null;
    if (terminal?.status?.state === "blocked") {
      const kind = terminal.status.kind ?? blockedKind ?? undefined;
      return kind ? { kind } : {};
    }
    return blockedKind ? { kind: blockedKind } : null;
  }

  function assertNotBlocked(state: { kind?: string } | null): void {
    if (!state) return;
    throw new PipeRequestError("blocked", "the child is waiting for a human decision", {
      kind: state.kind ?? "permission",
      hint: "attach to the child terminal and answer; the parent never forces input",
    });
  }

  function deliver(text: string, steer: boolean): void {
    if (!ctx) throw new PipeRequestError("unavailable", "the child session is not ready");
    if (ctx.isIdle()) {
      pi.sendUserMessage(text);
      return;
    }
    pi.sendUserMessage(text, { deliverAs: steer ? "steer" : "followUp" });
  }

  async function ensureServer(context: ExtensionContext): Promise<void> {
    if (server || starting) {
      await starting?.catch(() => {});
      return;
    }
    starting = startChildPipeServer({
      name: pipeName,
      handlers: {
        ping: async () => ({ turn: await terminalTurn() }),
        prompt: async (text) => {
          assertNotBlocked(await blockedState());
          deliver(text, false);
          return { turn: await terminalTurn() };
        },
        followUp: async (text, steer) => {
          assertNotBlocked(await blockedState());
          deliver(text, steer);
          return { turn: await terminalTurn() };
        },
        interrupt: async () => {
          context.abort();
          return { turn: await terminalTurn() };
        },
        shutdown: async () => {
          setTimeout(() => {
            try {
              context.shutdown();
            } catch {
              // already shutting down
            }
          }, 25);
          return {};
        },
        result: async () => {
          const file = currentSessionFile();
          if (!file) throw new PipeRequestError("not_settled", "the child has no session file yet");
          const parsed = await parseSessionFile(file, { turnStartedAtMs: 0, final: false });
          return {
            text: parsed.text,
            state: parsed.state,
            outcome: parsed.outcome,
            usage: parsed.usage,
            sessionFile: file,
          };
        },
      },
    })
      .then((started) => {
        server = started;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (context.hasUI) context.ui.notify(`hc-subagents child pipe unavailable: ${message}`, "warning");
      })
      .finally(() => {
        starting = null;
      });
    await starting;
  }

  pi.on("session_start", async (_event, context) => {
    rememberContext(context);
    await ensureServer(context);
    labelSession();
  });

  pi.on("turn_start", (_event, context) => {
    rememberContext(context);
  });

  pi.on("agent_settled", async (event) => {
    labelSession();
    const running = server;
    if (!running) return;
    // `at` is child-clock and only used for coarse staleness; `turn` orders hints.
    const at = new Date().toISOString();
    running.broadcast({
      type: "settled",
      v: NOTIFICATION_VERSION,
      turn: await terminalTurn(),
      status: event.aborted ? "aborted" : "completed",
      sessionFile: currentSessionFile(),
      at,
    });
  });

  pi.on("ui_prompt_start", (event) => {
    blockedKind = event.kind;
  });

  pi.on("ui_prompt_end", () => {
    blockedKind = null;
  });

  pi.on("session_shutdown", async () => {
    const running = server;
    server = null;
    starting = null;
    await running?.stop().catch(() => {});
  });
}
