import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import { getPerformanceStatsData } from "../src/modes/rpc/rpc-mode.js";

describe("RPC performance stats", () => {
	const models = [
		{
			provider: "anthropic",
			modelId: "claude-3-sonnet",
			rolling: { median: 32, mean: 33, count: 100 },
			delta: {
				baselineMedian: 30,
				recentMedian: 36,
				percentDelta: 20,
				direction: "above" as const,
				baselineCount: 200,
				recentCount: 10,
			},
		},
	];

	it("builds shared model summaries from the session tracker", () => {
		const tracker = { getAllModelSummaries: vi.fn(() => models) };
		const session = { getPerformanceTracker: () => tracker };

		expect(getPerformanceStatsData(session as any)).toEqual({ models });
		expect(tracker.getAllModelSummaries).toHaveBeenCalledOnce();
	});

	it("RpcClient.getPerformanceStats sends the get_performance_stats command", async () => {
		const client = new RpcClient() as any;
		const data = { models };
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
