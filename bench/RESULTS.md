# Benchmark result — self suite, 2026-11-20

Tier-2 run of the delegation benchmark on this repository, after fixing a fairness bug
in the arms (see *Correction* below).

```bash
BENCH_LIVE_MODEL=1 BENCH_MODEL=deepseek/deepseek-flash \
  BENCH_SUITE_FILE=bench/tasks/self.json BENCH_ISOLATE_AGENT_DIR=1 \
  BENCH_REPEATS=3 BENCH_MAX_COST_USD=3 npm run bench
```

| | |
|---|---|
| suite | `self` — 20 read-only questions about this repo, literal verifiers |
| trials | 180 (20 tasks × 3 repeats × 3 arms) |
| model | `deepseek/deepseek-flash`, thinking unset, one model for parent and child |
| environment | pi 1.6.0 · hc 0.1.21 · node 26.12.1 · darwin-arm64 |
| commit | `3c2f92403a7b` |
| fixture digest | `d8001f466981` (repo root, `node_modules`/`.git`/`bench/results` excluded) |
| agent dir | isolated (auth + model catalog only; no user agents, skills, or settings) |
| spend | $1.39 · 35.1 min |
| artifacts | `plan.json`, `trials.jsonl`, `metrics.json`, `REPORT.md`, `trials.csv`, `pareto.svg` |

## Result

| arm | resolved | resolve rate | $ / resolved | billed / resolved | parent billed | peak ctx p50 / p95 | ctx amp | returned share | latency p50 / p95 |
|---|---|---|---|---|---|---|---|---|---|
| `solo` | 60/60 | 100% [94–100] | $0.0049 | 52.7k | 3.16M | 12.5k / 20.9k | — | — | 10.9s / 19.0s |
| `subagent` | 60/60 | 100% [94–100] | $0.0080 | 71.1k | 819k | 8.1k / 9.2k | 4.19× | 5.92% | 16.4s / 27.7s |
| `transcript` | 60/60 | 100% [94–100] | $0.0100 | 84.3k | 1.61M | 13.9k / 21.1k | — | — | 5.8s / 9.2s |

Paired over 60 pairs (same task, same repetition):

| comparison | Δ billed (paired mean, 95% CI) | Δ billed (aggregate) | Δ cost | Δ peak context |
|---|---|---|---|---|
| `subagent` vs `solo` | +54.4% [+39.6%, +69.2%] | +35.1% | +75.3% | −33.1% |
| `transcript` vs `solo` | +81.8% [+65.4%, +98.2%] | +60.1% | +119.7% | +16.2% |
| `subagent` vs `transcript` | −15.1% | −15.5% | — | −41.1% |

Mechanism: the child billed 4.19× the parent and only **5.9%** of its session bytes
reached the parent. Against the `transcript` ablation — which pays the same child and
then re-reads it — delegation bills 15.1% less and uses 41.1% less parent context. The
gain is isolation, not extra searching.

## What this supports

- **Delegation cuts parent context at equal accuracy on this task set:** parent billed
  3.16M → 819k (−74.1%), peak context p50 12.5k → 8.1k, p95 20.9k → 9.2k.
- **Delegation costs more per task:** 1.35× billed tokens (+35% aggregate), 1.63× $
  per resolved trial, 1.5× latency (p50 10.9s → 16.4s).
- **Child cost dominates:** 81% of the subagent arm's tokens are the child, and one
  child session costs about as much as solving the task in one session (57.5k vs
  52.7k billed per trial). The parent's share is ~14k per trial.
- **Reading the transcript is not the cheap option:** paying a child and then reading
  its full transcript is the most expensive arm per resolved trial ($0.0100) and does
  not reduce parent context (+16.2% vs solo), though it is the fastest (5.8s p50)
  because it skips exploration.

## What this does not support

- **No accuracy claim.** Every arm resolved every task, so this suite has an accuracy
  ceiling. It measures the cost of equal correctness, not a quality delta.
- **No generalisation.** One repo, one model, one snapshot, read-only questions,
  literal substring verifiers, serial trials.
- **No claim that delegation is cheaper.** It is 1.63× more expensive per resolved task
  on this codebase. It pays off only when the parent's context is the scarce resource.

## Correction

The first run of this suite disabled project context files and skills only for the
baseline arms (`--no-context-files --no-skills`), while the child receives pi's normal
discovery. That put ~16 KB of `AGENTS.md` in the child's prompt and none in the
baseline's, inflating the cost gap. After the fix (all arms load project context; only
`--no-extensions` remains, so a user extension cannot hand the baseline the delegation
tool) the numbers changed materially:

| metric | buggy run | corrected |
|---|---|---|
| `$ / resolved` ratio | 1.83× | **1.63×** |
| billed per resolved | 68.6k vs 34.2k | **71.1k vs 52.7k** |
| parent billed reduction | 84.5% | **74.1%** |
| peak context reduction | −51.0% | **−33.1%** |
| context amplification | 11.75× | **4.19×** |

The direction never changed, but both the price and the saving were overstated. Any
number from a benchmark that does not check prompt parity between arms should be
treated the same way.

## Reproduction notes

- Published runs should use `BENCH_ISOLATE_AGENT_DIR=1`: auth and the model catalog are
  copied into a temp dir, user agents/skills/settings are dropped, and the fixture's
  `AGENTS.md` is the only project context in play.
- The private `hc` core lives under a short `/tmp/hcb-*` path because Unix socket
  paths cap out near 100 bytes.
- The `transcript` arm includes the cost of the child session it consumed. Without
  that, the ablation falsely appears cheaper than solo.
- Built-in extensions still differ slightly between arms (`--no-extensions` for all
  arms, explicit `-e` only for the parent). Small, known, and not measured separately.
