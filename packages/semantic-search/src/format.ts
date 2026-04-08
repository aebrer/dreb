/** Format search results into a human-readable numbered list. */

import type { SearchResult } from "./types.js";

export function formatResults(results: SearchResult[]): string {
	if (results.length === 0) return "No results found.";

	const lines: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const { chunk, scores } = r;

		// Header line with file path and line range
		const lineRange =
			chunk.startLine === chunk.endLine ? `L${chunk.startLine}` : `L${chunk.startLine}-${chunk.endLine}`;
		const kindLabel = chunk.name ? `${chunk.kind} ${chunk.name}` : chunk.kind;

		lines.push(`${i + 1}. ${chunk.filePath}:${lineRange} (${kindLabel})`);

		// Score summary — show top contributing metrics
		const topScores = Object.entries(scores)
			.filter(([, v]) => v > 0.01)
			.sort(([, a], [, b]) => b - a)
			.map(([k, v]) => `${k}=${v.toFixed(2)}`)
			.join(" ");
		if (topScores) {
			lines.push(`   scores: ${topScores}`);
		}

		// Content preview (first 3 lines)
		const contentLines = chunk.content.split("\n");
		const previewLines = contentLines.slice(0, 3);
		for (const line of previewLines) {
			const trimmed = line.length > 120 ? `${line.slice(0, 117)}...` : line;
			lines.push(`   ${trimmed}`);
		}
		if (contentLines.length > 3) {
			lines.push(`   ... (${contentLines.length - 3} more lines)`);
		}

		if (i < results.length - 1) lines.push("");
	}

	return lines.join("\n");
}
