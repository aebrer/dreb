import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerApiProvider, unregisterApiProviders } from "../src/api-registry.js";
import { resolveConfigTemplate, stream, streamSimple } from "../src/stream.js";
import type { Api, Context, Model } from "../src/types.js";
import { createAssistantMessageEventStream } from "../src/utils/event-stream.js";

const API = "test-config-templates" as Api;
const SOURCE = "test:config-templates";
const ENV_A = "DREB_TEST_TEMPLATE_A";
const ENV_B = "DREB_TEST_TEMPLATE_B";
const context: Context = { messages: [] };

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "m",
		name: "M",
		api: API,
		provider: "tmpl",
		baseUrl: "https://literal.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
		...overrides,
	};
}

describe("resolveConfigTemplate", () => {
	afterEach(() => {
		delete process.env[ENV_A];
		delete process.env[ENV_B];
	});

	it("returns undefined for values without template syntax", () => {
		expect(resolveConfigTemplate(undefined)).toBeUndefined();
		expect(resolveConfigTemplate("https://literal.example/v1")).toBeUndefined();
		expect(resolveConfigTemplate("MY_ENV_NAME")).toBeUndefined();
		expect(resolveConfigTemplate("{other:X}")).toBeUndefined();
	});

	it("expands multiple tokens in one value and trims each", () => {
		process.env[ENV_A] = " host.example ";
		process.env[ENV_B] = "\t8443\n";
		expect(resolveConfigTemplate(`https://{env:${ENV_A}}:{env:${ENV_B}}/v1`)).toBe("https://host.example:8443/v1");
	});

	it("reads and trims file contents", () => {
		const dir = mkdtempSync(join(tmpdir(), "dreb-ai-template-file-"));
		try {
			const file = join(dir, "value");
			writeFileSync(file, "  from-file\n");
			expect(resolveConfigTemplate(`{file:${file}}`)).toBe("from-file");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("throws for missing, empty, and whitespace-only variables", () => {
		expect(() => resolveConfigTemplate(`{env:${ENV_A}}`)).toThrow(`{env:${ENV_A}} has no value`);
		process.env[ENV_A] = "";
		expect(() => resolveConfigTemplate(`{env:${ENV_A}}`)).toThrow("has no value");
		process.env[ENV_A] = "   ";
		expect(() => resolveConfigTemplate(`{env:${ENV_A}}`)).toThrow("has no value");
	});

	it("names the file when it cannot be read", () => {
		const missing = join(tmpdir(), `dreb-template-missing-${Date.now()}-${Math.random()}`);
		expect(() => resolveConfigTemplate(`{file:${missing}}`)).toThrow(`{file:${missing}}: ENOENT`);
	});
});

describe("stream()/streamSimple() baseUrl template resolution", () => {
	let seen: { via: "stream" | "streamSimple"; model: Model<Api> }[];

	beforeEach(() => {
		seen = [];
		registerApiProvider(
			{
				api: API,
				stream: (m) => {
					seen.push({ via: "stream", model: m });
					return createAssistantMessageEventStream();
				},
				streamSimple: (m) => {
					seen.push({ via: "streamSimple", model: m });
					return createAssistantMessageEventStream();
				},
			},
			SOURCE,
		);
	});

	afterEach(() => {
		unregisterApiProviders(SOURCE);
		delete process.env[ENV_A];
	});

	it("passes the original model object through when baseUrl is not templated", () => {
		const m = model();
		stream(m, context);
		streamSimple(m, context);
		expect(seen.map((s) => s.via)).toEqual(["stream", "streamSimple"]);
		expect(seen[0].model).toBe(m);
		expect(seen[1].model).toBe(m);
	});

	it.each(["stream", "streamSimple"] as const)("%s resolves baseUrl per call without mutating the model", (via) => {
		const call = via === "stream" ? stream : streamSimple;
		const m = model({ baseUrl: `{env:${ENV_A}}/v1` });

		process.env[ENV_A] = "https://first.example";
		call(m, context);
		process.env[ENV_A] = "https://second.example";
		call(m, context);

		expect(seen.map((s) => s.via)).toEqual([via, via]);
		expect(seen.map((s) => s.model.baseUrl)).toEqual(["https://first.example/v1", "https://second.example/v1"]);
		expect(m.baseUrl).toBe(`{env:${ENV_A}}/v1`);
	});

	it.each(["stream", "streamSimple"] as const)(
		"%s fails closed before reaching the provider when baseUrl cannot be resolved",
		(via) => {
			const call = via === "stream" ? stream : streamSimple;
			expect(() => call(model({ baseUrl: `{env:${ENV_A}}/v1` }), context)).toThrow(
				`Provider "tmpl": {env:${ENV_A}} has no value`,
			);
			expect(seen).toEqual([]);
		},
	);
});
