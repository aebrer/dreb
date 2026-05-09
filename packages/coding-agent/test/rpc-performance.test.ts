import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import { getPerformanceStatsData } from "../src/modes/rpc/rpc-mode.js";

describe("RPC performance stats", () => {
	it("builds performance stats response data from the session tracker", () => {
		const models = [{ provider: "anthropic", modelId: "claude-3-sonnet", median: 30, mean: 31, count: 4 }];
		const session = {
			getPerformanceTracker: () => ({
				getAllRollingAverages: vi.fn(() => models),
			}),
		};

		expect(getPerformanceStatsData(session as any)).toEqual({ models });
	});

	it("RpcClient.getPerformanceStats sends the get_performance_stats command", async () => {
		const client = new RpcClient() as any;
		const data = {
			models: [{ provider: "anthropic", modelId: "claude-3-sonnet", median: 30, mean: 31, count: 4 }],
		};
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "get_performance_stats",
			success: true,
			data,
		});

		await expect(client.getPerformanceStats()).resolves.toEqual(data);
		expect(client.send).toHaveBeenCalledWith({ type: "get_performance_stats" });
	});
});
