import type { AgentTool } from "@dreb/agent-core";
import { Text } from "@dreb/tui";
import { type Static, Type } from "@sinclair/typebox";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.js";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getTextOutput, invalidArgText, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { truncateHead, DEFAULT_MAX_BYTES, formatSize, type TruncationResult } from "./truncate.js";

// ---------------------------------------------------------------------------
// Shared: HTTP fetching and HTML extraction
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 30_000;
const MAX_CONTENT_BYTES = 100_000;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

const fetchCache = new Map<string, { content: WebFetchResult; timestamp: number }>();

interface WebFetchResult {
	url: string;
	title: string;
	content: string;
	contentLength: number;
	fetchedAt: string;
}

function stripHtmlToText(html: string): string {
	let text = html;
	// Remove script/style/nav/footer blocks entirely
	text = text.replace(/<(script|style|nav|footer|header|aside|iframe|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
	// Convert block elements to newlines
	text = text.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|section|article)>/gi, "\n");
	text = text.replace(/<(br|hr)\s*\/?>/gi, "\n");
	// Convert links to text with URL
	text = text.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)");
	// Convert headings to markdown-style
	text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, content) => {
		return "\n" + "#".repeat(Number(level)) + " " + content.trim() + "\n";
	});
	// Convert list items
	text = text.replace(/<li\b[^>]*>/gi, "\n- ");
	// Strip all remaining tags
	text = text.replace(/<[^>]+>/g, "");
	// Decode common HTML entities
	text = text.replace(/&amp;/g, "&");
	text = text.replace(/&lt;/g, "<");
	text = text.replace(/&gt;/g, ">");
	text = text.replace(/&quot;/g, '"');
	text = text.replace(/&#39;/g, "'");
	text = text.replace(/&nbsp;/g, " ");
	// Collapse whitespace
	text = text.replace(/[ \t]+/g, " ");
	text = text.replace(/\n{3,}/g, "\n\n");
	return text.trim();
}

function extractTitle(html: string): string {
	const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
	return match ? match[1].trim().replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") : "";
}

const FETCH_HEADERS = {
	"User-Agent": "dreb/1.0 (web fetch tool)",
	Accept: "text/html,application/xhtml+xml,text/plain,application/pdf",
};

async function httpFetch(
	url: string,
): Promise<{ body: string | Buffer; contentType: string; statusCode: number }> {
	const originalHost = new URL(url).hostname;

	// First request — manual redirect to enforce same-host only
	const response = await fetch(url, {
		method: "GET",
		headers: FETCH_HEADERS,
		redirect: "manual",
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});

	// Handle redirects: same-host follows, cross-host returns info to agent
	if (response.status >= 300 && response.status < 400) {
		const location = response.headers.get("location");
		if (!location) {
			throw new Error(`HTTP ${response.status}: redirect with no Location header`);
		}
		const redirectUrl = new URL(location, url);
		if (redirectUrl.hostname !== originalHost) {
			return {
				body: `Cross-host redirect detected.\nOriginal: ${url}\nRedirects to: ${redirectUrl.href}\n\nThe redirect target is on a different host. Fetch the new URL directly if you want to follow it.`,
				contentType: "text/plain",
				statusCode: 302,
			};
		}
		// Same-host — follow with auto-redirect for remaining hops
		const followResponse = await fetch(redirectUrl.href, {
			method: "GET",
			headers: FETCH_HEADERS,
			redirect: "follow",
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		const ct = followResponse.headers.get("content-type") || "";
		if (ct.includes("application/pdf")) {
			return { body: Buffer.from(await followResponse.arrayBuffer()), contentType: ct, statusCode: followResponse.status };
		}
		return { body: await followResponse.text(), contentType: ct, statusCode: followResponse.status };
	}

	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`HTTP ${response.status}: ${errorBody.slice(0, 200)}`);
	}

	const contentType = response.headers.get("content-type") || "";
	if (contentType.includes("application/pdf")) {
		return { body: Buffer.from(await response.arrayBuffer()), contentType, statusCode: response.status };
	}
	return { body: await response.text(), contentType, statusCode: response.status };
}

// -- PDF text extraction (basic) ---------------------------------------------

function extractPdfText(buffer: Buffer): string {
	// Basic PDF text extraction — handles simple text-based PDFs
	// Extracts text from BT...ET blocks (PDF text objects)
	const raw = buffer.toString("latin1");
	const textChunks: string[] = [];

	const btEtRegex = /BT\s([\s\S]*?)ET/g;
	let match: RegExpExecArray | null;
	while ((match = btEtRegex.exec(raw)) !== null) {
		const block = match[1];
		const strRegex = /\(([^)]*)\)/g;
		let strMatch: RegExpExecArray | null;
		while ((strMatch = strRegex.exec(block)) !== null) {
			const decoded = strMatch[1]
				.replace(/\\n/g, "\n")
				.replace(/\\r/g, "\r")
				.replace(/\\t/g, "\t")
				.replace(/\\\(/g, "(")
				.replace(/\\\)/g, ")")
				.replace(/\\\\/g, "\\");
			if (decoded.trim()) {
				textChunks.push(decoded);
			}
		}
	}

	if (textChunks.length === 0) {
		return "[PDF text extraction failed — the PDF may use embedded fonts or image-based content that requires OCR]";
	}

	return textChunks.join(" ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// web_search tool
// ---------------------------------------------------------------------------

const webSearchSchema = Type.Object({
	query: Type.String({ description: "The search query" }),
});

export type WebSearchToolInput = Static<typeof webSearchSchema>;

export interface WebSearchToolDetails {
	truncation?: TruncationResult;
}

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

async function searchDuckDuckGo(query: string): Promise<SearchResult[]> {
	const encodedQuery = encodeURIComponent(query);
	const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodedQuery}`, {
		method: "GET",
		headers: {
			"User-Agent": "dreb/1.0 (web search tool)",
			Accept: "text/html",
		},
		redirect: "follow",
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	const html = await response.text();
	const results: SearchResult[] = [];

	// Parse DuckDuckGo HTML results
	const resultBlocks = html.split(/class="result__body"/);
	for (const block of resultBlocks.slice(1, 11)) {
		const titleMatch = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
		const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)/);

		if (titleMatch) {
			let url = titleMatch[1];
			// DDG wraps URLs in a redirect — extract the actual URL
			const uddgMatch = url.match(/uddg=([^&]*)/);
			if (uddgMatch) {
				url = decodeURIComponent(uddgMatch[1]);
			}
			const title = titleMatch[2].replace(/<[^>]+>/g, "").trim();
			const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : "";
			if (title && url) {
				results.push({ title, url, snippet });
			}
		}
	}
	return results;
}

async function searchSearXNG(query: string, baseUrl: string): Promise<SearchResult[]> {
	const encodedQuery = encodeURIComponent(query);
	const response = await fetch(`${baseUrl}/search?q=${encodedQuery}&format=json`, {
		method: "GET",
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	const data = (await response.json()) as { results?: Array<{ title: string; url: string; content?: string }> };
	return (data.results || []).slice(0, 10).map((r) => ({
		title: r.title,
		url: r.url,
		snippet: r.content || "",
	}));
}

async function searchBrave(query: string, apiKey: string): Promise<SearchResult[]> {
	const encodedQuery = encodeURIComponent(query);
	const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodedQuery}`, {
		method: "GET",
		headers: {
			Accept: "application/json",
			"X-Subscription-Token": apiKey,
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	const data = (await response.json()) as {
		web?: { results?: Array<{ title: string; url: string; description?: string }> };
	};
	return (data.web?.results || []).slice(0, 10).map((r) => ({
		title: r.title,
		url: r.url,
		snippet: r.description || "",
	}));
}

export interface WebSearchConfig {
	backend?: "ddg" | "searxng" | "brave";
	searxngUrl?: string;
	braveApiKey?: string;
}

interface DrebConfig {
	search?: {
		backend?: string;
		searxng_url?: string;
		brave_api_key?: string;
	};
}

function loadDrebConfig(): DrebConfig {
	const candidates = [
		join(process.cwd(), CONFIG_DIR_NAME, "config.json"),
		join(process.cwd(), ".dreb", "config.json"),
		join(homedir(), CONFIG_DIR_NAME, "config.json"),
		join(homedir(), ".dreb", "config.json"),
	];
	for (const configPath of candidates) {
		if (existsSync(configPath)) {
			try {
				return JSON.parse(readFileSync(configPath, "utf-8")) as DrebConfig;
			} catch {
				// Malformed config — skip
			}
		}
	}
	return {};
}

function getSearchConfig(): WebSearchConfig {
	const fileConfig = loadDrebConfig();
	// Environment variables override config file
	const backend =
		(process.env.DREB_SEARCH_BACKEND as WebSearchConfig["backend"]) ||
		(fileConfig.search?.backend as WebSearchConfig["backend"]) ||
		"ddg";
	return {
		backend,
		searxngUrl: process.env.DREB_SEARXNG_URL || fileConfig.search?.searxng_url || "http://localhost:8888",
		braveApiKey: process.env.DREB_BRAVE_API_KEY || fileConfig.search?.brave_api_key,
	};
}

async function executeSearch(query: string): Promise<SearchResult[]> {
	const config = getSearchConfig();
	switch (config.backend) {
		case "searxng":
			return searchSearXNG(query, config.searxngUrl!);
		case "brave":
			if (!config.braveApiKey) throw new Error("DREB_BRAVE_API_KEY not set");
			return searchBrave(query, config.braveApiKey);
		case "ddg":
		default:
			return searchDuckDuckGo(query);
	}
}

function formatSearchCall(
	args: { query: string } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const query = str(args?.query);
	const invalidArg = invalidArgText(theme);
	return (
		theme.fg("toolTitle", theme.bold("web_search")) +
		" " +
		(query === null ? invalidArg : theme.fg("accent", `"${query}"`))
	);
}

function formatSearchResult(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: WebSearchToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 15;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
		}
	}
	return text;
}

export function createWebSearchToolDefinition(
	_cwd: string,
): ToolDefinition<typeof webSearchSchema, WebSearchToolDetails | undefined> {
	return {
		name: "web_search",
		label: "web_search",
		description: "Search the web. Returns titles, URLs, and snippets. Configure backend via DREB_SEARCH_BACKEND env var (ddg, searxng, brave).",
		promptSnippet: "Search the web for information",
		parameters: webSearchSchema,
		async execute(_toolCallId, { query }: { query: string }) {
			const results = await executeSearch(query);
			if (results.length === 0) {
				return {
					content: [{ type: "text", text: `No results found for: ${query}` }],
					details: undefined,
				};
			}
			const formatted = results
				.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
				.join("\n\n");
			const output = `Search results for: ${query}\n\n${formatted}`;
			return {
				content: [{ type: "text", text: output }],
				details: undefined,
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSearchCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSearchResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createWebSearchTool(cwd: string): AgentTool<typeof webSearchSchema> {
	return wrapToolDefinition(createWebSearchToolDefinition(cwd));
}

export const webSearchToolDefinition = createWebSearchToolDefinition(process.cwd());
export const webSearchTool = createWebSearchTool(process.cwd());

// ---------------------------------------------------------------------------
// web_fetch tool
// ---------------------------------------------------------------------------

const webFetchSchema = Type.Object({
	url: Type.String({ description: "The URL to fetch" }),
});

export type WebFetchToolInput = Static<typeof webFetchSchema>;

export interface WebFetchToolDetails {
	truncation?: TruncationResult;
	truncatedContent?: boolean;
}

function formatFetchCall(
	args: { url: string } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const url = str(args?.url);
	const invalidArg = invalidArgText(theme);
	return (
		theme.fg("toolTitle", theme.bold("web_fetch")) +
		" " +
		(url === null ? invalidArg : theme.fg("accent", url || ""))
	);
}

function formatFetchResult(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: WebFetchToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 30;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
		}
	}
	const details = result.details;
	if (details?.truncatedContent || details?.truncation?.truncated) {
		const warnings: string[] = [];
		if (details.truncatedContent) warnings.push(`${MAX_CONTENT_BYTES / 1000}KB content limit`);
		if (details.truncation?.truncated) warnings.push(`${formatSize(DEFAULT_MAX_BYTES)} output limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export function createWebFetchToolDefinition(
	_cwd: string,
): ToolDefinition<typeof webFetchSchema, WebFetchToolDetails | undefined> {
	return {
		name: "web_fetch",
		label: "web_fetch",
		description: `Fetch a URL and return its text content. Extracts readable text from HTML pages. Supports PDF text extraction. Content truncated to ${MAX_CONTENT_BYTES / 1000}KB. Results cached for 15 minutes.`,
		promptSnippet: "Fetch a URL and extract its text content",
		parameters: webFetchSchema,
		async execute(_toolCallId, { url }: { url: string }) {
			// Validate URL
			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				return {
					content: [{ type: "text", text: `Invalid URL: ${url}` }],
					details: undefined,
				};
			}

			if (!parsed.protocol.startsWith("http")) {
				return {
					content: [{ type: "text", text: `Unsupported protocol: ${parsed.protocol}` }],
					details: undefined,
				};
			}

			// Check cache (15-minute TTL)
			const cached = fetchCache.get(url);
			if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
				const r = cached.content;
				const output = `${r.title}\n${r.url}\nFetched: ${r.fetchedAt} (cached)\n\n${r.content}`;
				return {
					content: [{ type: "text", text: output }],
					details: undefined,
				};
			}

			// Fetch (with same-host redirect enforcement)
			let body: string | Buffer;
			let contentType: string;
			try {
				const result = await httpFetch(url);
				body = result.body;
				contentType = result.contentType;
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Failed to fetch ${url}: ${msg}` }],
					details: undefined,
				};
			}

			// Extract content based on content type
			let text: string;
			let title: string;
			const details: WebFetchToolDetails = {};
			const fetchedAt = new Date().toISOString();

			if (contentType.includes("application/pdf")) {
				title = url;
				text = extractPdfText(body as Buffer);
			} else if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
				const htmlBody = body as string;
				title = extractTitle(htmlBody) || url;
				text = stripHtmlToText(htmlBody);
			} else if (
				contentType.includes("text/plain") ||
				contentType.includes("application/json") ||
				contentType.includes("text/xml") ||
				contentType.includes("application/xml")
			) {
				title = url;
				text = body as string;
			} else {
				return {
					content: [{ type: "text", text: `Unsupported content type: ${contentType}` }],
					details: undefined,
				};
			}

			// Truncate to prevent context overflow
			if (text.length > MAX_CONTENT_BYTES) {
				text = text.slice(0, MAX_CONTENT_BYTES) + "\n\n[Content truncated at 100KB]";
				details.truncatedContent = true;
			}

			// Cache result
			const fetchResult: WebFetchResult = { url, title, content: text, contentLength: text.length, fetchedAt };
			fetchCache.set(url, { content: fetchResult, timestamp: Date.now() });

			const output = `${title}\n${url}\nFetched: ${fetchedAt}\n\n${text}`;
			const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER });
			if (truncation.truncated) {
				details.truncation = truncation;
			}

			return {
				content: [{ type: "text", text: truncation.content }],
				details: Object.keys(details).length > 0 ? details : undefined,
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatFetchCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatFetchResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createWebFetchTool(cwd: string): AgentTool<typeof webFetchSchema> {
	return wrapToolDefinition(createWebFetchToolDefinition(cwd));
}

export const webFetchToolDefinition = createWebFetchToolDefinition(process.cwd());
export const webFetchTool = createWebFetchTool(process.cwd());
