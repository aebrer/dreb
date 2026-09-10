import type { AssistantMessage, Model } from "@dreb/ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateBranchSummary } from "../src/core/compaction/branch-summarization.js";
import type { SessionEntry } from "../src/core/session-manager.js";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@dreb/ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dreb/ai")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(): Model<"anthropic-messages"> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "Branch summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "test-model",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const entries: SessionEntry[] = [
	{
		type: "message",
		id: "1",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: "Fix the auth bug", timestamp: Date.now() },
	},
];

describe("generateBranchSummary session ID forwarding", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("forwards the stable session ID to the branch summary completion", async () => {
		const result = await generateBranchSummary(entries, {
			model: createModel(),
			apiKey: "test-key",
			signal: new AbortController().signal,
			sessionId: "branch-summary-uuid",
		});

		expect(result.summary).toContain("Branch summary");
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
			sessionId: "branch-summary-uuid",
		});
	});

	it("omits sessionId when none is provided", async () => {
		await generateBranchSummary(entries, {
			model: createModel(),
			apiKey: "test-key",
			signal: new AbortController().signal,
		});

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("sessionId");
	});
});
