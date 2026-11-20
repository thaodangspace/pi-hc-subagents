# pi-hc-subagents

Delegate self-contained tasks from a [pi](https://pi.dev) session to **interactive pi
subagents** running in [herdr-core (`hc`)](https://herdr.dev) terminals.

The parent stays the orchestrator. Each child gets an isolated context window, a real
terminal a human can attach to, and a normal pi session file that is the authoritative
source of the final result.

## Status

Phases 1–15 of the implementation plan are implemented: synchronous and background
delegation, parallel `tasks`, sequential `chain`, private-pipe follow-ups with `send`,
the notifier queue, status widget, project agents with trust/confirmation, the intertool
service v1, run persistence/recovery/retention, provider and result-adapter extension
points, and the release hardening checks.

Release candidate: `pi-hc-subagents` 0.2.0-rc.1. See [`SPEC.md`](./SPEC.md) for the contract,
[`PLAN.md`](./PLAN.md) for the research record, and [`AGENTS.md`](./AGENTS.md) for the
module map and invariants.

## Requirements

- Node.js >= 22
- pi >= 1.5.0
- herdr-core (`hc`) >= 0.1.16, tested against 0.1.21
- pi must run **inside** an `hc` terminal (`HC_TERMINAL_ID` and `HC_TERMINAL_SOCKET` set)

## Install (development)

```bash
npm install
npm run typecheck
npm test
```

Load explicitly while developing:

```bash
hc run --bg --name pi pi -e ./index.ts
```

## Tools

- `hc_subagent` — spawn one child and either wait for its result or return immediately.
  - `agent`, `task`, `cwd`, `model`, `thinking`, `timeoutMs`
  - `tasks` — run 1–8 children concurrently (read-only work; write-capable children in
    the same cwd are queued by `parallelWrites`).
  - `chain` — run 1–8 steps sequentially; `{previous}` in a step task is replaced with
    the previous step's bounded final text. Stops at the first failed step.
  - `background` — return as soon as the child starts; the result arrives later as a
    custom message (default: `config.defaultMode === "async"`). Single mode only.
  - `agentScope` — `user`, `project`, or `both` (default: configured `agentScope`).
  - `confirmProjectAgents` — project agents prompt by default; pass `false` only when the
    user already approved them.
- `hc_subagent_control` — `list`, `wait`, `output`, `result`, `attach`, `interrupt`, `kill`,
  `send`. `send` requires the child-side private pipe and appends a new turn; `wait`
  defaults to true. A blocked child is rejected, never force-answered.

`tasks`/`chain` summaries stay compact; full per-task results are in
`details.results[]`. Every child still gets its own terminal, session, and run record.

Outside an `hc` terminal the tools are not registered; `/hc-subagents` prints setup
instructions instead.

## Private follow-up pipe

Children are started with the package's `child.ts` extension (`-e`) and a per-child
Unix socket under `/tmp` (`PI_HC_PIPE`, mode `0600`). `hc_subagent_control send` (and the
intertool `send` method) delivers follow-ups through that socket using
`pi.sendUserMessage` with `deliverAs: "steer"` while streaming or a new turn while idle.
The PTY remains a human channel: the extension never types into it, never sends `force`,
and never answers a permission dialog. The child labels its terminal
`pi-hc-session=<session file>` and does not register `hc_subagent*` tools.

## Async delivery

Background children are monitored by a per-child poller using the same state machine as
the synchronous path. On settlement the extension publishes `result.json`, then sends a
custom `hc-subagent-result` message:

- idle parent → `{ triggerTurn: true }` so the parent wakes up;
- streaming parent → `{ deliverAs: "steer" }`;
- busy/compacting parent → queued and retried on `agent_settled`/`session_compact`;
- blocked children → exactly one actionable notification per blocked episode, including
  the kind, message, attach command, and a bounded screen tail. The extension never
  answers or forces the dialog.

Notifications are deduplicated by `(childId, turn, type)`, batched to at most three per
delivery, and collapsed into a bounded summary with child IDs/paths on overflow. Child
results are never sent with `sendUserMessage`.

## UI

While children are active, the footer shows `N active` and the widget above the editor
shows one line per child (agent, state, duration, model/blocked kind, cwd), capped at six
lines. Neither contains task or result text. The widget clears when no child is active.

`/hc-subagents` supports:

```text
/hc-subagents                 list current children
/hc-subagents list
/hc-subagents attach <id>     print `hc attach ...`
/hc-subagents result <id>     print the last settled result
/hc-subagents kill <id>       interrupt and kill a child
/hc-subagents config          effective config, agent dirs, hc version
```

When no id is given and UI is available, the command prompts with a selector. In
RPC/print mode it prints plain text instead.

## Configuration

Global: `~/.pi/agent/hc-subagents.json`. Project: `<cwd>/.pi/hc-subagents.json` (trusted
projects only). Environment overrides use the `PI_HC_SUBAGENTS_*` prefix.

Run `/hc-subagents config` to print the effective configuration and agent directories.

Relevant M2 keys: `defaultMode`, `notify`, `retentionDays`, `intertool.exposeService`,
`intertool.emitEvents`, `intertool.includeTaskPreview`, and the existing concurrency,
polling, and timeout values.

## Agents

Built-in agents: `reviewer` and `scout` (read-only), `worker` (write-capable). User agents
live in `~/.pi/agent/agents/*.md`; project agents live in `.pi/agents/*.md` and require:

1. a trusted project, and
2. confirmation through the UI (or an explicit `confirmProjectAgents: false` /
   `allowTrustedProjectAgents: true` from a caller that already has approval).

Without UI, an unapproved project agent is rejected explicitly rather than prompted.

## Intertool API v1

Another extension can reach the service without importing internals:

```ts
const service = (globalThis as any)[Symbol.for("pi-hc-subagents.service.v1")];
if (!service) {
  const off = pi.events.on("hc-subagents:ready", ({ service }) => { /* use it */ });
}
```

Service methods: `list`, `get`, `spawn`, `wait`, `send`, `cancel`, `subscribe`,
`registerAgentSource`, `registerProvider`, and `registerResultAdapter`.
`capabilities.features` never advertises an unimplemented feature. `send` verifies that
the child belongs to the current parent session and rejects blocked children.

Events are emitted on `pi.events` and delivered to service subscribers:

```text
hc-subagents:ready
hc-subagents:shutdown
hc-subagents:child.spawned
hc-subagents:child.status
hc-subagents:child.blocked
hc-subagents:child.settled
hc-subagents:child.failed
hc-subagents:child.removed
```

Payloads carry a monotonic `seq`, identifiers, state, and paths; task/result text is
excluded unless `intertool.includeTaskPreview` opts into a 200-character task preview on
`spawned`. Throwing subscribers are isolated. Events are not replayed; late subscribers
should call `list()` to reconcile.

`spawn` accepts `origin` (recorded in `run.json`) and `clientRequestId` (idempotency key
per origin, cached for five minutes). Reusing an id with different input is rejected.

## Providers and result adapters

The intertool service exposes two extension points for new backends. Registration is
trusted in-process code, so review any provider/adapter you load; it expands the attack
surface and must not bypass `ProviderHost` validation.

```ts
const service = (globalThis as any)[Symbol.for("pi-hc-subagents.service.v1")];
const offProvider = service.registerProvider({
  id: "my-backend",
  canHandle: (request) => request.backend === "my-backend",
  async spawn(request, host) {
    const agent = await host.resolveAgent(request.agent, request.agentScope);
    await host.assertProjectTrust(agent);            // trust + confirmation policy
    const cwd = host.resolveCwd(request.cwd ?? agent.cwd);
    const release = await host.acquireConcurrencySlot({
      write: agent.access === "write",
      cwd,
      signal: request.signal,
    });
    try {
      // The returned child owns the slot and must call release() exactly once on
      // settle/cancel; release here only when start fails.
      return await myBackend.start(request, agent, cwd, release);
    } catch (error) {
      release();
      throw error;
    }
  },
});

const offAdapter = service.registerResultAdapter({
  id: "my-result",
  canHandle: ({ provider }) => provider === "my-backend",
  async read({ childId, runId, terminal }) {
    return { childId, runId, terminal, state: "completed", outcome: "stop", text };
  },
});
```

Selection rules:

- Omitted `backend` (and `backend: "hc-local"`) selects the built-in local provider.
- The first registered provider whose `canHandle` returns true wins; an unknown backend
  fails with `unsupported_backend`.
- Custom result adapters run before the built-in `PiSessionResultAdapter` fallback.
- A throwing provider/adapter is contained: the service marks the run failed and returns
  a structured failure instead of crashing the parent.
- Providers still go through the same agent discovery, project trust/confirmation,
  concurrency, cwd validation, and run recording rules as the tools.

At startup the extension registers `HcLocalProvider` and `PiSessionResultAdapter`.
`registerProvider`/`registerResultAdapter` return unregister functions; duplicate ids are
rejected.

## Persistence, resume, and retention

- `run.json` keeps immutable spawn metadata plus a bounded current summary; `result.json`
  holds the latest terminal turn (up to 10 MiB, `textTruncated` beyond that).
- Session entries written with `pi.appendEntry` contain IDs, paths, states, usage, and
  timestamps only — never task or result text.
- On resume, records are restored from this parent's session entries and `run.json`.
  Children from another parent session are never adopted. A recorded child whose
  terminal is gone becomes `failed` with `outcome: "exited"`, or keeps the published
  result if `result.json` exists. No reattachment by terminal name.
- Retention (`retentionDays`, default 14) deletes expired runs that are inactive and
  whose terminal is not live. `0` disables cleanup.

## Tests

```bash
npm test                 # unit tests (node:test)
npm run test:contract    # pinned hc schema contract
npm run test:integration # isolated hc core; skipped when hc is unavailable
npm run test:all
```

M3 coverage includes scheduler concurrency/write serialization, parallel partial
failure, chain `{previous}` substitution and stop-on-failure, pipe framing/permissions/
stale sockets/blocked/timeout/shutdown, child-extension delivery, and follow-up turn
accounting against a fake pipe child. Phase 15 adds provider/adapter registration and
failure containment, result-adapter selection, the `PiSessionResultAdapter`, and security
checks for redaction, file modes, and force prevention.

## Safety invariants

- Child output is labelled as untrusted data and is never executed.
- The extension never sends `force` or answers a blocked dialog.
- Children are parented to the parent terminal and are killed on parent shutdown.
- Spawns use argv, never a shell line; task/system files are `0600`, run dirs `0700`.
- The intertool service is in-process only and applies the same trust and concurrency
  rules as the tools.
- Provider and result-adapter registration is trusted code; review it before loading and
  require it to use `ProviderHost` validation.
- Integration tests use an isolated `HC_SESSION` and scratch XDG paths.

## Packaging and release checks

```bash
npm pack --dry-run            # inspect the published file list
npm pack                     # produce pi-hc-subagents-0.2.0-rc.1.tgz
npm test && npm run test:contract && npm run test:integration
```

CI runs typecheck, unit tests, and the pinned hc contract test on macOS and Linux (Node
22 and 24), and integration tests on Linux when `hc` is available. The package loads via
`pi.events`/`session_start`; there is no build step (TypeScript is loaded directly).

## Limitations

- Reloading the extension tears down the previous session's monitors and kills the
  children it owned; background monitoring does not survive `/reload` or a session
  switch.
- No Windows/remote `hc` support (M4). The private pipe is Unix-only until named pipes
  and ConPTY are added, and the built-in provider is local-only. Custom providers can be
  registered through the intertool service, but remote `hc` transport is not shipped.
- A follow-up needs a child started with the current package's `child.ts`; restored
  pre-M3/older children report `unavailable` instead of falling back to PTY input.
- `monitorAfterReturn` is accepted in config but not used until a timeout keeps a
  monitor alive.
