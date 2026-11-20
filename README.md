# pi-hc-subagents

Delegate self-contained tasks from a [pi](https://pi.dev) session to **interactive pi
subagents** running in [herdr-core (`hc`)](https://herdr.dev) terminals.

The parent stays the orchestrator. Each child gets an isolated context window, a real
terminal a human can attach to, and a normal pi session file that is the authoritative
source of the final result.

## Status

Milestone 1 is under active development (phases 1–8 of the implementation plan).
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

## Tools (Milestone 1)

- `hc_subagent` — spawn one child and wait for its result.
- `hc_subagent_control` — `list`, `wait`, `output`, `result`, `attach`, `interrupt`, `kill`.

Outside an `hc` terminal the tools are not registered; `/hc-subagents` prints setup
instructions instead.

## Configuration

Global: `~/.pi/agent/hc-subagents.json`. Project: `<cwd>/.pi/hc-subagents.json` (trusted
projects only). Environment overrides use the `PI_HC_SUBAGENTS_*` prefix.

Run `/hc-subagents config` to print the effective configuration and agent directories.

## Tests

```bash
npm test                 # unit tests (node:test)
npm run test:contract    # pinned hc schema contract
npm run test:integration # isolated hc core; skipped when hc is unavailable
```

## Milestone 1 quickstart

Install the package into pi, or load it explicitly while developing:

```bash
hc run --bg --name pi pi -e /absolute/path/to/pi-hc-subagents
```

Inside that terminal, the model can call:

```text
hc_subagent({
  agent: "reviewer",
  task: "Review src/parser.ts for correctness bugs. Report file:line findings.",
  timeoutMs: 600000
})
```

The result contains the child's final assistant text, usage, terminal address, and
session path. If the child is blocked on a permission/auth/question dialog, the result
says a human is required and prints `hc attach <terminal>`; the extension never answers
the dialog.

Built-in agents: `reviewer` and `scout` (read-only), `worker` (write-capable). User
agents live in `~/.pi/agent/agents/*.md`; project agents in `.pi/agents/*.md` require a
trusted project and an opt-in `agentScope`.

Inspect children:

```text
hc_subagent_control({ action: "list" })
hc_subagent_control({ action: "wait", id: "<slug>" })
hc_subagent_control({ action: "result", id: "<slug>" })
hc_subagent_control({ action: "attach", id: "<slug>" })
hc_subagent_control({ action: "output", id: "<slug>", lines: 60 })  # lossy debugging only
```

`/hc-subagents` lists children; `/hc-subagents config` prints the effective
configuration, agent directories, and the detected hc version.

## Safety invariants

- Child output is labelled as untrusted data and is never executed.
- The extension never sends `force` or answers a blocked dialog.
- Children are parented to the parent terminal and are killed on parent shutdown.
- Spawns use argv, never a shell line; task/system files are `0600`, run dirs `0700`.
- Integration tests use an isolated `HC_SESSION` and scratch XDG paths.
