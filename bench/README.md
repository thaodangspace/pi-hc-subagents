# Delegation benchmark

Measures what delegation costs and what it buys, on a real `hc` core with real
`pi` sessions. It answers a narrow question:

> For a read-only exploration task, does delegating to a child keep the parent's
> context small without making the task more expensive per success?

It does **not** measure general "subagent quality". One fixture, one model, one
snapshot: no generalisation claim.

## Quick start

```bash
# 1. Dry run: validates the suite, fixture, and argv without spending tokens.
BENCH_LIVE_MODEL=1 BENCH_MODEL=deepseek/deepseek-flash BENCH_DRY_RUN=1 npm run bench

# 2. Mechanism check: one task, one repeat, baseline + delegation.
BENCH_LIVE_MODEL=1 BENCH_MODEL=deepseek/deepseek-flash \
  BENCH_TASKS=defaults-timeout BENCH_REPEATS=1 BENCH_ARMS=solo,subagent \
  npm run bench

# 3. Full run (10 tasks x 3 repeats x 3 arms = 90 trials).
BENCH_LIVE_MODEL=1 BENCH_MODEL=deepseek/deepseek-flash npm run bench

# 4. Routing arm: same parent and prompt, cheaper child model.
BENCH_LIVE_MODEL=1 BENCH_MODEL=deepseek/deepseek-flash \
  BENCH_ARMS=subagent,routing BENCH_CHILD_MODEL=deepseek/deepseek-cheap \
  npm run bench

# Regenerate the report from recorded trials, no model calls.
npm run bench:report -- bench/results/<run-dir>
```

Every run writes to `bench/results/<timestamp>-<model>/` (git-ignored):

| file | contents |
|---|---|
| `plan.json` | model, suite, fixture digest, pi/hc versions, commit, agent dir mode |
| `trials.jsonl` | one record per trial: usage, cost, resolve, paths, durations |
| `metrics.json` | per-arm summaries and paired comparisons |
| `REPORT.md` | verdict, arm table, paired table, per-task table, caveats |
| `trials.csv` | the same numbers for a spreadsheet |
| `pareto.svg` | one dot per trial: billed tokens vs resolved |
| `trials/<key>/` | workspace copy, parent session JSONL, child run dirs, logs |

Task text and result text are never written to `plan.json`, `trials.jsonl`,
`metrics.json`, or the report. Only `trials/<key>/` keeps the raw artifacts.

## Arms

| arm | what runs | purpose |
|---|---|---|
| `solo` | one pi session with the agent's system prompt and tools | baseline |
| `subagent` | a parent pi with only `hc_subagent`/`hc_subagent_control`, delegating to a real child in an `hc` terminal | the treatment |
| `routing` | identical to `subagent` except the child is pinned to `BENCH_CHILD_MODEL` | cost lever: delegate the work to a cheaper model |
| `transcript` | `solo` plus the child's full transcript injected into the prompt | ablation: what the parent pays if it must absorb the exploration itself |

Fairness rules enforced in `bench/arms.ts`:

- `solo` and `transcript` get `buildSystemFile(agent.body)` — the exact system
  prompt the child receives (agent body + delegation contract) — and the same
  `--tools` allowlist as the child.
- `subagent` cannot do the work itself: read tools are not enabled for the parent.
- The child model is pinned in the tool call (`model:` argument), so both arms use
  one model. Without that, the child inherits pi's ambient default model. `routing`
  is the only arm that pins a different child model, and it requires
  `BENCH_CHILD_MODEL` to differ from `BENCH_MODEL`.
- Context parity: the child gets pi's normal project files (`AGENTS.md`) and skills,
  so the baseline arms do too. Leaving them enabled only on the child inflated its
  prompt by ~16 KB in the `self` suite and biased the cost comparison.
- All arms run with `--no-extensions --no-mcp --no-prompt-templates`; only
  `subagent` adds `-e index.ts`, so a user-installed extension cannot hand the
  baseline the delegation tool. Built-in extensions still differ slightly between
  arms and are a known limitation.
- Each trial gets a fresh workspace copy and its own session dir.
- Arm order alternates by trial parity to blunt ordering effects.

## Metrics

| metric | definition |
|---|---|
| `resolved` | every `expect.all` string appears, at least one `expect.any`, no `expect.none`. Literal matching, no model judge. |
| `billed` | `input + cacheRead + cacheWrite` across parent + children |
| `parent billed` | the same, parent session only |
| `peak ctx` | max per turn of `input + cacheRead + cacheWrite + output` |
| `ctx amp` | children billed / parent billed |
| `returned share` | parent tool-result bytes / child session bytes |
| `$ / resolved` | total cost / resolved trials; `n/a` when nothing resolved |
| `pass^k` | mean per-task `C(successes, k) / C(trials, k)` (τ-bench reliability) |
| `pass@k` | `1 - C(n-c, k) / C(n, k)`, at least one success (not in the table) |
| resolve CI | Wilson score interval |
| paired Δ | paired bootstrap over per-task deltas, 10k resamples, fixed seed |
| significance | exact two-sided McNemar on discordant pairs |

Why these: provider work is billed by tokens processed, not by
`totalTokens`; and Anthropic's own multi-agent analysis found token usage alone
explains ~80% of performance variance, so a raw accuracy or raw token win proves
nothing without the cost-normalised pair.

## Task suites

`bench/tasks/tiny.json` points at `bench/fixture/tiny`, a dependency-free
service with a deliberate duplicate constant and an `AppError` hierarchy. Each
task is a read-only question whose answer is verifiable by literal strings:

```json
{
  "id": "duplicate-constant",
  "prompt": "One backoff constant is duplicated in two modules...",
  "expect": { "all": ["BASE_DELAY_MS", "src/retry.ts", "src/legacy/retry.ts"], "any": ["250"] }
}
```

Two suites ship:

| suite | fixture | purpose |
|---|---|---|
| `bench/tasks/tiny.json` | `bench/fixture/tiny` | tier-1 mechanism check, dependency-free |
| `bench/tasks/self.json` | `.` (this repository) | tier-2: 20 read-only questions about the real codebase |

`self` runs with `BENCH_SUITE_FILE=bench/tasks/self.json`. Its fixture is the repo
root, so the suite sets `exclude` to keep `node_modules`, `.git`, `bench/results`,
`dist`, `coverage`, and `.pi` out of each trial workspace and out of the fixture
digest. Output can therefore live inside the repo without being copied into the
next trial.

Add a suite as `bench/tasks/<id>.json` with `fixture`, optional `exclude`,
`agent`, `tools`, `timeoutMs`, and `tasks[]`, then run with
`BENCH_SUITE_FILE=bench/tasks/<id>.json`. A suite with 20-30 tasks from a real
repository is what a tier-2 claim needs; `tiny` is a tier-1 mechanism check.

## Configuration

| env | default | meaning |
|---|---|---|
| `BENCH_LIVE_MODEL` | required `1` | explicit opt-in to spend tokens |
| `BENCH_MODEL` | required | `provider/model` for the parent and for the `subagent` child |
| `BENCH_CHILD_MODEL` | unset | child model for `routing`; required, and must differ from `BENCH_MODEL` |
| `BENCH_THINKING` | unset | thinking level for both arms |
| `BENCH_ARMS` | `solo,subagent,transcript` | arms to run; add `routing` explicitly |
| `BENCH_TASKS` | all | comma-separated task ids |
| `BENCH_REPEATS` | `3` | trials per task per arm |
| `BENCH_SUITE_FILE` | `bench/tasks/tiny.json` | suite manifest |
| `BENCH_OUT` | `bench/results/<ts>-<model>` | output directory |
| `BENCH_MAX_COST_USD` | `3` | stop after this much recorded spend |
| `BENCH_TIMEOUT_MS` | suite/task value (240s) | per-trial timeout |
| `BENCH_DRY_RUN` | unset | print the plan, spawn nothing |
| `BENCH_PI` | `pi` | pi executable |
| `BENCH_AGENT_DIR` | unset | explicit pi agent dir (auth, models) |
| `BENCH_ISOLATE_AGENT_DIR` | unset | `1` copies only auth + model catalog into a temp dir |
| `BENCH_HC_SOCKET` / `BENCH_PARENT_TERMINAL` | unset | use an existing core instead of starting a private one |

Auth: by default the benchmark inherits your pi agent dir, because provider
credentials live there. `BENCH_ISOLATE_AGENT_DIR=1` gives reproducibility (no
user agents or settings override the package agents) by copying `auth.json`,
`models.json`, and `models-store.json` into a `0700` temp dir that is removed at
the end.

## Docker

The image pins `hc` and `pi`; credentials come from the environment.

```bash
docker build -t pi-hc-bench bench/
docker run --rm \
  -e BENCH_LIVE_MODEL=1 -e BENCH_MODEL=deepseek/deepseek-flash \
  -e DEEPSEEK_API_KEY \
  -v "$PWD:/work" -v "$PWD/bench/results:/work/bench/results" \
  pi-hc-bench
```

`bench/container.sh` starts a private core, sets a short `XDG_RUNTIME_DIR`,
creates an anchor terminal, and exports `BENCH_HC_SOCKET` so the harness reuses
that core instead of starting another one. Output lands in the mounted
`bench/results`.

## Recorded results

`bench/RESULTS.md` holds the first tier-2 run on this repository: 20 tasks,
3 repeats, 3 arms, 180 trials. Summary: equal accuracy (60/60 everywhere),
parent billed tokens −74%, peak context −33%, for 1.35× billed tokens and
1.63× $ per resolved trial. The file also records the correction of a prompt-parity
bug that inflated the first run's numbers (1.83× → 1.63×). The suite has an accuracy
ceiling, so it measures the price of isolation, not a quality gain.

## Reading a run

1. Check `resolve rate` first. If the arms disagree on correctness, cost numbers
   are not comparable yet.
2. Compare `parent billed` and `peak ctx`. Delegation is supposed to move these.
3. Compare `billed` and `$ / resolved` for the price of that move. For `routing`,
   compare against `subagent` (both delegate) and check the resolve rate first:
   a cheaper child that fails more is not a saving.
4. Read `ctx amp` and `returned share` to confirm the mechanism (isolation), not
   just the outcome.
5. With fewer than ~10 pairs, treat the result as a mechanism check.

## Failure modes

- `Model "x" not found` in a child: the tool call omitted `model`, so the child
  used pi's default. The harness pins it; a custom prompt must too.
- Child fails with `no session file appeared` and zero usage: the child model is
  not resolvable under the run's agent dir. `BENCH_ISOLATE_AGENT_DIR=1` copies
  only `auth.json`/`models*.json`, so providers registered by an installed pi
  extension (for example `oc-sdk-go` from `pi-opencode-bridge`) are absent — use
  the built-in provider for the same model, or drop the isolation flag. The
  harness now runs `pi auth check --model` for the parent and routing child
  before spending.
- `Insufficient Balance` (or any provider quota error) aborts the meaningful
  part of a run: every later trial fails with zero usage and is recorded as
  unresolved. Top up, switch `BENCH_MODEL`, or lower the task set before
  drawing conclusions from such a report.
- Child `state: failed` with zero usage and a provider error: the run is recorded
  as unresolved with its cost, which is correct — failing fast is not a win.
- `hc` missing: only `subagent` needs a core; `solo` still runs.
- Timeouts kill the process group and keep the trial's cost.
- `hc` refuses a socket path over ~100 bytes. The harness keeps the private core
  under a short `/tmp/hcb-*` path and a short session name for exactly that
  reason; `BENCH_TMPDIR` overrides the base if `/tmp` is not writable.
