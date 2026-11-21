# AGENTS.md

Repository guide for coding agents working on `pi-hc-subagents`.

## What this package is

A pi extension that delegates self-contained tasks to interactive pi subagents running in
herdr-core (`hc`) terminals. The parent is an orchestrator; the child owns a real
terminal, an isolated context, and an authoritative pi session JSONL. The extension never
scrapes the screen for a final answer and never answers permission dialogs.

## Commands

```bash
npm install
npm run typecheck
npm test                 # unit tests (node:test)
npm run test:contract    # pinned hc schema contract
npm run test:integration # isolated hc core; skips when hc is unavailable
npm run test:all
npm run bench            # opt-in live benchmark, requires BENCH_LIVE_MODEL=1 and BENCH_MODEL
npm pack --dry-run
```

Integration tests always use a scratch `HC_SESSION` and scratch XDG paths. Never point
them at the developer's default core.

## Module map

| Path | Responsibility |
|---|---|
| `index.ts` | Wiring only: session lifecycle, runtime creation, service installation, tool registration. |
| `child.ts` | Optional child entry loaded with `-e`: private pipe server, session label, no `hc_subagent*` tools. |
| `src/core/**` | hc JSON-RPC client, decoders, stable error codes, JSONL framing. No pi imports. |
| `src/config/**` | Config schema/defaults, precedence, env overrides, warnings, agent-dir resolution. |
| `src/agents/**` | Agent frontmatter/discovery, precedence, access inference, project-agent policy. |
| `src/child/**` | Deterministic spawn plan, run paths, atomic files, session parsing, pipe protocol/transport, pi result adapter. |
| `src/runtime/**` | Registry, scheduler, state machine, monitors, wake gate, settle-hint hub, persistence, reconciliation, retention, result publication, provider-aware run operations. |
| `src/intertool/**` | Service v1, events, provider/result-adapter interfaces and registries, built-in local provider. |
| `src/tools/**` | `hc_subagent` (single/batch/chain) and `hc_subagent_control` tools. No business logic beyond tool adapters. |
| `src/ui/**` | Widget/footer, renderers, `/hc-subagents` command. |
| `src/runtime/settle-hints.ts` | Per-child settled-hint hub: one long-lived pipe subscription per child, bounded listener fan-out, de-dupe/staleness, and counters (no task/result text). |
| `src/runtime/wake-gate.ts` | Shared timer/wake/abort wait primitive used by monitors and synchronous waits; a hint shortens a wait but never decides a state. |
| `test/unit` | Pure modules, fakes, security checks. |
| `test/contract` | Pinned `hc schema` contract and minimum-version guard. |
| `test/integration` | Isolated real `hc` cores with fake or real children. |
| `bench/**` | Opt-in delegation benchmark: arms, fixtures, metrics, report, Docker image. |

## Invariants

1. **No arbitrary execution.** Children are launched only through the resolved pi
   invocation. The extension exposes no argv/env/shell-line tool. `terminal.run` gets an
   argv, never a `line`.
2. **Session JSONL is authoritative.** `result.json` is a bounded derived artifact.
   Screen output is lossy and only for blocked/error/debug context.
3. **No force and no dialog answering.** The extension never sends `force`, never types
   into a blocked child, and never auto-approves project agents or permission prompts.
4. **Trust and concurrency are mandatory.** Providers must use `ProviderHost` for agent
   resolution, project trust/confirmation, cwd validation, and scheduler admission.
   Registration is trusted code, but it cannot bypass these checks.
5. **Fail closed.** With no core endpoint (no `HC_TERMINAL_SOCKET` and no configured
   `hc.socketPath`), with an old core, or without a resolvable pi, no tools are
   registered. A provider/adapter throw is contained and marks the run failed.
6. **Privacy.** Events, `run.json`, and persistence entries carry IDs, state, paths, and
   usage — never task text, result text, environment variables, or provider keys.
7. **File hygiene.** Atomic writes; run/session directories `0700`; task/system/result/
   run files `0600`; no partial files.
8. **Bounded context.** Task size, result text, screen tails, notifications, and batch
   summaries are bounded. Batch/chain details stay out of the model's compact text.
9. **Per-parent ownership.** `list`/`get`/`cancel`/`send` only see children started by
   the current parent session. Restored runs are never adopted by mtime scanning.
10. **No console noise.** Use `ctx.ui.notify`, custom messages, or files. Do not write to
    stdout from the extension.

## Architecture decisions

- **Direct JSON-RPC** to `HC_TERMINAL_SOCKET` instead of shelling out to `hc`; one
  request per connection with bounded in-flight requests. When the parent runs outside
  `hc`, the endpoint comes from `hc.socketPath` / `PI_HC_SUBAGENTS_SOCKET`; inside `hc`
  the environment always wins.
- **Settle hints are advisory.** A child's `settled` pipe frame only shortens a waiter's
  sleep; `terminal.get` plus the state machine stay authoritative, `pollIntervalMs`
  remains the fallback, and a lost or degraded channel is never evidence that the child
  died. `wakeOnSettle: false` constructs no hub and is byte-identical to poll-only.
- **Result notifications are settle-scoped.** A result is deduped per settle
  (`childId:turn:result:<settledAt>`), not per `hc` turn, so a follow-up settle is
  delivered and a replay of one publish is not (SPEC §16.2).
- **External parent mode.** Without `HC_TERMINAL_ID`, children are parented to
  `hc.parentTerminal` / `PI_HC_SUBAGENTS_PARENT_TERMINAL` when set, else started with
  `no_parent: true` (root terminals). The extension still kills owned children on
  shutdown; parentless children are not tied to the parent by hc.
- **Child entry (`child.ts`) only for M3+ pipes.** PTY sends remain a test-only fallback
  and are never a public follow-up path.
- **Child model default.** A child uses the parent's current model and thinking level
  (`ctx.model`, `ctx.thinkingLevel`) unless the agent frontmatter or the tool call pins
  them. Ambient pi defaults are never used for a child, because they can point at a
  different provider and fail on the first turn.
- **Provider boundary.** The service selects the first matching `SubagentProvider`
  (`backend` omitted/`hc-local` → `HcLocalProvider`). `startBackgroundRun` has a
  `prepared` path so the local provider validates through `ProviderHost` and then starts
  without double-acquiring a scheduler slot.
- **Result adapters.** Custom `ResultAdapter`s run before `PiSessionResultAdapter`, which
  prefers `result.json` and otherwise parses the session JSONL. No screen fallback.
- **Intertool v1** is an in-process symbol/event API. Additive changes stay in v1; a
  breaking change needs a new symbol and event namespace.
- **M4** (Windows named pipes/ConPTY, remote `hc`, worktree isolation, nested delegation)
  is not part of this release.

## Where to change what

| Change | Start here |
|---|---|
| New hc method/wire param | `src/core/core-client.ts`, `src/core/hc-types.ts`, `test/fixtures/hc-schema.json`, `test/contract/hc-schema.test.ts` |
| New config key | `src/config/schema.ts`, `src/config/config.ts`, `test/unit/config.test.ts`, README |
| External parent connection | `src/config/schema.ts` (`hc`), `src/runtime/prerequisites.ts`, `src/core/core-client.ts`, `src/child/child-command.ts`, `test/integration/external-parent.test.ts` |
| Child launch contract | `src/child/child-command.ts`, `test/unit/child-command.test.ts` |
| New result shape/state | `src/runtime/types.ts`, `src/runtime/state-machine.ts`, `src/runtime/finalize.ts`, fixtures/tests |
| New provider | `src/intertool/adapters.ts` types, a provider implementation, service registration test |
| New result adapter | `src/intertool/adapters.ts`, adapter implementation, `test/unit/adapters.test.ts` |
| Intertool API/event | `src/intertool/service.ts`, `src/intertool/events.ts`, SPEC §19, README, tests |
| Settle-hint wake path | frame `src/child/pipe-protocol.ts` / `child.ts`, transport `src/child/pipe-transport.ts`, hub `src/runtime/settle-hints.ts`, gate `src/runtime/wake-gate.ts`, call sites (`src/runtime/async-monitor.ts`, `src/child/wait-child.ts`, `src/runtime/run-background.ts`, `src/runtime/run-ops.ts`), tests |
| Tool schema/UX | `src/tools/**`, `src/ui/**`, tests |
| Benchmark arm/metric | `bench/arms.ts`, `bench/metrics.ts`, `bench/types.ts`, `test/unit/bench-metrics.test.ts` |
| Benchmark task suite | `bench/tasks/<id>.json`, `bench/fixture/<id>/` |

## Testing rules

- New behavior lands with unit or integration coverage.
- External-parent behavior is covered by `test/integration/external-parent.test.ts`
  (parentless spawn, configured anchor, tool registration, and a fake-child tool run).
- Pure modules (`core`, `session-parse`, `state-machine`) are fixture-tested.
- Integration tests use `startIsolatedHc()` from `test/integration/harness.ts` and clean
  up in `finally`.
- Fake children are driven by `PI_HC_SUBAGENTS_TEST_CHILD` and must not require network
  or model credentials. Live model tests are opt-in and skipped by default.
- Never put real credentials or user task/result text into fixtures, labels, logs, or
  snapshots.
- `bench/**` is opt-in and never runs in CI. It spends real tokens, so it is gated by
  `BENCH_LIVE_MODEL=1`, bounded by `BENCH_MAX_COST_USD`, and must keep task/result text
  out of `plan.json`, `trials.jsonl`, `metrics.json`, and the report. Metric math is
  unit-tested on synthetic records.
