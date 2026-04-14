import type {
	AnalysisTimeline,
	DateComparison,
	FullSessionAnalysis,
	GroupSummary,
	SessionAnalysis,
} from "./session-analyzer.js";

// ── Helpers ─────────────────────────────────────────────────────────────

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtNum(v: number | null, suffix = ""): string {
	if (v === null) return "n/a";
	return `${v.toFixed(1)}${suffix}`;
}

function changeArrow(current: number | null, previous: number | null): string {
	if (current === null || previous === null) return "—";
	if (previous === 0) return current === 0 ? "→" : "↑ new";
	const change = ((current - previous) / Math.abs(previous)) * 100;
	if (Math.abs(change) < 1) return "→";
	const arrow = change > 0 ? "↑" : "↓";
	return `${arrow} ${change > 0 ? "+" : ""}${change.toFixed(0)}%`;
}

// ── Colors (Tokyo Night-ish palette) ────────────────────────────────────

const COLORS = {
	bg: "#1a1a1a",
	surface: "#242424",
	border: "#3b3b3b",
	text: "#c0caf5",
	dim: "#787c99",
	accent: "#7aa2f7",
	green: "#9ece6a",
	yellow: "#e0af68",
	red: "#f7768e",
	purple: "#bb9af7",
	cyan: "#7dcfff",
	orange: "#ff9e64",
};

const BAR_COLORS = [COLORS.accent, COLORS.green, COLORS.yellow, COLORS.purple, COLORS.cyan, COLORS.orange, COLORS.red];

// ── Section builders ────────────────────────────────────────────────────

function renderCurrentSession(current: SessionAnalysis): string {
	const rows: [string, string][] = [];
	if (current.model)
		rows.push(["Model", esc(current.provider ? `${current.provider}/${current.model}` : current.model)]);
	rows.push(["Tool Calls", String(current.totalToolCalls)]);
	rows.push(["Tokens", current.totalTokens.toLocaleString()]);
	if (current.totalCost > 0) rows.push(["Cost", `$${current.totalCost.toFixed(4)}`]);
	rows.push(["Read:Edit Ratio", fmtNum(current.readEditRatio)]);
	rows.push(["Write vs Edit", fmtNum(current.writeVsEditPercent, "%")]);
	rows.push(["Error Rate", fmtNum(current.errorRate, "%")]);
	rows.push(["Self-Correction", fmtNum(current.selfCorrectionPer1K, " per 1K calls")]);

	const tableRows = rows
		.map(([label, value]) => `<tr><td class="label">${esc(label)}</td><td>${value}</td></tr>`)
		.join("\n");

	return `
<section>
  <h2>Current Session</h2>
  <table class="kv-table">
    ${tableRows}
  </table>
</section>`;
}

function renderToolDistribution(dist: Record<string, number>): string {
	const entries = Object.entries(dist).sort((a, b) => b[1] - a[1]);
	if (entries.length === 0) return "";
	const maxCount = entries[0][1];

	const bars = entries
		.map(([name, count], i) => {
			const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
			const color = BAR_COLORS[i % BAR_COLORS.length];
			return `<div class="bar-row">
  <span class="bar-label">${esc(name)}</span>
  <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${color}"></div></div>
  <span class="bar-count">${count}</span>
</div>`;
		})
		.join("\n");

	return `
<section>
  <h2>Tool Distribution</h2>
  <div class="bar-chart">
    ${bars}
  </div>
</section>`;
}

function renderTrends(timeline: AnalysisTimeline): string {
	const periods = timeline.periods;
	const firstLabel = periods[0].label;
	const lastLabel = periods[periods.length - 1].label;

	interface MetricRow {
		name: string;
		values: (number | null)[];
		suffix: string;
		color: string;
	}

	const metrics: MetricRow[] = [
		{ name: "Read:Edit", values: periods.map((p) => p.metrics.avgReadEditRatio), suffix: "", color: COLORS.accent },
		{ name: "Error Rate", values: periods.map((p) => p.metrics.avgErrorRate), suffix: "%", color: COLORS.red },
		{
			name: "Self-Correction",
			values: periods.map((p) => p.metrics.avgSelfCorrectionPer1K),
			suffix: "/1K",
			color: COLORS.yellow,
		},
		{
			name: "Cost/week",
			values: periods.map((p) => (p.metrics.totalCost > 0 ? p.metrics.totalCost : null)),
			suffix: "",
			color: COLORS.green,
		},
	];

	const renderMetricChart = (metric: MetricRow): string => {
		const nonNull = metric.values.filter((v): v is number => v !== null);
		if (nonNull.length === 0) return "";

		const max = Math.max(...nonNull);
		const min = Math.min(...nonNull);
		const range = max - min;

		const columns = metric.values
			.map((v, i) => {
				const heightPct = v === null ? 0 : range === 0 ? 50 : ((v - min) / range) * 80 + 10;
				const valueLabel =
					v === null ? "" : metric.name === "Cost/week" ? `$${v.toFixed(2)}` : `${v.toFixed(1)}${metric.suffix}`;
				const opacity = v === null ? "0.15" : "1";
				return `<div class="chart-col">
  <div class="chart-bar-wrapper">
    <div class="chart-bar" style="height:${heightPct.toFixed(0)}%;background:${metric.color};opacity:${opacity}" title="${esc(valueLabel)}"></div>
  </div>
  ${i === 0 ? "" : ""}
</div>`;
			})
			.join("\n");

		return `
<div class="metric-chart">
  <h3>${esc(metric.name)}</h3>
  <div class="chart-container">
    ${columns}
  </div>
  <div class="chart-labels">
    ${periods.map((p) => `<span>${esc(p.label)}</span>`).join("\n    ")}
  </div>
</div>`;
	};

	const charts = metrics
		.map(renderMetricChart)
		.filter((s) => s.length > 0)
		.join("\n");

	return `
<section>
  <h2>Trends <span class="dim">(${timeline.totalSessions} sessions, ${periods.length} weeks: ${esc(firstLabel)} – ${esc(lastLabel)})</span></h2>
  <div class="trends-grid">
    ${charts}
  </div>
</section>`;
}

function renderGroupTable(title: string, groups: GroupSummary[]): string {
	if (groups.length === 0) return "";

	const rows = groups
		.map(
			(g) => `<tr>
  <td>${esc(g.groupKey)}</td>
  <td class="num">${g.sessionCount}</td>
  <td class="num">${fmtNum(g.avgReadEditRatio)}</td>
  <td class="num">${fmtNum(g.avgErrorRate, "%")}</td>
</tr>`,
		)
		.join("\n");

	return `
<section>
  <h2>${esc(title)}</h2>
  <table class="data-table">
    <thead>
      <tr><th>Name</th><th>Sessions</th><th>Avg Read:Edit</th><th>Avg Error Rate</th></tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</section>`;
}

function renderComparison(comparison: DateComparison): string {
	const dateStr = comparison.splitDate.toISOString().slice(0, 10);
	const { before: b, after: a } = comparison;

	interface CompRow {
		label: string;
		beforeVal: string;
		afterVal: string;
		change: string;
	}

	const rows: CompRow[] = [
		{
			label: "Read:Edit",
			beforeVal: fmtNum(b.avgReadEditRatio),
			afterVal: fmtNum(a.avgReadEditRatio),
			change: changeArrow(a.avgReadEditRatio, b.avgReadEditRatio),
		},
		{
			label: "Write vs Edit",
			beforeVal: fmtNum(b.avgWriteVsEditPercent, "%"),
			afterVal: fmtNum(a.avgWriteVsEditPercent, "%"),
			change: changeArrow(a.avgWriteVsEditPercent, b.avgWriteVsEditPercent),
		},
		{
			label: "Error Rate",
			beforeVal: fmtNum(b.avgErrorRate, "%"),
			afterVal: fmtNum(a.avgErrorRate, "%"),
			change: changeArrow(a.avgErrorRate, b.avgErrorRate),
		},
		{
			label: "Self-Correction",
			beforeVal: fmtNum(b.avgSelfCorrectionPer1K, "/1K"),
			afterVal: fmtNum(a.avgSelfCorrectionPer1K, "/1K"),
			change: changeArrow(a.avgSelfCorrectionPer1K, b.avgSelfCorrectionPer1K),
		},
		{
			label: "Cost",
			beforeVal: `$${b.totalCost.toFixed(4)}`,
			afterVal: `$${a.totalCost.toFixed(4)}`,
			change: changeArrow(a.totalCost, b.totalCost),
		},
		{
			label: "Tokens/call",
			beforeVal: fmtNum(b.avgTokensPerToolCall),
			afterVal: fmtNum(a.avgTokensPerToolCall),
			change: changeArrow(a.avgTokensPerToolCall, b.avgTokensPerToolCall),
		},
	];

	const tableRows = rows
		.map(
			(r) => `<tr>
  <td class="label">${esc(r.label)}</td>
  <td class="num">${r.beforeVal}</td>
  <td class="num">${r.afterVal}</td>
  <td class="change">${esc(r.change)}</td>
</tr>`,
		)
		.join("\n");

	return `
<section>
  <h2>Comparison: split at ${esc(dateStr)}</h2>
  <table class="data-table">
    <thead>
      <tr><th>Metric</th><th>Before (${b.sessionCount})</th><th>After (${a.sessionCount})</th><th>Change</th></tr>
    </thead>
    <tbody>
      ${tableRows}
    </tbody>
  </table>
</section>`;
}

// ── Main export ─────────────────────────────────────────────────────────

export function generateAnalysisHtml(analysis: FullSessionAnalysis): string {
	const { current, timeline, groups, comparison } = analysis;

	const sections: string[] = [];
	sections.push(renderCurrentSession(current));
	sections.push(renderToolDistribution(current.toolDistribution));

	if (timeline) {
		sections.push(renderTrends(timeline));
	}

	if (groups?.byModel && groups.byModel.length > 0) {
		sections.push(renderGroupTable("By Model", groups.byModel));
	}

	if (groups?.byType && groups.byType.length > 0) {
		sections.push(renderGroupTable("By Agent Type", groups.byType));
	}

	if (comparison) {
		sections.push(renderComparison(comparison));
	}

	const body = sections.filter((s) => s.length > 0).join("\n");

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>dreb Session Analysis</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: "JetBrains Mono", "Fira Code", "SF Mono", "Cascadia Code", "Consolas", monospace;
    background: ${COLORS.bg};
    color: ${COLORS.text};
    padding: 2rem;
    max-width: 960px;
    margin: 0 auto;
    line-height: 1.6;
  }

  h1 {
    color: ${COLORS.accent};
    font-size: 1.4rem;
    margin-bottom: 0.5rem;
    border-bottom: 1px solid ${COLORS.border};
    padding-bottom: 0.5rem;
  }

  h2 {
    color: ${COLORS.text};
    font-size: 1.1rem;
    margin-bottom: 0.75rem;
  }

  h2 .dim { color: ${COLORS.dim}; font-size: 0.85rem; font-weight: normal; }

  h3 {
    color: ${COLORS.dim};
    font-size: 0.85rem;
    font-weight: normal;
    margin-bottom: 0.5rem;
  }

  section {
    background: ${COLORS.surface};
    border: 1px solid ${COLORS.border};
    border-radius: 6px;
    padding: 1.25rem;
    margin-bottom: 1.25rem;
  }

  /* Key-value table (current session) */
  .kv-table { width: 100%; }
  .kv-table td { padding: 0.2rem 0; }
  .kv-table .label { color: ${COLORS.dim}; width: 180px; }

  /* Data tables */
  .data-table { width: 100%; border-collapse: collapse; }
  .data-table th {
    text-align: left;
    color: ${COLORS.dim};
    font-weight: normal;
    font-size: 0.85rem;
    padding: 0.4rem 0.75rem;
    border-bottom: 1px solid ${COLORS.border};
  }
  .data-table td {
    padding: 0.4rem 0.75rem;
    border-bottom: 1px solid ${COLORS.border}22;
  }
  .data-table .num { text-align: right; }
  .data-table .label { color: ${COLORS.dim}; }
  .data-table .change { text-align: right; }

  /* Horizontal bar chart */
  .bar-chart { display: flex; flex-direction: column; gap: 0.35rem; }
  .bar-row { display: flex; align-items: center; gap: 0.5rem; }
  .bar-label { width: 120px; text-align: right; color: ${COLORS.dim}; font-size: 0.85rem; flex-shrink: 0; }
  .bar-track { flex: 1; height: 18px; background: ${COLORS.bg}; border-radius: 3px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 3px; transition: width 0.3s; min-width: 2px; }
  .bar-count { width: 40px; text-align: right; font-size: 0.85rem; color: ${COLORS.dim}; flex-shrink: 0; }

  /* Trend charts */
  .trends-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; }
  @media (max-width: 700px) { .trends-grid { grid-template-columns: 1fr; } }

  .metric-chart {
    background: ${COLORS.bg};
    border: 1px solid ${COLORS.border};
    border-radius: 4px;
    padding: 0.75rem;
  }

  .chart-container {
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 100px;
  }

  .chart-col { flex: 1; display: flex; flex-direction: column; align-items: stretch; height: 100%; }
  .chart-bar-wrapper { flex: 1; display: flex; align-items: flex-end; }
  .chart-bar { width: 100%; border-radius: 2px 2px 0 0; min-height: 2px; }

  .chart-labels {
    display: flex;
    gap: 3px;
    margin-top: 0.35rem;
  }
  .chart-labels span {
    flex: 1;
    text-align: center;
    font-size: 0.65rem;
    color: ${COLORS.dim};
  }

  .footer {
    color: ${COLORS.dim};
    font-size: 0.8rem;
    margin-top: 1rem;
    padding-top: 0.75rem;
    border-top: 1px solid ${COLORS.border};
  }
</style>
</head>
<body>
<h1>dreb Session Analysis</h1>
${body}
<div class="footer">
  Metrics are noisy proxies — interpret relative to your project's own baseline, not as absolute values.
</div>
</body>
</html>`;
}
