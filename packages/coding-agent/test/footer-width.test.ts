import { visibleWidth } from "@dreb/tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.js";
import { FooterComponent } from "../src/modes/interactive/components/footer.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
}): AgentSession {
	const usage = options.usage;
	const entries =
		usage === undefined
			? []
			: [
					{
						type: "message",
						message: {
							role: "assistant",
							usage,
						},
					},
				];

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => options.sessionName,
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		modelRegistry: {
			isUsingOAuth: () => false,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number, dailyCost = 0): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		getDailyCost: () => dailyCost,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width when daily cost is shown", () => {
		const width = 80;
		const session = createSession({
			sessionName: "",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 45_000,
				cacheWrite: 8_000,
				cost: { total: 0.042 },
			},
		});
		// Daily cost > session cost triggers "· today $X.XX" display
		const footer = new FooterComponent(session, createFooterData(1, 15.37));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		// The stats line should contain the daily cost
		const rawStats = lines[1];
		expect(rawStats).toContain("today");
	});

	it("hides daily cost when it equals session cost", () => {
		const width = 80;
		const session = createSession({
			sessionName: "",
			usage: {
				input: 1000,
				output: 500,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.5 },
			},
		});
		// Daily cost == session cost — should not show "today"
		const footer = new FooterComponent(session, createFooterData(1, 0.5));

		const lines = footer.render(width);
		const rawStats = lines[1];
		expect(rawStats).not.toContain("today");
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});
