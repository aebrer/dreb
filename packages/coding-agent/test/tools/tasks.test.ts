import { describe, it, assert } from "vitest";
import { createTasksToolDefinition, type SessionTask, type TasksToolDetails } from "../../src/core/tools/tasks.js";

describe("tasks_update tool", () => {
	function createTool() {
		const updates: SessionTask[][] = [];
		const onUpdate = (tasks: SessionTask[]): TasksToolDetails => {
			updates.push(tasks);
			const completed = tasks.filter((t) => t.status === "completed").length;
			const inProgress = tasks.find((t) => t.status === "in_progress");
			return {
				taskCount: tasks.length,
				completed,
				inProgress: inProgress?.title,
			};
		};
		const tool = createTasksToolDefinition(onUpdate);
		// Cast execute to skip the ctx parameter (not used by this tool)
		const execute = tool.execute.bind(tool) as (
			toolCallId: string,
			params: { tasks: SessionTask[] },
			signal?: AbortSignal,
			onUpdate?: any,
		) => Promise<{ content: Array<{ type: string; text?: string }>; details?: TasksToolDetails }>;
		return { tool, execute, updates };
	}

	it("should accept a valid task list", async () => {
		const { execute, updates } = createTool();
		const result = await execute("call-1", {
			tasks: [
				{ id: "1", title: "Read files", status: "completed" },
				{ id: "2", title: "Fix handler", status: "in_progress" },
				{ id: "3", title: "Write tests", status: "pending" },
			],
		});

		assert.equal(updates.length, 1);
		assert.equal(updates[0].length, 3);
		assert.equal(result.details?.taskCount, 3);
		assert.equal(result.details?.completed, 1);
		assert.equal(result.details?.inProgress, "Fix handler");
		assert.ok(result.content[0].type === "text" && result.content[0].text?.includes("3 total"));
	});

	it("should reject multiple in_progress tasks", async () => {
		const { execute, updates } = createTool();
		const result = await execute("call-2", {
			tasks: [
				{ id: "1", title: "Task A", status: "in_progress" },
				{ id: "2", title: "Task B", status: "in_progress" },
			],
		});

		assert.equal(updates.length, 0);
		assert.equal(result.details, undefined);
		assert.ok(result.content[0].type === "text" && result.content[0].text?.includes("Error"));
		assert.ok(result.content[0].type === "text" && result.content[0].text?.includes("At most one"));
	});

	it("should allow zero in_progress tasks", async () => {
		const { execute, updates } = createTool();
		const result = await execute("call-3", {
			tasks: [
				{ id: "1", title: "Task A", status: "completed" },
				{ id: "2", title: "Task B", status: "pending" },
			],
		});

		assert.equal(updates.length, 1);
		assert.equal(result.details?.taskCount, 2);
		assert.equal(result.details?.completed, 1);
		assert.equal(result.details?.inProgress, undefined);
	});

	it("should allow empty task list", async () => {
		const { execute, updates } = createTool();
		const result = await execute("call-4", { tasks: [] });

		assert.equal(updates.length, 1);
		assert.equal(result.details?.taskCount, 0);
		assert.equal(result.details?.completed, 0);
	});

	it("should be full replacement (second call replaces first)", async () => {
		const { execute, updates } = createTool();

		await execute("call-5", {
			tasks: [{ id: "1", title: "First task", status: "pending" }],
		});

		await execute("call-6", {
			tasks: [
				{ id: "1", title: "First task", status: "completed" },
				{ id: "2", title: "Second task", status: "in_progress" },
			],
		});

		assert.equal(updates.length, 2);
		assert.equal(updates[1].length, 2);
		assert.equal(updates[1][0].status, "completed");
		assert.equal(updates[1][1].status, "in_progress");
	});

	it("should accept exactly 20 tasks", async () => {
		const { execute, updates } = createTool();
		const maxList = Array.from({ length: 20 }, (_, i) => ({
			id: String(i + 1),
			title: `Task ${i + 1}`,
			status: "pending" as const,
		}));
		const result = await execute("call-boundary", { tasks: maxList });

		assert.equal(updates.length, 1);
		assert.equal(result.details?.taskCount, 20);
	});

	it("should reject task lists exceeding 20 items", async () => {
		const { execute, updates } = createTool();
		const bigList = Array.from({ length: 25 }, (_, i) => ({
			id: String(i + 1),
			title: `Task ${i + 1}`,
			status: "pending" as const,
		}));
		const result = await execute("call-big", { tasks: bigList });

		assert.equal(updates.length, 0);
		assert.equal(result.details, undefined);
		assert.ok(result.content[0].type === "text" && result.content[0].text?.includes("Error"));
		assert.ok(result.content[0].type === "text" && result.content[0].text?.includes("too long"));
	});

	it("should have correct tool metadata", () => {
		const { tool } = createTool();
		assert.equal(tool.name, "tasks_update");
		assert.equal(tool.label, "tasks_update");
		assert.ok(tool.promptSnippet);
		assert.ok(tool.promptGuidelines);
		assert.ok(tool.promptGuidelines!.length >= 3);
	});
});
