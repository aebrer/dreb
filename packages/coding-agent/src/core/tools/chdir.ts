import { existsSync, statSync } from "node:fs";
import type { AgentTool } from "@dreb/agent-core";
import { Text } from "@dreb/tui";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../extensions/types.js";
import { findGitRoot } from "../git-root.js";
import { resolveToCwd } from "./path-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const chdirSchema = Type.Object({
	path: Type.String({ description: "Directory path to change to (absolute or relative to current cwd)" }),
});

export type ChdirToolInput = Static<typeof chdirSchema>;

export interface ChdirToolOptions {
	/** Callback invoked when cwd changes. The session uses this to rebuild tools. */
	onChdir?: (newCwd: string) => void;
}

export function createChdirToolDefinition(
	cwd: string,
	options?: ChdirToolOptions,
): ToolDefinition<typeof chdirSchema, undefined> {
	return {
		name: "chdir",
		label: "chdir",
		description:
			"Change the working directory. Validates that the target exists and is inside a git repository. All subsequent tool operations will use the new directory.",
		parameters: chdirSchema,
		async execute(_toolCallId, { path }: { path: string }, _signal?, _onUpdate?, _ctx?) {
			const resolvedPath = resolveToCwd(path, cwd);

			// Validate: directory exists
			if (!existsSync(resolvedPath)) {
				return {
					content: [{ type: "text" as const, text: `Error: Directory does not exist: ${resolvedPath}` }],
					details: undefined,
				};
			}

			// Validate: is a directory
			const stat = statSync(resolvedPath);
			if (!stat.isDirectory()) {
				return {
					content: [{ type: "text" as const, text: `Error: Path is not a directory: ${resolvedPath}` }],
					details: undefined,
				};
			}

			// Validate: is inside a git repository
			const gitRoot = findGitRoot(resolvedPath);
			if (!gitRoot) {
				return {
					content: [
						{ type: "text" as const, text: `Error: Target is not inside a git repository: ${resolvedPath}` },
					],
					details: undefined,
				};
			}

			// Invoke callback to trigger session cwd change
			const oldCwd = cwd;
			options?.onChdir?.(resolvedPath);

			return {
				content: [
					{
						type: "text" as const,
						text: `Changed working directory:\n  from: ${oldCwd}\n  to:   ${resolvedPath}`,
					},
				],
				details: undefined,
			};
		},
		renderCall(args, theme, context) {
			const targetPath = (args as { path?: string })?.path || "";
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(`${theme.fg("toolTitle", theme.bold("chdir"))} ${theme.fg("accent", targetPath)}`);
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const first = result.content?.[0];
			if (first?.type === "text" && first.text.startsWith("Error:")) {
				text.setText(theme.fg("error", first.text));
				return text;
			}
			const output = first?.type === "text" ? first.text : "";
			text.setText(theme.fg("muted", output));
			return text;
		},
	};
}

export function createChdirTool(cwd: string, options?: ChdirToolOptions): AgentTool<typeof chdirSchema> {
	return wrapToolDefinition(createChdirToolDefinition(cwd, options));
}

/** Default chdir tool using process.cwd() for backwards compatibility. */
export const chdirToolDefinition = createChdirToolDefinition(process.cwd());
export const chdirTool = createChdirTool(process.cwd());
