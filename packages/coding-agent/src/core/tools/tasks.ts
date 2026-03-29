/**
 * Session task tracking tool.
 *
 * Full-replacement model: agent sends the complete task list each call.
 * At most one task can be in_progress at a time.
 * Tasks are session-local (in-memory, lost on session end).
 */

import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "../extensions/types.js";
import { Text } from "@dreb/tui";

// ============================================================================
// Types

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface SessionTask {
	id: string;
	title: string;
	status: TaskStatus;
}

export interface TasksToolDetails {
	taskCount: number;
	completed: number;
	inProgress: string | undefined;
}

export type TasksUpdateCallback = (tasks: SessionTask[]) => TasksToolDetails;

// ============================================================================
// Schema

const taskSchema = Type.Object({
	id: Type.String({ description: "Stable identifier (e.g. \"1\", \"setup\", \"fix-auth\")" }),
	title: Type.String({ description: "Brief action-oriented title" }),
	status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], {
		description: "Task status: pending, in_progress, or completed",
	}),
});

const tasksUpdateSchema = Type.Object({
	tasks: Type.Array(taskSchema, {
		description:
			"Complete current task list. This is a full replacement — send ALL tasks each time, not just changes.",
	}),
});

export type TasksToolInput = Static<typeof tasksUpdateSchema>;

// ============================================================================
// Render helpers

function formatTasksCall(
	args: { tasks?: Array<{ id?: string; title?: string; status?: string }> } | undefined,
	theme: any,
): string {
	const count = args?.tasks?.length ?? 0;
	return `${theme.fg("toolTitle", theme.bold("tasks_update"))} ${theme.fg("accent", `${count} task${count !== 1 ? "s" : ""}`)}`;
}

function formatTasksResult(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: TasksToolDetails;
	},
	theme: any,
): string {
	const details = result.details;
	if (!details || details.taskCount === undefined) {
		// Fallback to raw text content (e.g. error messages, partial results)
		const text = result.content?.[0];
		return text?.type === "text" && text.text ? theme.fg("toolOutput", text.text) : "";
	}

	const parts: string[] = [];
	parts.push(`${details.taskCount} task${details.taskCount !== 1 ? "s" : ""}`);
	parts.push(`${details.completed ?? 0} completed`);
	if (details.inProgress) {
		parts.push(`current: ${details.inProgress}`);
	}
	return theme.fg("toolOutput", parts.join(", "));
}

// ============================================================================
// Tool definition factory

export function createTasksToolDefinition(
	onUpdate: TasksUpdateCallback,
): ToolDefinition<typeof tasksUpdateSchema, TasksToolDetails | undefined> {
	return {
		name: "tasks_update",
		label: "tasks_update",
		description:
			"Create or update the session task list. Send the complete current task list each time — this is a full replacement, not a patch. Use this to track progress on multi-step work.",

		parameters: tasksUpdateSchema,

		promptSnippet: "Create or update session task list for multi-step work",

		promptGuidelines: [
			"For work requiring 3 or more steps, use tasks_update to organize your plan and show progress",
			"Send the complete task list each time (full replacement, not a patch)",
			"At most one task can be in_progress at a time",
			"Keep task lists concise: typically 3-10 items. Never exceed 20 tasks.",
			"Use short, action-oriented titles (e.g. \"Read existing tests\", \"Fix auth handler\")",
		],

		async execute(
			_toolCallId,
			{ tasks }: TasksToolInput,
			_signal?,
			_onUpdate?,
			_ctx?,
		) {
			// Validate: max 20 tasks
			if (tasks.length > 20) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: Task list too long (${tasks.length} tasks). Maximum is 20. Break work into higher-level steps.`,
						},
					],
					details: undefined,
				};
			}

			// Validate: at most one in_progress
			const inProgressTasks = tasks.filter((t) => t.status === "in_progress");
			if (inProgressTasks.length > 1) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: At most one task can be in_progress at a time. Found ${inProgressTasks.length}: ${inProgressTasks.map((t) => t.id).join(", ")}`,
						},
					],
					details: undefined,
				};
			}

			const details = onUpdate(tasks);

			return {
				content: [
					{
						type: "text" as const,
						text: `Tasks updated: ${details.taskCount} total, ${details.completed} completed${details.inProgress ? `, in progress: ${details.inProgress}` : ""}`,
					},
				],
				details,
			};
		},

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatTasksCall(args, theme));
			return text;
		},

		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatTasksResult(result as any, theme));
			return text;
		},
	};
}
