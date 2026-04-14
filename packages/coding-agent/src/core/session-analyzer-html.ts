import type {
	AggregateStats,
	AnalysisResult,
	ModelBreakdown,
	ProjectBreakdown,
	SessionMetrics,
	TimeSeriesPoint,
} from "./session-analyzer.js";

// ── Color palette ───────────────────────────────────────────────────
const COLORS = {
	bg: "#1a1a2e",
	surface: "#16213e",
	text: "#e0e0e0",
	muted: "#888",
	accent: "#0f3460",
	red: "#e94560",
	blue: "#0f3460",
	green: "#53d8a8",
	orange: "#f5a623",
	tableHeader: "#0f3460",
	tableRowAlt: "#1a1a2e",
	grid: "#333",
	warning: "#f5a623",
};

const CHART_PALETTE = [
	"#e94560",
	"#53d8a8",
	"#f5a623",
	"#5b8def",
	"#c678dd",
	"#56b6c2",
	"#e06c75",
	"#98c379",
	"#d19a66",
	"#61afef",
	"#be5046",
	"#7ec8e3",
	"#ff6b81",
	"#a29bfe",
	"#fdcb6e",
	"#6c5ce7",
	"#00b894",
	"#fd79a8",
	"#74b9ff",
	"#fab1a0",
];

// ── Helpers ─────────────────────────────────────────────────────────

function fmtDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

function fmtNum(v: number, decimals = 2): string {
	if (!Number.isFinite(v)) return "—";
	return v.toFixed(decimals);
}

function fmtPct(v: number): string {
	if (!Number.isFinite(v)) return "—";
	return `${v.toFixed(1)}%`;
}

function fmtCost(v: number): string {
	if (!Number.isFinite(v)) return "—";
	return `$${v.toFixed(2)}`;
}

function fmtNullNum(v: number | null, decimals = 2): string {
	return v === null ? "—" : fmtNum(v, decimals);
}

function escHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function shortenPath(cwd: string, segments = 3): string {
	const parts = cwd.replace(/\/$/, "").split("/").filter(Boolean);
	if (parts.length <= segments) return cwd;
	return `…/${parts.slice(-segments).join("/")}`;
}

function truncateModel(name: string, max = 40): string {
	return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

// ── SVG Chart Rendering ─────────────────────────────────────────────

interface LineChartOpts {
	title: string;
	points: TimeSeriesPoint[];
	width?: number;
	height?: number;
	yLabel?: string;
	splitDate?: Date;
	isPercent?: boolean;
	lowerIsBetter?: boolean;
	experimental?: boolean;
}

function niceRange(min: number, max: number): { lo: number; hi: number; step: number } {
	if (min === max) {
		if (min === 0) return { lo: 0, hi: 1, step: 0.2 };
		const pad = Math.abs(min) * 0.1 || 0.5;
		return niceRange(min - pad, max + pad);
	}
	const range = max - min;
	const rawStep = range / 5;
	const mag = 10 ** Math.floor(Math.log10(rawStep));
	let step: number;
	const ratio = rawStep / mag;
	if (ratio <= 1) step = mag;
	else if (ratio <= 2) step = 2 * mag;
	else if (ratio <= 5) step = 5 * mag;
	else step = 10 * mag;

	const lo = Math.floor(min / step) * step;
	const hi = Math.ceil(max / step) * step;
	return { lo, hi, step };
}

function renderLineChart(opts: LineChartOpts): string {
	const { title, points, splitDate, isPercent = false, lowerIsBetter = false, experimental = false } = opts;
	const width = opts.width ?? 700;
	const height = opts.height ?? 250;

	if (points.length === 0) {
		return `<div class="chart-card">
			<h3 class="chart-title">${escHtml(title)}${experimental ? ' <span class="experimental">experimental</span>' : ""}</h3>
			<p class="no-data">No data available</p>
		</div>`;
	}

	const padLeft = 60;
	const padRight = 20;
	const padTop = 30;
	const padBottom = 40;
	const plotW = width - padLeft - padRight;
	const plotH = height - padTop - padBottom;

	// Time range
	const times = points.map((p) => p.date.getTime());
	const minTime = Math.min(...times);
	const maxTime = Math.max(...times);
	const timeRange = maxTime - minTime || 1;

	// Value range
	const allValues = points.map((p) => p.value);
	const rollingValues = points.filter((p) => p.rollingAvg !== null).map((p) => p.rollingAvg as number);
	const allNums = [...allValues, ...rollingValues];
	const rawMin = Math.min(...allNums);
	const rawMax = Math.max(...allNums);
	const { lo: yMin, hi: yMax, step: yStep } = niceRange(rawMin, rawMax);
	const yRange = yMax - yMin || 1;

	function xPos(d: Date): number {
		return padLeft + ((d.getTime() - minTime) / timeRange) * plotW;
	}
	function yPos(v: number): number {
		return padTop + plotH - ((v - yMin) / yRange) * plotH;
	}

	// Grid lines
	let gridLines = "";
	for (let v = yMin; v <= yMax + yStep * 0.01; v += yStep) {
		const y = yPos(v);
		const label = isPercent ? `${fmtNum(v, 1)}%` : fmtNum(v, v >= 100 ? 0 : v >= 1 ? 1 : 2);
		gridLines += `<line x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}" stroke="${COLORS.grid}" stroke-width="0.5"/>`;
		gridLines += `<text x="${padLeft - 5}" y="${y + 4}" text-anchor="end" fill="${COLORS.muted}" font-size="10">${label}</text>`;
	}

	// X axis labels
	let xLabels = "";
	const uniqueDates = [...new Set(points.map((p) => fmtDate(p.date)))];
	const labelInterval = Math.max(1, Math.ceil(uniqueDates.length / 10));
	for (let i = 0; i < uniqueDates.length; i += labelInterval) {
		const date = new Date(uniqueDates[i]);
		const x = xPos(date);
		const shortLabel = uniqueDates[i].slice(5); // MM-DD
		xLabels += `<text x="${x}" y="${height - 5}" text-anchor="end" fill="${COLORS.muted}" font-size="9" transform="rotate(-45,${x},${height - 5})">${shortLabel}</text>`;
	}

	// Data dots
	const dotColor = `${COLORS.red}4D`; // 30% opacity
	let dots = "";
	for (const p of points) {
		dots += `<circle cx="${xPos(p.date)}" cy="${yPos(p.value)}" r="3" fill="${dotColor}"/>`;
	}

	// Rolling average line
	let avgLine = "";
	const rollingPts = points.filter((p) => p.rollingAvg !== null);
	if (rollingPts.length > 1) {
		const d = rollingPts.map((p) => `${xPos(p.date)},${yPos(p.rollingAvg as number)}`).join(" L ");
		avgLine = `<path d="M ${d}" fill="none" stroke="${COLORS.red}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
	}

	// Split date line
	let splitLine = "";
	if (splitDate && splitDate.getTime() >= minTime && splitDate.getTime() <= maxTime) {
		const x = xPos(splitDate);
		splitLine = `<line x1="${x}" y1="${padTop}" x2="${x}" y2="${padTop + plotH}" stroke="${COLORS.orange}" stroke-width="1.5" stroke-dasharray="6,4"/>`;
		splitLine += `<text x="${x + 4}" y="${padTop + 12}" fill="${COLORS.orange}" font-size="9">split</text>`;
	}

	const label = experimental ? ` <span class="experimental">experimental</span>` : "";

	return `<div class="chart-card">
		<h3 class="chart-title">${escHtml(title)}${label}${lowerIsBetter ? ' <span class="direction">↓ lower is better</span>' : ""}</h3>
		<svg viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMidYMid meet">
			<!-- grid -->
			${gridLines}
			<!-- axes -->
			<line x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${padTop + plotH}" stroke="${COLORS.grid}" stroke-width="1"/>
			<line x1="${padLeft}" y1="${padTop + plotH}" x2="${width - padRight}" y2="${padTop + plotH}" stroke="${COLORS.grid}" stroke-width="1"/>
			<!-- x labels -->
			${xLabels}
			<!-- data -->
			${dots}
			${avgLine}
			${splitLine}
		</svg>
	</div>`;
}

// ── Stacked Area Chart ──────────────────────────────────────────────

function renderModelDistributionChart(
	data: Array<{ date: Date; models: Record<string, number> }>,
	width = 700,
	height = 300,
): string {
	if (data.length === 0) {
		return `<div class="chart-card">
			<h3 class="chart-title">Model Usage Over Time</h3>
			<p class="no-data">No data available</p>
		</div>`;
	}

	// Collect all models, find top 10, group rest as "other"
	const modelCounts: Record<string, number> = {};
	for (const d of data) {
		for (const [m, count] of Object.entries(d.models)) {
			modelCounts[m] = (modelCounts[m] ?? 0) + count;
		}
	}
	const sorted = Object.entries(modelCounts).sort((a, b) => b[1] - a[1]);
	const topModels = sorted.slice(0, 10).map(([m]) => m);
	const hasOther = sorted.length > 10;

	const allModels = hasOther ? [...topModels, "other"] : topModels;

	// Normalize data to percentages
	const normalized = data.map((d) => {
		const total = Object.values(d.models).reduce((s, v) => s + v, 0) || 1;
		const result: Record<string, number> = {};
		let otherVal = 0;
		for (const [m, v] of Object.entries(d.models)) {
			if (topModels.includes(m)) {
				result[m] = (v / total) * 100;
			} else {
				otherVal += v;
			}
		}
		// Fill missing models with 0
		for (const m of topModels) {
			result[m] = result[m] ?? 0;
		}
		if (hasOther) {
			result.other = (otherVal / total) * 100;
		}
		return { date: d.date, models: result };
	});

	const padLeft = 60;
	const padRight = 20;
	const padTop = 30;
	const padBottom = 60;
	const plotW = width - padLeft - padRight;
	const plotH = height - padTop - padBottom;

	const times = normalized.map((d) => d.date.getTime());
	const minTime = Math.min(...times);
	const maxTime = Math.max(...times);
	const timeRange = maxTime - minTime || 1;

	function xPos(d: Date): number {
		return padLeft + ((d.getTime() - minTime) / timeRange) * plotW;
	}
	function yPos(v: number): number {
		return padTop + plotH - (v / 100) * plotH;
	}

	// Draw stacked areas (bottom-up)
	let areas = "";
	for (let mi = allModels.length - 1; mi >= 0; mi--) {
		const model = allModels[mi];
		const color = CHART_PALETTE[mi % CHART_PALETTE.length];

		// For each date, compute cumulative bottom and top
		const topPoints: string[] = [];
		const bottomPoints: string[] = [];

		for (const d of normalized) {
			const x = xPos(d.date);
			let cumBelow = 0;
			for (let j = 0; j < mi; j++) {
				cumBelow += d.models[allModels[j]] ?? 0;
			}
			const cumTop = cumBelow + (d.models[model] ?? 0);
			topPoints.push(`${x},${yPos(cumTop)}`);
			bottomPoints.push(`${x},${yPos(cumBelow)}`);
		}

		const pathD = `M ${topPoints.join(" L ")} L ${bottomPoints.reverse().join(" L ")} Z`;
		areas += `<path d="${pathD}" fill="${color}" fill-opacity="0.7" stroke="${color}" stroke-width="0.5"/>`;
	}

	// Y axis grid
	let gridLines = "";
	for (let v = 0; v <= 100; v += 20) {
		const y = yPos(v);
		gridLines += `<line x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}" stroke="${COLORS.grid}" stroke-width="0.5"/>`;
		gridLines += `<text x="${padLeft - 5}" y="${y + 4}" text-anchor="end" fill="${COLORS.muted}" font-size="10">${v}%</text>`;
	}

	// X axis labels
	let xLabels = "";
	const labelInterval = Math.max(1, Math.ceil(normalized.length / 10));
	for (let i = 0; i < normalized.length; i += labelInterval) {
		const d = normalized[i].date;
		const x = xPos(d);
		const label = fmtDate(d).slice(5);
		xLabels += `<text x="${x}" y="${padTop + plotH + 15}" text-anchor="end" fill="${COLORS.muted}" font-size="9" transform="rotate(-45,${x},${padTop + plotH + 15})">${label}</text>`;
	}

	// Legend
	let legend = "";
	for (let i = 0; i < allModels.length; i++) {
		const color = CHART_PALETTE[i % CHART_PALETTE.length];
		const name = escHtml(truncateModel(allModels[i], 30));
		legend += `<span class="legend-item"><span class="legend-swatch" style="background:${color}"></span>${name}</span>`;
	}

	return `<div class="chart-card">
		<h3 class="chart-title">Model Usage Over Time</h3>
		<svg viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMidYMid meet">
			${gridLines}
			<line x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${padTop + plotH}" stroke="${COLORS.grid}" stroke-width="1"/>
			<line x1="${padLeft}" y1="${padTop + plotH}" x2="${width - padRight}" y2="${padTop + plotH}" stroke="${COLORS.grid}" stroke-width="1"/>
			${xLabels}
			${areas}
		</svg>
		<div class="legend">${legend}</div>
	</div>`;
}

// ── Horizontal Bar Chart ────────────────────────────────────────────

function renderToolDistributionChart(distribution: Record<string, number>, width = 700): string {
	const sorted = Object.entries(distribution)
		.filter(([, v]) => v > 0)
		.sort((a, b) => b[1] - a[1]);

	if (sorted.length === 0) {
		return `<div class="chart-card">
			<h3 class="chart-title">Overall Tool Distribution</h3>
			<p class="no-data">No data available</p>
		</div>`;
	}

	const barHeight = 24;
	const gap = 4;
	const padLeft = 120;
	const padRight = 50;
	const padTop = 10;
	const padBottom = 10;
	const chartHeight = padTop + sorted.length * (barHeight + gap) + padBottom;
	const maxVal = Math.max(...sorted.map(([, v]) => v));
	const barAreaW = width - padLeft - padRight;

	let bars = "";
	for (let i = 0; i < sorted.length; i++) {
		const [name, val] = sorted[i];
		const y = padTop + i * (barHeight + gap);
		const barW = maxVal > 0 ? (val / maxVal) * barAreaW : 0;
		const color = CHART_PALETTE[i % CHART_PALETTE.length];
		bars += `<text x="${padLeft - 8}" y="${y + barHeight / 2 + 4}" text-anchor="end" fill="${COLORS.text}" font-size="11">${escHtml(truncateModel(name, 18))}</text>`;
		bars += `<rect x="${padLeft}" y="${y}" width="${barW}" height="${barHeight}" rx="3" fill="${color}" fill-opacity="0.8"/>`;
		bars += `<text x="${padLeft + barW + 5}" y="${y + barHeight / 2 + 4}" fill="${COLORS.muted}" font-size="10">${fmtNum(val, 1)}%</text>`;
	}

	return `<div class="chart-card">
		<h3 class="chart-title">Overall Tool Distribution</h3>
		<svg viewBox="0 0 ${width} ${chartHeight}" width="100%" preserveAspectRatio="xMidYMid meet">
			${bars}
		</svg>
	</div>`;
}

// ── Tables ──────────────────────────────────────────────────────────

function renderAggregateRow(label: string, stats: AggregateStats): string {
	return `<tr>
		<td>${escHtml(label)}</td>
		<td>${stats.sessionCount}</td>
		<td>${fmtNum(stats.meanErrorRate, 3)}</td>
		<td>${fmtPct(stats.successRate)}</td>
		<td>${fmtPct(stats.abortRate)}</td>
		<td>${fmtNullNum(stats.meanReadEditRatio)}</td>
		<td>${fmtNullNum(stats.meanWriteVsEditPercent, 1)}${stats.meanWriteVsEditPercent !== null ? "%" : ""}</td>
		<td>${fmtNum(stats.meanSelfCorrectionFreq, 1)}</td>
		<td>${fmtNum(stats.meanToolCallVolume, 0)}</td>
		<td>${fmtNum(stats.meanSessionLength, 0)}</td>
		<td>${fmtNullNum(stats.meanTokensPerToolCall, 0)}</td>
		<td>${fmtCost(stats.totalCost)}</td>
	</tr>`;
}

function changeColor(before: number | null, after: number | null, lowerIsBetter: boolean): string {
	if (before === null || after === null) return COLORS.text;
	if (before === after) return COLORS.text;
	const improved = lowerIsBetter ? after < before : after > before;
	return improved ? COLORS.green : COLORS.red;
}

function fmtChange(before: number | null, after: number | null, decimals = 2, suffix = ""): string {
	if (before === null || after === null) return "—";
	const diff = after - before;
	const sign = diff > 0 ? "+" : "";
	return `${sign}${diff.toFixed(decimals)}${suffix}`;
}

function renderBeforeAfterTable(before: AggregateStats, after: AggregateStats): string {
	interface MetricRow {
		label: string;
		bVal: string;
		aVal: string;
		change: string;
		color: string;
	}

	const rows: MetricRow[] = [
		{
			label: "Sessions",
			bVal: String(before.sessionCount),
			aVal: String(after.sessionCount),
			change: fmtChange(before.sessionCount, after.sessionCount, 0),
			color: COLORS.text,
		},
		{
			label: "Error Rate",
			bVal: fmtNum(before.meanErrorRate, 3),
			aVal: fmtNum(after.meanErrorRate, 3),
			change: fmtChange(before.meanErrorRate, after.meanErrorRate, 3),
			color: changeColor(before.meanErrorRate, after.meanErrorRate, true),
		},
		{
			label: "Success Rate",
			bVal: fmtPct(before.successRate),
			aVal: fmtPct(after.successRate),
			change: fmtChange(before.successRate, after.successRate, 1, "%"),
			color: changeColor(before.successRate, after.successRate, false),
		},
		{
			label: "Abort Rate",
			bVal: fmtPct(before.abortRate),
			aVal: fmtPct(after.abortRate),
			change: fmtChange(before.abortRate, after.abortRate, 1, "%"),
			color: changeColor(before.abortRate, after.abortRate, true),
		},
		{
			label: "Read:Edit Ratio",
			bVal: fmtNullNum(before.meanReadEditRatio),
			aVal: fmtNullNum(after.meanReadEditRatio),
			change: fmtChange(before.meanReadEditRatio, after.meanReadEditRatio),
			color: COLORS.text,
		},
		{
			label: "Write vs Edit %",
			bVal: fmtNullNum(before.meanWriteVsEditPercent, 1),
			aVal: fmtNullNum(after.meanWriteVsEditPercent, 1),
			change: fmtChange(before.meanWriteVsEditPercent, after.meanWriteVsEditPercent, 1, "%"),
			color: changeColor(before.meanWriteVsEditPercent, after.meanWriteVsEditPercent, true),
		},
		{
			label: "Self-Correction Freq",
			bVal: fmtNum(before.meanSelfCorrectionFreq, 1),
			aVal: fmtNum(after.meanSelfCorrectionFreq, 1),
			change: fmtChange(before.meanSelfCorrectionFreq, after.meanSelfCorrectionFreq, 1),
			color: COLORS.text,
		},
		{
			label: "Simplest-Fix Mentions",
			bVal: fmtNum(before.meanSimplestFixMentions, 1),
			aVal: fmtNum(after.meanSimplestFixMentions, 1),
			change: fmtChange(before.meanSimplestFixMentions, after.meanSimplestFixMentions, 1),
			color: COLORS.text,
		},
		{
			label: "Avg Tool Calls",
			bVal: fmtNum(before.meanToolCallVolume, 0),
			aVal: fmtNum(after.meanToolCallVolume, 0),
			change: fmtChange(before.meanToolCallVolume, after.meanToolCallVolume, 0),
			color: COLORS.text,
		},
		{
			label: "Avg Session Length",
			bVal: fmtNum(before.meanSessionLength, 0),
			aVal: fmtNum(after.meanSessionLength, 0),
			change: fmtChange(before.meanSessionLength, after.meanSessionLength, 0),
			color: COLORS.text,
		},
		{
			label: "Avg Tokens/Call",
			bVal: fmtNullNum(before.meanTokensPerToolCall, 0),
			aVal: fmtNullNum(after.meanTokensPerToolCall, 0),
			change: fmtChange(before.meanTokensPerToolCall, after.meanTokensPerToolCall, 0),
			color: COLORS.text,
		},
		{
			label: "Total Cost",
			bVal: fmtCost(before.totalCost),
			aVal: fmtCost(after.totalCost),
			change: fmtChange(before.totalCost, after.totalCost, 2),
			color: COLORS.text,
		},
	];

	const tableRows = rows
		.map(
			(r) =>
				`<tr>
			<td>${escHtml(r.label)}</td>
			<td>${r.bVal}</td>
			<td>${r.aVal}</td>
			<td style="color:${r.color}">${r.change}</td>
		</tr>`,
		)
		.join("\n");

	return `<div class="card">
		<h2>📊 Before / After Comparison</h2>
		<table>
			<thead><tr><th>Metric</th><th>Before</th><th>After</th><th>Change</th></tr></thead>
			<tbody>${tableRows}</tbody>
		</table>
	</div>`;
}

function renderParentSubagentTable(parent: AggregateStats, subagent: AggregateStats): string {
	const headers = `<thead><tr>
		<th>Type</th><th>Sessions</th><th>Error Rate</th><th>Success %</th><th>Abort %</th>
		<th>Read:Edit</th><th>Write vs Edit %</th><th>Self-Corr.</th>
		<th>Avg Tool Calls</th><th>Avg Turns</th><th>Tokens/Call</th><th>Cost</th>
	</tr></thead>`;

	return `<div class="card">
		<h2>👥 Parent vs Subagent</h2>
		<div class="table-wrap">
		<table>
			${headers}
			<tbody>
				${renderAggregateRow("Parent", parent)}
				${renderAggregateRow("Subagent", subagent)}
			</tbody>
		</table>
		</div>
	</div>`;
}

function renderModelBreakdownTable(models: ModelBreakdown[]): string {
	const sorted = [...models].sort((a, b) => b.stats.sessionCount - a.stats.sessionCount);

	const rows = sorted
		.map(
			(m) =>
				`<tr>
			<td>${m.lowN ? "⚠️ " : ""}${escHtml(truncateModel(m.model))}</td>
			<td>${escHtml(m.provider)}</td>
			<td>${m.stats.sessionCount}</td>
			<td>${fmtNum(m.stats.meanErrorRate, 3)}</td>
			<td>${fmtPct(m.stats.successRate)}</td>
			<td>${fmtPct(m.stats.abortRate)}</td>
			<td>${fmtNum(m.stats.meanToolCallVolume, 0)}</td>
			<td>${fmtNullNum(m.stats.meanTokensPerToolCall, 0)}</td>
			<td>${fmtCost(m.stats.totalCost)}</td>
		</tr>`,
		)
		.join("\n");

	return `<div class="card">
		<h2>🤖 Per-Model Breakdown</h2>
		<p class="note">⚠️ = fewer than 10 sessions (low confidence)</p>
		<div class="table-wrap">
		<table>
			<thead><tr>
				<th>Model</th><th>Provider</th><th>Sessions</th><th>Error Rate</th>
				<th>Success %</th><th>Abort %</th><th>Avg Tool Calls</th>
				<th>Tokens/Call</th><th>Cost</th>
			</tr></thead>
			<tbody>${rows}</tbody>
		</table>
		</div>
	</div>`;
}

function renderProjectBreakdownTable(projects: ProjectBreakdown[]): string {
	const sorted = [...projects].sort((a, b) => b.stats.sessionCount - a.stats.sessionCount).slice(0, 20);

	const rows = sorted
		.map(
			(p) =>
				`<tr>
			<td title="${escHtml(p.cwd)}">${escHtml(shortenPath(p.cwd))}</td>
			<td>${p.stats.sessionCount}</td>
			<td>${fmtNum(p.stats.meanErrorRate, 3)}</td>
			<td>${fmtPct(p.stats.successRate)}</td>
			<td>${fmtNum(p.stats.meanToolCallVolume, 0)}</td>
			<td>${fmtCost(p.stats.totalCost)}</td>
		</tr>`,
		)
		.join("\n");

	return `<div class="card">
		<h2>📁 Per-Project Breakdown</h2>
		<div class="table-wrap">
		<table>
			<thead><tr>
				<th>Project</th><th>Sessions</th><th>Error Rate</th>
				<th>Success %</th><th>Avg Tool Calls</th><th>Cost</th>
			</tr></thead>
			<tbody>${rows}</tbody>
		</table>
		</div>
	</div>`;
}

// ── Aggregate Tool Distribution ─────────────────────────────────────

function aggregateToolDistribution(sessions: SessionMetrics[]): Record<string, number> {
	const totals: Record<string, number> = {};
	let count = 0;
	for (const s of sessions) {
		for (const [tool, pct] of Object.entries(s.toolDistribution)) {
			totals[tool] = (totals[tool] ?? 0) + pct;
		}
		count++;
	}
	if (count === 0) return {};
	const result: Record<string, number> = {};
	for (const [tool, sum] of Object.entries(totals)) {
		result[tool] = sum / count;
	}
	return result;
}

// ── Main Export ─────────────────────────────────────────────────────

export function generateAnalysisHtml(result: AnalysisResult): string {
	if (result.totalSessions === 0) {
		return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>dreb Session Analysis</title>
<style>body{background:${COLORS.bg};color:${COLORS.text};font-family:'SF Mono','Fira Code','Cascadia Code',monospace;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;}
.empty{text-align:center;padding:2rem;}.empty h1{font-size:1.5rem;margin-bottom:1rem;}</style>
</head><body><div class="empty"><h1>dreb Session Analysis</h1><p>No session data found.</p></div></body></html>`;
	}

	// ── Header ──────────────────────────────────────────────────────
	const splitInfo = result.splitDate
		? `<p class="split-date">Split date: <strong>${fmtDate(result.splitDate)}</strong></p>`
		: "";

	const header = `<div class="header">
		<h1>dreb Session Analysis</h1>
		<p class="subtitle">${fmtDate(result.dateRange.start)} — ${fmtDate(result.dateRange.end)} · ${result.totalSessions} sessions · Generated ${result.generatedAt.toISOString().slice(0, 19).replace("T", " ")} UTC</p>
		${splitInfo}
	</div>`;

	// ── Caveats ─────────────────────────────────────────────────────
	const caveats = `<div class="caveats">
		<h3>⚠️ Caveats</h3>
		<ul>
			<li><strong>Task-mix confound:</strong> Metric shifts may reflect changes in work types (debugging vs greenfield vs refactoring) rather than model quality changes.</li>
			<li><strong>Sample size:</strong> Small sample sizes may produce unreliable averages. Models with &lt;10 sessions are flagged.</li>
			<li><strong>Experimental metrics:</strong> Self-correction and simplest-fix metrics are experimental noisy proxies.</li>
		</ul>
	</div>`;

	// ── Before/After ────────────────────────────────────────────────
	const beforeAfterSection = result.beforeAfter
		? renderBeforeAfterTable(result.beforeAfter.before, result.beforeAfter.after)
		: "";

	// ── Time-Series Charts ──────────────────────────────────────────
	const ts = result.timeSeries;
	const charts = [
		renderLineChart({
			title: "Error Rate",
			points: ts.errorRate,
			splitDate: result.splitDate,
			lowerIsBetter: true,
		}),
		renderLineChart({
			title: "Read:Edit Ratio",
			points: ts.readEditRatio,
			splitDate: result.splitDate,
		}),
		renderLineChart({
			title: "Write vs Edit %",
			points: ts.writeVsEditPercent,
			splitDate: result.splitDate,
			isPercent: true,
			lowerIsBetter: true,
		}),
		renderLineChart({
			title: "Self-Correction Frequency (per 1K tool calls)",
			points: ts.selfCorrectionFreq,
			splitDate: result.splitDate,
			experimental: true,
		}),
		renderLineChart({
			title: "Simplest-Fix Mentions (per 1K tool calls)",
			points: ts.simplestFixMentions,
			splitDate: result.splitDate,
			experimental: true,
		}),
		renderLineChart({
			title: "Tool Call Volume",
			points: ts.toolCallVolume,
			splitDate: result.splitDate,
		}),
		renderLineChart({
			title: "Session Length (turns)",
			points: ts.sessionLength,
			splitDate: result.splitDate,
		}),
		renderLineChart({
			title: "Tokens per Tool Call",
			points: ts.tokensPerToolCall,
			splitDate: result.splitDate,
		}),
		renderLineChart({
			title: "Success Rate",
			points: ts.successRate,
			splitDate: result.splitDate,
			isPercent: true,
		}),
		renderLineChart({
			title: "Abort Rate",
			points: ts.abortRate,
			splitDate: result.splitDate,
			isPercent: true,
			lowerIsBetter: true,
		}),
	].join("\n");

	const timeSeriesSection = `<div class="card">
		<h2>📈 Time-Series (7-day Rolling Averages)</h2>
		${charts}
	</div>`;

	// ── Model Distribution ──────────────────────────────────────────
	const modelDistSection = renderModelDistributionChart(result.modelDistribution);

	// ── Tool Distribution ───────────────────────────────────────────
	const toolDist = aggregateToolDistribution(result.sessions);
	const toolDistSection = renderToolDistributionChart(toolDist);

	// ── Parent vs Subagent ──────────────────────────────────────────
	const parentSubSection = renderParentSubagentTable(result.parentVsSubagent.parent, result.parentVsSubagent.subagent);

	// ── Model Breakdown ─────────────────────────────────────────────
	const modelBreakdownSection = renderModelBreakdownTable(result.modelBreakdown);

	// ── Project Breakdown ───────────────────────────────────────────
	const projectBreakdownSection = renderProjectBreakdownTable(result.projectBreakdown);

	// ── CSS ─────────────────────────────────────────────────────────
	const css = `
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body {
			background: ${COLORS.bg};
			color: ${COLORS.text};
			font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
			font-size: 13px;
			line-height: 1.5;
			padding: 2rem 1rem;
		}
		.container {
			max-width: 800px;
			margin: 0 auto;
		}
		.header {
			text-align: center;
			margin-bottom: 2rem;
		}
		.header h1 {
			font-size: 1.8rem;
			margin-bottom: 0.5rem;
			color: ${COLORS.text};
		}
		.subtitle {
			color: ${COLORS.muted};
			font-size: 0.85rem;
		}
		.split-date {
			margin-top: 0.5rem;
			color: ${COLORS.orange};
			font-size: 0.95rem;
		}
		.caveats {
			background: ${COLORS.surface};
			border: 1px solid ${COLORS.warning}55;
			border-left: 4px solid ${COLORS.warning};
			border-radius: 8px;
			padding: 1rem 1.25rem;
			margin-bottom: 1.5rem;
		}
		.caveats h3 {
			color: ${COLORS.warning};
			font-size: 0.95rem;
			margin-bottom: 0.5rem;
		}
		.caveats ul {
			list-style: none;
			padding: 0;
		}
		.caveats li {
			margin-bottom: 0.4rem;
			font-size: 0.82rem;
			color: ${COLORS.muted};
			line-height: 1.5;
		}
		.caveats li strong {
			color: ${COLORS.text};
		}
		.card {
			background: ${COLORS.surface};
			border: 1px solid ${COLORS.accent};
			border-radius: 8px;
			padding: 1.25rem;
			margin-bottom: 1.5rem;
		}
		.card h2 {
			font-size: 1.1rem;
			margin-bottom: 1rem;
			color: ${COLORS.text};
		}
		.chart-card {
			margin-bottom: 1.5rem;
		}
		.chart-title {
			font-size: 0.9rem;
			margin-bottom: 0.5rem;
			color: ${COLORS.text};
		}
		.experimental {
			font-size: 0.7rem;
			color: ${COLORS.orange};
			background: ${COLORS.orange}22;
			padding: 1px 6px;
			border-radius: 4px;
			font-weight: normal;
			vertical-align: middle;
		}
		.direction {
			font-size: 0.7rem;
			color: ${COLORS.muted};
			font-weight: normal;
		}
		.no-data {
			color: ${COLORS.muted};
			font-style: italic;
			padding: 1rem 0;
		}
		.note {
			color: ${COLORS.muted};
			font-size: 0.8rem;
			margin-bottom: 0.75rem;
		}
		.table-wrap {
			overflow-x: auto;
		}
		table {
			width: 100%;
			border-collapse: collapse;
			font-size: 0.82rem;
		}
		thead th {
			background: ${COLORS.tableHeader};
			color: ${COLORS.text};
			padding: 8px 10px;
			text-align: left;
			font-weight: 600;
			border-bottom: 2px solid ${COLORS.grid};
			white-space: nowrap;
		}
		tbody td {
			padding: 6px 10px;
			border-bottom: 1px solid ${COLORS.grid};
			white-space: nowrap;
		}
		tbody tr:nth-child(even) {
			background: ${COLORS.tableRowAlt};
		}
		.legend {
			display: flex;
			flex-wrap: wrap;
			gap: 0.75rem;
			padding-top: 0.75rem;
		}
		.legend-item {
			display: flex;
			align-items: center;
			gap: 4px;
			font-size: 0.78rem;
			color: ${COLORS.muted};
		}
		.legend-swatch {
			display: inline-block;
			width: 12px;
			height: 12px;
			border-radius: 2px;
		}
		svg text {
			font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
		}
	`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dreb Session Analysis</title>
<style>${css}</style>
</head>
<body>
<div class="container">
${header}
${caveats}
${beforeAfterSection}
${timeSeriesSection}
${modelDistSection}
${toolDistSection}
${parentSubSection}
${modelBreakdownSection}
${projectBreakdownSection}
</div>
</body>
</html>`;
}
