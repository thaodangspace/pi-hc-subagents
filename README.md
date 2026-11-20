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
