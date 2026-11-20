/**
 * Benchmark report rendering.
 *
 * Pure formatting over `TrialRecord[]`: the same function powers the end of a
 * run and `node bench/report.ts <dir>`, so a report is always reproducible
 * from the recorded trials.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { billedTokens, type TrialRecord } from "./types.ts";
import { pairTrials, summarizeArm, summarizePairs, type ArmSummary } from "./metrics.ts";

export interface ReportPlan {
  startedAt?: string;
  model: string;
  childModel?: string | null;
  thinking?: string | null;
  suite: string;
  fixtureDigest?: string;
  arms?: string[];
  repeats?: number;
  piVersion?: string;
  hcVersion?: string;
  commit?: string | null;
  node?: string;
  platform?: string;
}

function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${Math.round(value)}`;
}

function formatPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function formatShare(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(2)}%`;
}

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "n/a";
  return `${(ms / 1000).toFixed(1)}s`;
}

function describeArm(summary: ArmSummary): string {
  if (summary.arm === "solo") return "single agent, one session";
  if (summary.arm === "subagent") return "parent delegates to a real child";
  if (summary.arm === "routing") return "same delegation, cheaper child model";
  return "solo + full child transcript (ablation)";
}

function significance(comparison: ReturnType<typeof summarizePairs>): string {
  if (comparison.pairs === 0) return "no paired trials";
  if (comparison.leftOnly === 0 && comparison.rightOnly === 0) return "identical outcomes (p=1)";
  const p = comparison.mcnemarP;
  const verdict = p < 0.05 ? "significant" : p < 0.2 ? "weak" : "not detectable";
  return `${verdict} (p=${p.toFixed(3)})`;
}

export function renderSummaryTable(summaries: ArmSummary[]): string {
  const header = [
    "| arm | trials | resolved | resolve rate (95% CI) | pass^k | $ / resolved | billed / resolved | parent billed | peak ctx p50/p95 | ctx amp | returned share | p50/p95 latency |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  const rows = summaries.map((summary) =>
    [
      `| ${summary.arm} (${describeArm(summary)})`,
      `${summary.trials}`,
      `${summary.resolved}`,
      `${(summary.resolveRate * 100).toFixed(1)}% [${(summary.resolveCI.low * 100).toFixed(0)}–${(summary.resolveCI.high * 100).toFixed(0)}]`,
      summary.passHatK.toFixed(2),
      formatUsd(summary.costPerResolved),
      formatTokens(summary.billedPerResolved),
      formatTokens(summary.parentBilled),
      `${formatTokens(summary.peakContextP50)} / ${formatTokens(summary.peakContextP95)}`,
      summary.contextAmplification === null ? "n/a" : `${summary.contextAmplification.toFixed(2)}×`,
      formatShare(summary.returnedShare),
      `${formatDuration(summary.durationP50)} / ${formatDuration(summary.durationP95)}`,
    ].join(" | "),
  );
  return [...header, ...rows].join("\n");
}

function renderPairsTable(records: TrialRecord[]): string {
  const solo = records.filter((record) => record.arm === "solo");
  const others = [...new Set(records.map((record) => record.arm))].filter((arm) => arm !== "solo");
  if (solo.length === 0 || others.length === 0) return "_No paired arms: run `solo` together with another arm._";

  const header = [
    "| arm vs solo | pairs | solo-only wins | arm-only wins | difference | Δ billed, paired mean (95% CI) | Δ billed, aggregate | Δ cost | Δ peak context |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  const rows = others.map((arm) => {
    const comparison = summarizePairs(pairTrials(solo, records.filter((record) => record.arm === arm)));
    const ci = comparison.billedDeltaCI
      ? ` [${comparison.billedDeltaCI.low >= 0 ? "+" : ""}${comparison.billedDeltaCI.low.toFixed(1)}%, ${comparison.billedDeltaCI.high.toFixed(1)}%]`
      : "";
    const billedCell = comparison.billedDeltaPct === null ? "n/a" : `${formatPct(comparison.billedDeltaPct)}${ci}`;
    return [
      `| ${arm}`,
      `${comparison.pairs}`,
      `${comparison.leftOnly}`,
      `${comparison.rightOnly}`,
      `| ${significance(comparison)}`,
      billedCell,
      formatPct(comparison.billedDeltaAggregatePct),
      formatPct(comparison.costDeltaPct),
      formatPct(comparison.peakContextDeltaPct),
    ].join(" | ");
  });
  return [...header, ...rows].join("\n");
}

function renderTaskTable(records: TrialRecord[]): string {
  const arms = [...new Set(records.map((record) => record.arm))];
  const tasks = [...new Set(records.map((record) => record.taskId))];
  const header = [
    `| task | ${arms.join(" | ")} |`,
    `|---|${arms.map(() => "---").join("|")}|`,
  ];
  const rows = tasks.map((taskId) => {
    const cells = arms.map((arm) => {
      const trials = records.filter((record) => record.taskId === taskId && record.arm === arm);
      if (trials.length === 0) return "—";
      const resolved = trials.filter((record) => record.resolved).length;
      return `${resolved}/${trials.length}`;
    });
    return `| ${taskId} | ${cells.join(" | ")} |`;
  });
  return [...header, ...rows].join("\n");
}

function renderVerdict(records: TrialRecord[], summaries: ArmSummary[]): string {
  const solo = summaries.find((summary) => summary.arm === "solo");
  // Prefer the same-child baseline; fall back to routing so a solo+routing run
  // still gets a verdict instead of an empty one.
  const candidate = summaries.find((summary) => summary.arm === "subagent") ??
    summaries.find((summary) => summary.arm === "routing");
  if (!solo || !candidate) return "Run `solo` with `subagent` (or `routing`) together to get a verdict.";

  const comparison = summarizePairs(pairTrials(
    records.filter((record) => record.arm === "solo"),
    records.filter((record) => record.arm === candidate.arm),
  ));
  const lines: string[] = [];
  lines.push(
    `- Resolve rate: solo ${(solo.resolveRate * 100).toFixed(1)}% vs ${candidate.arm} ${(candidate.resolveRate * 100).toFixed(1)}% (${significance(comparison)}).`,
  );
  lines.push(
    `- Billed tokens: ${formatTokens(solo.billed)} vs ${formatTokens(candidate.billed)} total; ` +
      `paired mean ${formatPct(comparison.billedDeltaPct)} (aggregate ${formatPct(comparison.billedDeltaAggregatePct)}).`,
  );
  lines.push(
    `- Parent context: parent billed ${formatTokens(solo.parentBilled)} vs ${formatTokens(candidate.parentBilled)} total, ` +
      `peak context ${formatPct(comparison.peakContextDeltaPct)}.`,
  );
  if (comparison.billedDeltaCI) {
    lines.push(
      `- 95% CI for the paired billed delta: [${comparison.billedDeltaCI.low.toFixed(1)}%, ` +
        `${comparison.billedDeltaCI.high.toFixed(1)}%] over ${comparison.pairs} paired trials.`,
    );
  }
  if (solo.costPerResolved !== null && candidate.costPerResolved !== null) {
    const ratio = candidate.costPerResolved / solo.costPerResolved;
    lines.push(
      `- $ / resolved: ${formatUsd(solo.costPerResolved)} vs ${formatUsd(candidate.costPerResolved)} (${ratio.toFixed(2)}×). ` +
        `${candidate.costPerResolved < solo.costPerResolved ? `${candidate.arm} is cheaper per resolved trial here.` : `${candidate.arm} is more expensive per resolved trial here.`}`,
    );
  }
  const transcript = summaries.find((summary) => summary.arm === "transcript");
  if (transcript && transcript.trials > 0) {
    const mechanism = summarizePairs(pairTrials(
      records.filter((record) => record.arm === "transcript"),
      records.filter((record) => record.arm === "subagent"),
    ));
    if (mechanism.pairs > 0) {
      lines.push(
        `- Mechanism (subagent vs transcript, both pay for the same child): billed ${formatPct(mechanism.billedDeltaPct)}, ` +
          `peak context ${formatPct(mechanism.peakContextDeltaPct)}. ` +
          `Isolation, not extra searching, is what shrinks the parent.`,
      );
    }
  }
  const routing = summaries.find((summary) => summary.arm === "routing");
  if (routing && routing.trials > 0 && candidate.arm === "subagent") {
    const comparison = summarizePairs(pairTrials(
      records.filter((record) => record.arm === "subagent"),
      records.filter((record) => record.arm === "routing"),
    ));
    lines.push(
      `- Routing (same parent and prompt, different child model): resolve rate ` +
        `${(candidate.resolveRate * 100).toFixed(1)}% vs ${(routing.resolveRate * 100).toFixed(1)}% ` +
        `(${significance(comparison)}); $ / resolved ${formatUsd(candidate.costPerResolved)} vs ` +
        `${formatUsd(routing.costPerResolved)}.`,
    );
  }
  if (comparison.pairs < 10) {
    lines.push("- n is small: treat this as a mechanism check, not an effectiveness proof.");
  }
  return lines.join("\n");
}

export function renderReport(records: TrialRecord[], plan: ReportPlan): string {
  const summaries = [...new Set(records.map((record) => record.arm))]
    .map((arm) => summarizeArm(records.filter((record) => record.arm === arm)))
    .sort((left, right) => left.arm.localeCompare(right.arm));
  const totalCost = records.reduce((total, record) => total + record.usage.costUsd, 0);
  const timeouts = records.filter((record) => record.timedOut).length;
  const failures = records.filter((record) => record.exitCode !== 0).length;

  return [
    "# Delegation benchmark",
    "",
    `- model: \`${plan.model}\`${plan.thinking ? ` (thinking \`${plan.thinking}\`)` : ""}` +
      `${plan.childModel ? ` · child model (routing): \`${plan.childModel}\`` : ""}`,
    `- suite: \`${plan.suite}\`, repeats: ${plan.repeats ?? "?"}, arms: ${(plan.arms ?? []).join(", ")}`,
    `- fixture: \`${(plan.fixtureDigest ?? "unknown").slice(0, 12)}\``,
    `- pi: ${plan.piVersion ?? "?"} · hc: ${plan.hcVersion ?? "?"} · node: ${plan.node ?? "?"} · ${plan.platform ?? "?"}`,
    `- commit: \`${(plan.commit ?? "unknown").slice(0, 12)}\` · started: ${plan.startedAt ?? "?"}`,
    `- trials: ${records.length} · spend: ${formatUsd(totalCost)} · timeouts: ${timeouts} · non-zero exits: ${failures}`,
    "",
    "## Verdict",
    "",
    renderVerdict(records, summaries),
    "",
    "## Arms",
    "",
    renderSummaryTable(summaries),
    "",
    "## Paired comparison",
    "",
    renderPairsTable(records),
    "",
    "## Per task",
    "",
    renderTaskTable(records),
    "",
    "## Reading this report",
    "",
    "- `billed` is `input + cacheRead + cacheWrite`: tokens the provider processed. It is the cost driver, not `totalTokens`.",
    "- `parent billed` and `peak ctx` measure what the orchestrating agent had to hold. This is the metric delegation is designed to move.",
    "- `ctx amp` is total billed divided by parent billed: the price of isolation in tokens.",
    "- `returned share` is parent tool-result bytes divided by child session bytes: direct evidence of context isolation.",
    "- `transcript` includes the cost of the child session it consumed, so it is not a free second opinion.",
    "- `routing` changes only the child model; compare it with `subagent` at equal resolve rate before reading its cost.",
    "- `$ / resolved` counts only successful trials and is `n/a` when nothing resolved. Failing cheaply is not efficiency.",
    "- `pass^k` averages τ-bench style per-task reliability; k is the repeat count.",
    "",
    "## What this does not show",
    "",
    "- One fixture, one model, one snapshot: no generalisation claim.",
    "- The verifier is literal substring matching, not a human grade.",
    "- A timed-out trial keeps its cost and counts as unresolved.",
    "",
  ].join("\n");
}

/** One dot per trial: x = billed tokens, y = resolved (jittered), colour = arm. */
export function renderScatterSvg(records: TrialRecord[]): string {
  const width = 720;
  const height = 320;
  const padding = { left: 64, right: 24, top: 24, bottom: 48 };
  const arms = [...new Set(records.map((record) => record.arm))];
  const colors: Record<string, string> = {
    solo: "#2563eb",
    subagent: "#dc2626",
    routing: "#d97706",
    transcript: "#059669",
  };
  const maxBilled = Math.max(1_000, ...records.map((record) => billedTokens(record.usage)));
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const x = (value: number): number => padding.left + (value / maxBilled) * plotWidth;
  const y = (resolved: boolean, index: number): number => {
    const base = resolved ? padding.top + plotHeight * 0.2 : padding.top + plotHeight * 0.75;
    return base + ((index % 5) - 2) * 5;
  };

  const dots: string[] = [];
  let index = 0;
  for (const trial of records) {
    dots.push(
      `<circle cx="${x(billedTokens(trial.usage)).toFixed(1)}" cy="${y(trial.resolved, index).toFixed(1)}" r="4" ` +
        `fill="${colors[trial.arm] ?? "#666"}" fill-opacity="0.75"><title>${trial.arm} ${trial.taskId}: ` +
        `${billedTokens(trial.usage)} billed, ${trial.resolved ? "resolved" : "unresolved"}</title></circle>`,
    );
    index += 1;
  }

  const legend = arms.map((arm, legendIndex) =>
    `<rect x="${padding.left + legendIndex * 140}" y="${height - 24}" width="10" height="10" fill="${colors[arm] ?? "#666"}" />` +
    `<text x="${padding.left + legendIndex * 140 + 16}" y="${height - 15}" font-size="12" fill="#333">${arm}</text>`,
  );

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="#fff" />`,
    `<line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + plotHeight}" stroke="#999" />`,
    `<line x1="${padding.left}" y1="${padding.top + plotHeight}" x2="${padding.left + plotWidth}" y2="${padding.top + plotHeight}" stroke="#999" />`,
    `<text x="${padding.left}" y="${padding.top - 8}" font-size="12" fill="#333">resolved ↑</text>`,
    `<text x="${padding.left + plotWidth / 2}" y="${height - 44}" font-size="12" fill="#333" text-anchor="middle">billed tokens per trial (max ${maxBilled})</text>`,
    `<text x="16" y="${padding.top + plotHeight / 2}" font-size="12" fill="#333" transform="rotate(-90 16 ${padding.top + plotHeight / 2})" text-anchor="middle">outcome</text>`,
    ...dots,
    ...legend,
    `</svg>`,
  ].join("\n");
}

/** Flat CSV so a spreadsheet can reproduce every table. */
export function renderTrialsCsv(records: TrialRecord[]): string {
  const header = [
    "arm",
    "task",
    "trial",
    "resolved",
    "duration_ms",
    "exit_code",
    "timed_out",
    "billed",
    "input",
    "output",
    "cache_read",
    "cache_write",
    "cost_usd",
    "parent_billed",
    "parent_peak_context",
    "children",
    "child_model",
    "context_amplification",
    "returned_share",
  ];
  const rows = records.map((record) =>
    [
      record.arm,
      record.taskId,
      String(record.trial),
      record.resolved ? "1" : "0",
      String(record.durationMs),
      String(record.exitCode),
      record.timedOut ? "1" : "0",
      String(billedTokens(record.usage)),
      String(record.usage.input),
      String(record.usage.output),
      String(record.usage.cacheRead),
      String(record.usage.cacheWrite),
      record.usage.costUsd.toFixed(6),
      String(record.parentBilled),
      String(record.parent?.peakContext ?? 0),
      String(record.children.length),
      record.childModel ?? "",
      record.contextAmplification === null ? "" : record.contextAmplification.toFixed(4),
      record.returnedShare === null ? "" : record.returnedShare.toFixed(6),
    ].join(","),
  );
  return `${[header.join(","), ...rows].join("\n")}\n`;
}

function readRecords(text: string): TrialRecord[] {
  const records: TrialRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    records.push(JSON.parse(trimmed) as TrialRecord);
  }
  return records;
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write("usage: node bench/report.ts <bench-output-dir>\n");
    process.exit(2);
  }
  const root = path.resolve(dir);
  const records = readRecords(await readFile(path.join(root, "trials.jsonl"), "utf8"));
  const plan = JSON.parse(await readFile(path.join(root, "plan.json"), "utf8")) as ReportPlan;
  const report = renderReport(records, plan);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(root, "REPORT.md"), report, { mode: 0o600 });
  await writeFile(path.join(root, "trials.csv"), renderTrialsCsv(records), { mode: 0o600 });
  await writeFile(path.join(root, "pareto.svg"), renderScatterSvg(records), { mode: 0o600 });
  process.stdout.write(`${report}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
