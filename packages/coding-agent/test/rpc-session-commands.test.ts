import { describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../src/core/session-manager.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import { toRpcSessionInfo } from "../src/modes/rpc/rpc-mode.js";
import type { RpcSessionInfo } from "../src/modes/rpc/rpc-types.js";

describe("toRpcSessionInfo", () => {
	it("maps a SessionInfo to the RPC DTO, converting Date fields to ISO strings", () => {
		const info: SessionInfo = {
			path: "/home/user/.dreb/agent/sessions/project/session.jsonl",
			id: "abc123",
			cwd: "/home/user/project",
			name: "feature-work",
			created: new Date("2024-01-15T10:30:00.000Z"),
			modified: new Date("2024-01-15T11:45:00.000Z"),
			messageCount: 12,
			firstMessage: "Help me refactor the auth module",
			allMessagesText: "Help me refactor the auth module",
		};

		const dto = toRpcSessionInfo(info);

		expect(dto).toEqual({
			path: "/home/user/.dreb/agent/sessions/project/session.jsonl",
			id: "abc123",
			cwd: "/home/user/project",
			name: "feature-work",
			created: "2024-01-15T10:30:00.000Z",
			modified: "2024-01-15T11:45:00.000Z",
			messageCount: 12,
			firstMessage: "Help me refactor the auth module",
		});
		// Dates must be serialized to strings, not left as Date objects.
		expect(typeof dto.created).toBe("string");
		expect(typeof dto.modified).toBe("string");
	});
});

describe("RPC session commands", () => {
	it("RpcClient.listAllSessions sends the list_all_sessions command and unwraps sessions", async () => {
		const client = new RpcClient() as any;
		const sessions: RpcSessionInfo[] = [
			{
				path: "/home/user/.dreb/agent/sessions/project/session.jsonl",
				id: "abc123",
				cwd: "/home/user/project",
				name: "feature-work",
				created: "2024-01-15T10:30:00.000Z",
				modified: "2024-01-15T11:45:00.000Z",
				messageCount: 12,
				firstMessage: "Help me refactor the auth module",
			},
		];
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "list_all_sessions",
			success: true,
			data: { sessions },
		});

		await expect(client.listAllSessions()).resolves.toEqual(sessions);
		expect(client.send).toHaveBeenCalledWith({ type: "list_all_sessions" });
	});

	it("RpcClient.deleteSession sends the delete_session command and returns deletion data", async () => {
		const client = new RpcClient() as any;
		const sessionPath = "/home/user/.dreb/agent/sessions/project/session.jsonl";
		const data = { method: "trash" as const };
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "delete_session",
			success: true,
			data,
		});

		await expect(client.deleteSession(sessionPath)).resolves.toEqual(data);
		expect(client.send).toHaveBeenCalledWith({ type: "delete_session", sessionPath });
	});

	it("RpcClient.deleteSession rejects with the RPC error message on failure", async () => {
		const client = new RpcClient() as any;
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "delete_session",
			success: false,
			error: "Cannot delete the currently active session",
		});

		await expect(client.deleteSession("/tmp/current.jsonl")).rejects.toThrow(
			"Cannot delete the currently active session",
		);
	});

	it("RpcClient.listAllSessions rejects with the RPC error message on failure", async () => {
		const client = new RpcClient() as any;
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "list_all_sessions",
			success: false,
			error: "Unable to list sessions",
		});

		await expect(client.listAllSessions()).rejects.toThrow("Unable to list sessions");
	});
});
