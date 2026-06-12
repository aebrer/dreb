import { describe, expect, it } from "vitest";
import { applyCopilotBaseUrl } from "./oauth.js";

// Unit coverage for the E2E test helper that rewrites a github-copilot model's
// baseUrl from the resolved OAuth token's proxy-ep. The E2E call sites only ever
// exercise the rewrite branch, and only when a live token is present (they skip
// otherwise), so the no-op branches have no coverage in CI without these tests.
describe("applyCopilotBaseUrl", () => {
	const INDIVIDUAL_URL = "https://api.individual.githubcopilot.com";

	it("returns the model unchanged for non-copilot providers", () => {
		const model = { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" };
		expect(applyCopilotBaseUrl(model, "tid=t;proxy-ep=proxy.business.githubcopilot.com;")).toBe(model);
	});

	it("returns the model unchanged when the token is missing", () => {
		const model = { provider: "github-copilot", baseUrl: INDIVIDUAL_URL };
		expect(applyCopilotBaseUrl(model, undefined)).toBe(model);
	});

	it("rewrites the baseUrl from the token's proxy-ep for business tokens", () => {
		const model = { provider: "github-copilot", baseUrl: INDIVIDUAL_URL };
		const token = "tid=abc;exp=9999999999;proxy-ep=proxy.business.githubcopilot.com;";

		const result = applyCopilotBaseUrl(model, token);

		expect(result.baseUrl).toBe("https://api.business.githubcopilot.com");
		expect(result.provider).toBe("github-copilot");
		// Original is not mutated — the helper returns a copy.
		expect(model.baseUrl).toBe(INDIVIDUAL_URL);
	});

	it("falls back to the individual endpoint when the token lacks a proxy-ep", () => {
		const model = { provider: "github-copilot", baseUrl: "https://stale.example.com" };

		const result = applyCopilotBaseUrl(model, "tid=abc;exp=9999999999;");

		expect(result.baseUrl).toBe(INDIVIDUAL_URL);
	});
});
