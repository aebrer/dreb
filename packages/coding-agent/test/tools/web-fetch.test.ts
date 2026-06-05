import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebFetchToolDefinition, getGitHubFetchGuidance } from "../../src/core/tools/web.js";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => c.text ?? "").join("\n");
}

describe("getGitHubFetchGuidance", () => {
	it("returns guidance for github.com blob URLs (clone/api hint)", () => {
		const g = getGitHubFetchGuidance(new URL("https://github.com/owner/repo/blob/main/src/file.ts"));
		expect(g).toBeTruthy();
		expect(g).toContain("clone");
		expect(g).toContain("gh api");
	});

	it("returns guidance for github.com /raw/ URLs (clone/api hint)", () => {
		const g = getGitHubFetchGuidance(new URL("https://github.com/owner/repo/raw/main/src/file.ts"));
		expect(g).toBeTruthy();
		expect(g).toContain("clone");
		expect(g).toContain("gh api");
	});

	it("returns guidance for raw.githubusercontent.com (clone/api hint)", () => {
		const g = getGitHubFetchGuidance(new URL("https://raw.githubusercontent.com/owner/repo/main/file.ts"));
		expect(g).toBeTruthy();
		expect(g).toContain("clone");
	});

	it("returns guidance for *.githubusercontent.com subdomains", () => {
		const g = getGitHubFetchGuidance(new URL("https://objects.githubusercontent.com/some/asset"));
		expect(g).toBeTruthy();
		expect(g).toContain("clone");
	});

	it("returns guidance for gist.github.com", () => {
		const g = getGitHubFetchGuidance(new URL("https://gist.github.com/owner/abc123"));
		expect(g).toBeTruthy();
	});

	it("returns gh api guidance for api.github.com", () => {
		const g = getGitHubFetchGuidance(new URL("https://api.github.com/repos/owner/repo/contents/src"));
		expect(g).toBeTruthy();
		expect(g).toContain("gh api");
		expect(g).toContain("repos/owner/repo/contents/src");
	});

	it("returns PR guidance for pull request URLs", () => {
		const g = getGitHubFetchGuidance(new URL("https://github.com/owner/repo/pull/42"));
		expect(g).toBeTruthy();
		expect(g).toContain("gh pr view");
	});

	it("returns issue guidance for issue URLs", () => {
		const g = getGitHubFetchGuidance(new URL("https://github.com/owner/repo/issues/42"));
		expect(g).toBeTruthy();
		expect(g).toContain("gh issue view");
	});

	it("returns generic guidance for a repo root URL", () => {
		const g = getGitHubFetchGuidance(new URL("https://github.com/owner/repo"));
		expect(g).toBeTruthy();
		expect(g).toContain("gh");
		expect(g).toContain("/tmp");
	});

	it("handles www. and uppercase hosts", () => {
		expect(getGitHubFetchGuidance(new URL("https://WWW.GitHub.com/owner/repo"))).toBeTruthy();
	});

	it("returns null for non-GitHub hosts", () => {
		expect(getGitHubFetchGuidance(new URL("https://example.com/page"))).toBeNull();
		expect(getGitHubFetchGuidance(new URL("https://www.npmjs.com/package/foo"))).toBeNull();
		// not GitHub — a lookalike host must not match
		expect(getGitHubFetchGuidance(new URL("https://github.com.evil.example/owner/repo"))).toBeNull();
	});
});

describe("web_fetch execute — GitHub redirect", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("short-circuits GitHub URLs without performing a network fetch", async () => {
		const fetchMock = vi.fn();
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const def = createWebFetchToolDefinition(process.cwd());
		const result = await def.execute(
			"call-1",
			{ url: "https://github.com/owner/repo/blob/main/file.ts" },
			undefined,
			undefined,
			undefined as never,
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(getText(result)).toContain("gh");
	});

	it("attempts a network fetch for non-GitHub URLs", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers({ "content-type": "text/html" }),
			text: async () => "<html><head><title>Example</title></head><body>Hello world</body></html>",
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const def = createWebFetchToolDefinition(process.cwd());
		// unique URL to avoid the module-level fetch cache
		const result = await def.execute(
			"call-2",
			{ url: `https://example.com/page-${Date.now()}` },
			undefined,
			undefined,
			undefined as never,
		);

		expect(fetchMock).toHaveBeenCalled();
		expect(getText(result)).toContain("Hello world");
	});
});
