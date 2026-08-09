import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";

describe("RpcClient.forkCurrent", () => {
	it("sends fork_current with no arguments and unwraps the cancelled flag", async () => {
		const client = new RpcClient() as any;
		const data = { cancelled: false };
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "fork_current",
			success: true,
			data,
		});

		await expect(client.forkCurrent()).resolves.toEqual(data);
		expect(client.send).toHaveBeenCalledWith({ type: "fork_current" });
		expect(client.send.mock.calls[0]).toHaveLength(1);
	});

	it("propagates a cancelled fork (e.g. empty session or extension cancel)", async () => {
		const client = new RpcClient() as any;
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "fork_current",
			success: true,
			data: { cancelled: true },
		});

		await expect(client.forkCurrent()).resolves.toEqual({ cancelled: true });
	});
});
