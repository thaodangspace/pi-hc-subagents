/**
 * Pure metric math for the delegation benchmark.
 *
 * Every function here is deterministic and network-free so the report can be
 * regenerated from `trials.jsonl` alone and tested in unit tests.
 */
import { type TrialRecord, type UsageTotals, billedTokens } from "./types.ts";

/** Unbiased pass@k estimator (Chen et al. 2021): at least one success in k tries. */
export function passAtK(successes: number, trials: number, k: number): number {
  if (trials <= 0 || successes <= 0) return 0;
  if (successes >= trials) return 1;
  if (k > trials) k = trials;
  if (k <= 0) return 0;
  return 1 - combinations(trials - successes, k) / combinations(trials, k);
}

/** τ-bench pass^k: every one of k tries succeeds (reliability, not luck). */
export function passHatK(successes: number, trials: number, k: number): number {
  if (trials <= 0 || successes < k || k <= 0) return 0;
  if (k > trials) k = trials;
  return combinations(successes, k) / combinations(trials, k);
}

function combinations(n: number, k: number): number {
  if (k < 0 || n < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  const take = Math.min(k, n - k);
  let value = 1;
  for (let index = 1; index <= take; index += 1) {
    value = (value * (n - take + index)) / index;
  }
  return value;
}

/** Linear-interpolated quantile; empty input returns null. */
export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] as number;
  const high = sorted[upper] as number;
  return low + (high - low) * (position - lower);
}

/** Wilson score interval for a binomial proportion. */
export function wilsonInterval(successes: number, trials: number, z = 1.959_963_984_540_054): { low: number; high: number } {
  if (trials <= 0) return { low: 0, high: 1 };
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const center = p + (z * z) / (2 * trials);
  const spread = z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials));
  return {
    low: Math.max(0, (center - spread) / denominator),
    high: Math.min(1, (center + spread) / denominator),
  };
}

/** Deterministic PRNG so a report is reproducible from the same records. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface BootstrapOptions {
  resamples?: number;
  seed?: number;
  alpha?: number;
}

/** Percentile bootstrap CI for a statistic over per-task values. */
export function bootstrapCI(
  values: number[],
  statistic: (sample: number[]) => number = mean,
  options: BootstrapOptions = {},
): { low: number; high: number } | null {
  if (values.length === 0) return null;
  const resamples = options.resamples ?? 10_000;
  const alpha = options.alpha ?? 0.05;
  const random = mulberry32(options.seed ?? 0x5eed);
  const estimates: number[] = [];
  for (let index = 0; index < resamples; index += 1) {
    const sample: number[] = [];
    for (let pick = 0; pick < values.length; pick += 1) {
      sample.push(values[Math.floor(random() * values.length)] as number);
    }
    estimates.push(statistic(sample));
  }
  const low = quantile(estimates, alpha / 2);
  const high = quantile(estimates, 1 - alpha / 2);
  return low === null || high === null ? null : { low, high };
}

/**
 * Two-sided exact McNemar test over paired binary outcomes.
 * `b` is solo-only successes, `c` is subagent-only successes.
 */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let cumulative = 0;
  for (let index = 0; index <= k; index += 1) cumulative += combinations(n, index);
  return Math.min(1, (2 * cumulative) / 2 ** n);
}

export interface ArmSummary {
  arm: string;
  trials: number;
  resolved: number;
  resolveRate: number;
  resolveCI: { low: number; high: number };
  passHatK: number;
  costUsd: number;
  costPerResolved: number | null;
  billed: number;
  billedPerResolved: number | null;
  parentBilled: number;
  output: number;
  cacheRead: number;
  peakContextP50: number | null;
  peakContextP95: number | null;
  contextAmplification: number | null;
  returnedShare: number | null;
  durationP50: number | null;
  durationP95: number | null;
}

export function summarizeArm(trials: TrialRecord[]): ArmSummary {
  const resolved = trials.filter((trial) => trial.resolved).length;
  const usage: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, costUsd: 0 };
  let billed = 0;
  let parentBilled = 0;
  for (const trial of trials) {
    usage.input += trial.usage.input;
    usage.output += trial.usage.output;
    usage.cacheRead += trial.usage.cacheRead;
    usage.cacheWrite += trial.usage.cacheWrite;
    usage.reasoning += trial.usage.reasoning;
    usage.totalTokens += trial.usage.totalTokens;
    usage.costUsd += trial.usage.costUsd;
    billed += billedTokens(trial.usage);
    parentBilled += trial.parentBilled;
  }
  const peakContexts = trials.map((trial) => trial.parent?.peakContext ?? 0);
  const amplifications = trials
    .map((trial) => trial.contextAmplification)
    .filter((value): value is number => typeof value === "number");
  const shares = trials.map((trial) => trial.returnedShare).filter((value): value is number => typeof value === "number");
  const durations = trials.map((trial) => trial.durationMs);
  const repeats = trials.length > 0 ? Math.min(...trials.map((trial) => trial.repeats)) : 0;
  const perTask = new Map<string, { resolved: number; trials: number }>();
  for (const trial of trials) {
    const group = perTask.get(trial.taskId) ?? { resolved: 0, trials: 0 };
    group.trials += 1;
    if (trial.resolved) group.resolved += 1;
    perTask.set(trial.taskId, group);
  }

  return {
    arm: trials[0]?.arm ?? "unknown",
    trials: trials.length,
    resolved,
    resolveRate: trials.length === 0 ? 0 : resolved / trials.length,
    resolveCI: wilsonInterval(resolved, trials.length),
    passHatK: mean([...perTask.values()].map((group) => passHatK(group.resolved, group.trials, repeats))),
    costUsd: usage.costUsd,
    costPerResolved: resolved === 0 ? null : usage.costUsd / resolved,
    billed,
    billedPerResolved: resolved === 0 ? null : billed / resolved,
    parentBilled,
    output: usage.output,
    cacheRead: usage.cacheRead,
    peakContextP50: quantile(peakContexts, 0.5),
    peakContextP95: quantile(peakContexts, 0.95),
    contextAmplification: amplifications.length === 0 ? null : mean(amplifications),
    returnedShare: shares.length === 0 ? null : mean(shares),
    durationP50: quantile(durations, 0.5),
    durationP95: quantile(durations, 0.95),
  };
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export interface PairedComparison {
  taskId: string;
  left: boolean;
  right: boolean;
  leftBilled: number;
  rightBilled: number;
  leftCost: number;
  rightCost: number;
  leftPeakContext: number;
  rightPeakContext: number;
}

/**
 * Pair trials by (task, repetition) so both arms answer the same task under
 * the same conditions. Trials present in only one arm are dropped.
 */
export function pairTrials(left: TrialRecord[], right: TrialRecord[]): PairedComparison[] {
  const index = new Map<string, TrialRecord>();
  for (const trial of right) index.set(`${trial.taskId}#${trial.trial}`, trial);
  const pairs: PairedComparison[] = [];
  for (const trial of left) {
    const match = index.get(`${trial.taskId}#${trial.trial}`);
    if (!match) continue;
    pairs.push({
      taskId: trial.taskId,
      left: trial.resolved,
      right: match.resolved,
      leftBilled: billedTokens(trial.usage),
      rightBilled: billedTokens(match.usage),
      leftCost: trial.usage.costUsd,
      rightCost: match.usage.costUsd,
      leftPeakContext: trial.parent?.peakContext ?? 0,
      rightPeakContext: match.parent?.peakContext ?? 0,
    });
  }
  return pairs;
}

export interface PairedSummary {
  pairs: number;
  leftOnly: number;
  rightOnly: number;
  mcnemarP: number;
  /** Paired mean of per-trial relative changes, so it matches the bootstrap CI. */
  billedDeltaPct: number | null;
  billedDeltaCI: { low: number; high: number } | null;
  /** Aggregate ratio: sum(right) / sum(left) - 1. */
  billedDeltaAggregatePct: number | null;
  costDeltaPct: number | null;
  peakContextDeltaPct: number | null;
}

function relativeDelta(left: number, right: number): number {
  return left === 0 ? 0 : (right - left) / left;
}

export function summarizePairs(pairs: PairedComparison[]): PairedSummary {
  const leftOnly = pairs.filter((pair) => pair.left && !pair.right).length;
  const rightOnly = pairs.filter((pair) => pair.right && !pair.left).length;
  const billsLeft = pairs.map((pair) => pair.leftBilled);
  const billsRight = pairs.map((pair) => pair.rightBilled);
  const totalLeft = billsLeft.reduce((total, value) => total + value, 0);
  const totalRight = billsRight.reduce((total, value) => total + value, 0);
  const billedDeltas = pairs.map((pair) => relativeDelta(pair.leftBilled, pair.rightBilled));
  const costDeltas = pairs.map((pair) => relativeDelta(pair.leftCost, pair.rightCost));
  const peakDeltas = pairs.map((pair) => relativeDelta(pair.leftPeakContext, pair.rightPeakContext));
  const usable = (values: number[]): number | null => (values.length === 0 ? null : mean(values) * 100);
  const ci = bootstrapCI(billedDeltas, mean);

  return {
    pairs: pairs.length,
    leftOnly,
    rightOnly,
    mcnemarP: mcnemarExact(leftOnly, rightOnly),
    billedDeltaPct: usable(billedDeltas),
    billedDeltaCI: ci ? { low: ci.low * 100, high: ci.high * 100 } : null,
    billedDeltaAggregatePct: totalLeft === 0 ? null : ((totalRight - totalLeft) / totalLeft) * 100,
    costDeltaPct: usable(costDeltas),
    peakContextDeltaPct: usable(peakDeltas),
  };
}
