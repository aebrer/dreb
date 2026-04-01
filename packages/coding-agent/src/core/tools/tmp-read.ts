/**
 * tmp-read — A path-restricted read tool that only allows access to /tmp.
 *
 * Used by the Sandbox agent to enforce filesystem isolation. Unlike the
 * regular read tool where /tmp is merely a system-prompt suggestion,
 * this tool rejects any path that resolves outside /tmp at the tool level.
 */

import { realpathSync } from "node:fs";
import { resolve as normalizePath } from "node:path";
import type { ToolDefinition } from "../extensions/types.js";
import { resolveToCwd } from "./path-utils.js";
import { createReadToolDefinition, type ReadToolOptions } from "./read.js";

const ALLOWED_PREFIX = "/tmp";
const SANDBOX_CWD = "/tmp";

/**
 * Check whether a resolved absolute path is under /tmp.
 * Handles exact "/tmp" match and "/tmp/..." paths, rejects "/tmpevil" etc.
 */
function isUnderTmp(absolutePath: string): boolean {
	return absolutePath === ALLOWED_PREFIX || absolutePath.startsWith(`${ALLOWED_PREFIX}/`);
}

export function createTmpReadToolDefinition(options?: ReadToolOptions): ToolDefinition<any, any> {
	// Create a real read tool definition anchored to /tmp
	const inner = createReadToolDefinition(SANDBOX_CWD, options);

	return {
		...inner,
		name: "tmp_read",
		label: "tmp_read",
		description: `Read files under /tmp only. ${inner.description}`,
		promptSnippet: "Read files under /tmp only",
		promptGuidelines: [
			"tmp_read can ONLY read files under /tmp/ — all other paths are rejected.",
			"Use relative paths (resolved against /tmp) or absolute /tmp/... paths.",
		],

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// Validate the path resolves under /tmp BEFORE delegating to the real read tool.
			// normalizePath collapses ".." components (e.g. /tmp/../etc/passwd → /etc/passwd).
			// realpathSync dereferences symlinks so /tmp/evil -> /etc/passwd is caught.
			// Falls back to lexical check if the file doesn't exist yet (ENOENT).
			const lexical = normalizePath(resolveToCwd(params.path, SANDBOX_CWD));
			let resolved: string;
			try {
				resolved = realpathSync(lexical);
			} catch {
				// File doesn't exist — use lexical path (read will fail with ENOENT naturally)
				resolved = lexical;
			}
			if (!isUnderTmp(resolved)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: Access denied. tmp_read can only read files under /tmp. Resolved path: ${resolved}`,
						},
					],
					details: undefined,
				};
			}

			return inner.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	};
}
