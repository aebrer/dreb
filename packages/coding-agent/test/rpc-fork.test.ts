import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";

describe("RpcClient fork surface", () => {
	it("fork() sends the entry id and unwraps { text, cancelled }", async () => {
		const client = new RpcClient() as any;
		const data = { text: "re-ask me", cancelled: false };
		client.send = vi.fn().mockResolvedValue({ type: "response", command: "fork", success: true, data });

		await expect(client.fork("e1")).resolves.toEqual(data);
		expect(client.send).toHaveBeenCalledWith({ type: "fork", entryId: "e1" });
	});

	it("fork() propagates an assistant fork (empty re-ask text)", async () => {
		const client = new RpcClient() as any;
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "fork",
			success: true,
			data: { text: "", cancelled: false },
		});

		await expect(client.fork("a3")).resolves.toEqual({ text: "", cancelled: false });
	});

	it("getForkMessages() unwraps messages that carry a role", async () => {
		const client = new RpcClient() as any;
		const messages = [
			{ entryId: "u1", text: "hi", role: "user" as const },
			{ entryId: "a1", text: "hello", role: "assistant" as const },
		];
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "get_fork_messages",
			success: true,
			data: { messages },
		});

		await expect(client.getForkMessages()).resolves.toEqual(messages);
		expect(client.send).toHaveBeenCalledWith({ type: "get_fork_messages" });
	});
});
