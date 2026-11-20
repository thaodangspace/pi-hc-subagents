# pi-hc-subagents

Delegate self-contained tasks from a [pi](https://pi.dev) session to **interactive pi
subagents** running in [herdr-core (`hc`)](https://herdr.dev) terminals.

The parent stays the orchestrator. Each child gets an isolated context window, a real
terminal a human can attach to, and a normal pi session file that is the authoritative
source of the final result.

## Status

Milestones 1 and 2 are implemented (phases 1–12 of the implementation plan):
synchronous and background delegation, the notifier queue, status widget, project
agents with trust/confirmation, the intertool service v1, and run persistence,
resume reconciliation, and retention.

Milestone 3 (parallel tasks, chain, private-pipe follow-ups, providers/result
adapters) is not implemented yet. The tool schema intentionally omits those fields.

See [`SPEC.md`](./SPEC.md) for the contract and [`PLAN.md`](./PLAN.md) for the research
and design record.

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
  - `background` — return as soon as the child starts; the result arrives later as a
    custom message (default: `config.defaultMode === "async"`).
  - `agentScope` — `user`, `project`, or `both` (default: configured `agentScope`).
  - `confirmProjectAgents` — project agents prompt by default; pass `false` only when the
    user already approved them.
- `hc_subagent_control` — `list`, `wait`, `output`, `result`, `attach`, `interrupt`, `kill`.
  `send` is intentionally absent until the M3 private pipe exists.

Outside an `hc` terminal the tools are not registered; `/hc-subagents` prints setup
instructions instead.

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

Service methods: `list`, `get`, `spawn`, `wait`, `cancel`, `subscribe`, and
`registerAgentSource`. `capabilities.features` never advertises an unimplemented
feature (no `send` in M2).

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

M2 coverage includes notifier dedupe/queue/retry/batching, widget formatting and clear
behavior, project-agent trust policy, event privacy and subscriber isolation, async
background delivery against a fake child, intertool spawn/list/wait/cancel/idempotency,
and resume isolation/retention with an injected clock.

## Safety invariants

- Child output is labelled as untrusted data and is never executed.
- The extension never sends `force` or answers a blocked dialog.
- Children are parented to the parent terminal and are killed on parent shutdown.
- Spawns use argv, never a shell line; task/system files are `0600`, run dirs `0700`.
- The intertool service is in-process only and applies the same trust and concurrency
  rules as the tools.
- Integration tests use an isolated `HC_SESSION` and scratch XDG paths.

## Limitations

- Reloading the extension tears down the previous session's monitors and kills the
  children it owned; background monitoring does not survive `/reload` or a session
  switch.
- No Windows/remote `hc` support (M4), no parallel/chain/follow-up (M3).
- `monitorAfterReturn` is accepted in config but not used until follow-up turns exist.
