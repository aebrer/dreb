import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../src/core/session-manager.js";
import { SessionManager } from "../src/core/session-manager.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import { deleteSessionForRpc, listAllSessionsForRpc, toRpcSessionInfo } from "../src/modes/rpc/rpc-mode.js";
import type { RpcSessionInfo } from "../src/modes/rpc/rpc-types.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dreb-rpc-session-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

describe("deleteSessionForRpc (server-side handler wiring)", () => {
	function stubSessionManager(activeFile?: string) {
		return {
			getSessionFile: () => activeFile,
		} satisfies Pick<SessionManager, "getSessionFile">;
	}

	it("refuses to delete the active session without touching the filesystem", async () => {
		const dir = await createTempDir();
		const activePath = join(dir, "active.jsonl");
		writeFileSync(activePath, "{}\n", "utf8");

		const result = await deleteSessionForRpc(stubSessionManager(activePath), activePath);

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("Cannot delete the currently active session");
		// The active-session guard fires before any deletion — the file must survive.
		expect(existsSync(activePath)).toBe(true);
	});

	it("deletes a valid session and reports the method", async () => {
		const dir = await createTempDir();
		const sessionPath = join(dir, "session.jsonl");
		writeFileSync(sessionPath, "{}\n", "utf8");

		// No active session; same unrestricted path addressing as switch_session (no containment).
		const result = await deleteSessionForRpc(stubSessionManager(), sessionPath);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(["trash", "unlink"]).toContain(result.method);
		expect(existsSync(sessionPath)).toBe(false);
	});

	it("surfaces the core error for a nonexistent session path", async () => {
		const dir = await createTempDir();
		const result = await deleteSessionForRpc(stubSessionManager(), join(dir, "missing.jsonl"));

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("does not exist");
	});

	it("surfaces the core error for a non-.jsonl path without deleting it", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "not-a-session.txt");
		writeFileSync(filePath, "keep me\n", "utf8");

		const result = await deleteSessionForRpc(stubSessionManager(), filePath);

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("Not a session file");
		expect(existsSync(filePath)).toBe(true);
	});
});

describe("listAllSessionsForRpc (server-side handler wiring)", () => {
	it("maps every SessionManager.listAll() result through toRpcSessionInfo (Date -> ISO)", async () => {
		const info: SessionInfo = {
			path: "/home/user/.dreb/agent/sessions/project/session.jsonl",
			id: "abc123",
			cwd: "/home/user/project",
			name: "feature-work",
			created: new Date("2024-01-15T10:30:00.000Z"),
			modified: new Date("2024-01-15T11:45:00.000Z"),
			messageCount: 3,
			firstMessage: "hi",
			allMessagesText: "hi",
		};
		vi.spyOn(SessionManager, "listAll").mockResolvedValue([info]);

		const dtos = await listAllSessionsForRpc();

		expect(dtos).toEqual([toRpcSessionInfo(info)]);
		expect(typeof dtos[0]?.created).toBe("string");
	});
});
