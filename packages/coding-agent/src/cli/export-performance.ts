/**
 * CLI performance data export helper
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { getPerformanceLogPath } from "../config.js";
import type { PerformanceEntry } from "../core/performance-tracker.js";

export interface ExportOptions {
	format: "png" | "csv";
	window: "24h" | "7d" | "30d";
	outputPath?: string;
}

interface GroupedData {
	provider: string;
	modelId: string;
	tpsValues: number[];
	timestamps: number[];
}

function getWindowMs(window: ExportOptions["window"]): number {
	switch (window) {
		case "24h":
			return 24 * 60 * 60 * 1000;
		case "7d":
			return 7 * 24 * 60 * 60 * 1000;
		case "30d":
			return 30 * 24 * 60 * 60 * 1000;
	}
}

function computeMedian(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) {
		return sorted[mid];
	}
	return (sorted[mid - 1] + sorted[mid]) / 2;
}

function computeMean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((a, b) => a + b, 0) / values.length;
}

function readPerformanceEntries(logPath: string): PerformanceEntry[] {
	try {
		const content = readFileSync(logPath, "utf8");
		const entries: PerformanceEntry[] = [];
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				entries.push(JSON.parse(line) as PerformanceEntry);
			} catch {
				// Skip malformed lines
			}
		}
		return entries;
	} catch {
		return [];
	}
}

function groupEntries(entries: PerformanceEntry[], windowMs: number): Map<string, GroupedData> {
	const cutoff = Date.now() - windowMs;
	const groups = new Map<string, GroupedData>();

	for (const entry of entries) {
		const ts = new Date(entry.timestamp).getTime();
		if (ts < cutoff) continue;

		const key = `${entry.provider}\0${entry.modelId}`;
		let group = groups.get(key);
		if (!group) {
			group = {
				provider: entry.provider,
				modelId: entry.modelId,
				tpsValues: [],
				timestamps: [],
			};
			groups.set(key, group);
		}
		group.tpsValues.push(entry.tps);
		group.timestamps.push(ts);
	}

	return groups;
}

function getDefaultOutputPath(format: ExportOptions["format"]): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const ext = format === "csv" ? "csv" : "png";
	return `./dreb-performance-${timestamp}.${ext}`;
}

function exportCsv(groups: Map<string, GroupedData>, outputPath: string): void {
	const rows: Array<{ provider: string; modelId: string; median_tps: number; mean_tps: number; count: number }> = [];
	for (const group of groups.values()) {
		rows.push({
			provider: group.provider,
			modelId: group.modelId,
			median_tps: computeMedian(group.tpsValues),
			mean_tps: computeMean(group.tpsValues),
			count: group.tpsValues.length,
		});
	}

	rows.sort((a, b) => b.median_tps - a.median_tps);

	const lines = ["provider,modelId,median_tps,mean_tps,count"];
	for (const row of rows) {
		const safeModelId = `"${row.modelId.replace(/"/g, '""')}"`;
		lines.push(`${row.provider},${safeModelId},${row.median_tps.toFixed(2)},${row.mean_tps.toFixed(2)},${row.count}`);
	}

	writeFileSync(outputPath, lines.join("\n"), "utf8");
	console.log(chalk.green(`Exported CSV to ${outputPath}`));
}

function findPython(): string {
	const candidates = ["python3", "python"];
	for (const candidate of candidates) {
		const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
		if (result.status === 0) return candidate;
	}
	throw new Error("Python not found. Install Python 3 to use PNG export.");
}

function getVenvPythonPath(venvDir: string): string {
	if (process.platform === "win32") {
		return join(venvDir, "Scripts", "python.exe");
	}
	return join(venvDir, "bin", "python");
}

function getVenvPipPath(venvDir: string): string {
	if (process.platform === "win32") {
		return join(venvDir, "Scripts", "pip.exe");
	}
	return join(venvDir, "bin", "pip");
}

function exportPng(groups: Map<string, GroupedData>, outputPath: string): void {
	const pythonExe = findPython();
	const venvDir = mkdtempSync(join(tmpdir(), `dreb-matplotlib-${process.pid}-`));
	const venvPython = getVenvPythonPath(venvDir);
	const venvPip = getVenvPipPath(venvDir);

	try {
		const venvResult = spawnSync(pythonExe, ["-m", "venv", venvDir], { encoding: "utf8" });
		if (venvResult.status !== 0) {
			throw new Error(`Failed to create Python venv: ${venvResult.stderr || venvResult.stdout}`);
		}

		const pipResult = spawnSync(venvPip, ["install", "matplotlib"], { encoding: "utf8" });
		if (pipResult.status !== 0) {
			throw new Error(`Failed to install matplotlib: ${pipResult.stderr || pipResult.stdout}`);
		}

		const modelData: Array<{
			provider: string;
			modelId: string;
			median_tps: number;
			mean_tps: number;
			count: number;
			timestamps: number[];
			tpsValues: number[];
		}> = [];

		for (const group of groups.values()) {
			modelData.push({
				provider: group.provider,
				modelId: group.modelId,
				median_tps: computeMedian(group.tpsValues),
				mean_tps: computeMean(group.tpsValues),
				count: group.tpsValues.length,
				timestamps: group.timestamps,
				tpsValues: group.tpsValues,
			});
		}

		modelData.sort((a, b) => b.median_tps - a.median_tps);
		const top5 = [...modelData].sort((a, b) => b.count - a.count).slice(0, 5);

		const dataPath = join(venvDir, "data.json");
		writeFileSync(dataPath, JSON.stringify({ modelData, top5, outputPath }), "utf8");

		const pythonScript = `
import json
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from datetime import datetime
import sys

with open(sys.argv[1], 'r') as f:
    payload = json.load(f)

modelData = payload['modelData']
top5 = payload['top5']
outputPath = payload['outputPath']

fig, axes = plt.subplots(2, 1, figsize=(12, 10))

# Subplot 1: Horizontal bar chart of median TPS
labels = [f"{d['provider']}/{d['modelId']}" for d in modelData]
medians = [d['median_tps'] for d in modelData]
axes[0].barh(range(len(labels)), medians, color='steelblue')
axes[0].set_yticks(range(len(labels)))
axes[0].set_yticklabels(labels)
axes[0].invert_yaxis()
axes[0].set_xlabel('Median TPS')
axes[0].set_title('Median TPS by Model')

# Subplot 2: Time series for top 5 models
for d in top5:
    ts = [datetime.fromtimestamp(t / 1000.0) for t in d['timestamps']]
    axes[1].scatter(ts, d['tpsValues'], label=f"{d['provider']}/{d['modelId']}", alpha=0.6, s=20)
axes[1].set_xlabel('Time')
axes[1].set_ylabel('TPS')
axes[1].set_title('TPS Over Time (Top 5 Models by Count)')
axes[1].legend(loc='upper right', fontsize='small')
axes[1].xaxis.set_major_formatter(mdates.DateFormatter('%m-%d %H:%M'))
fig.autofmt_xdate()

plt.tight_layout()
plt.savefig(outputPath, dpi=150)
`;

		const scriptPath = join(venvDir, "plot.py");
		writeFileSync(scriptPath, pythonScript, "utf8");

		const runResult = spawnSync(venvPython, [scriptPath, dataPath], { encoding: "utf8" });
		if (runResult.status !== 0) {
			throw new Error(`Python script failed: ${runResult.stderr || runResult.stdout}`);
		}

		console.log(chalk.green(`Exported PNG to ${outputPath}`));
	} finally {
		try {
			rmSync(venvDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}

export async function exportPerformance(options: ExportOptions): Promise<void> {
	const logPath = getPerformanceLogPath();

	if (!existsSync(logPath)) {
		console.log(chalk.yellow("No performance data found. Run some sessions first to generate performance.jsonl."));
		return;
	}

	const entries = readPerformanceEntries(logPath);
	if (entries.length === 0) {
		console.log(chalk.yellow("Performance log is empty. Run some sessions first."));
		return;
	}

	const windowMs = getWindowMs(options.window);
	const groups = groupEntries(entries, windowMs);

	if (groups.size === 0) {
		console.log(chalk.yellow(`No performance data within the last ${options.window}.`));
		return;
	}

	const outputPath = options.outputPath ?? getDefaultOutputPath(options.format);

	if (options.format === "csv") {
		exportCsv(groups, outputPath);
	} else {
		try {
			exportPng(groups, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(chalk.red(`PNG export failed: ${message}`));
			console.log(chalk.yellow("Tip: Use --format csv for a text-based export that does not require Python/matplotlib."));
		}
	}
}
