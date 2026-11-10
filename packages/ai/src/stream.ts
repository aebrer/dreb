import "./providers/register-builtins.js";

import { getApiProvider } from "./api-registry.js";
import { withOpenCodeSessionHeader } from "./providers/opencode-headers.js";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreamOptions,
	SimpleStreamOptions,
	StreamOptions,
} from "./types.js";

export { getEnvApiKey } from "./env-api-keys.js";

const TEMPLATE_TOKEN = /\{(env|file):([^}]+)\}/g;

function readFile(path: string): string {
	// Resolve at call time so the root barrel stays usable in browsers.
	const fs = typeof process === "undefined" ? undefined : process.getBuiltinModule?.("node:fs");
	if (!fs || !("readFileSync" in fs)) {
		throw new Error(`{file:${path}} is not supported in this environment`);
	}
	try {
		return (fs as typeof import("node:fs")).readFileSync(path, "utf-8");
	} catch (error) {
		throw new Error(`{file:${path}}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Expand `{env:NAME}` / `{file:PATH}` tokens; undefined when the value has none. */
export function resolveConfigTemplate(value: string | undefined): string | undefined {
	if (typeof value !== "string" || (!value.includes("{env:") && !value.includes("{file:"))) {
		return undefined;
	}
	return value.replace(TEMPLATE_TOKEN, (_match, kind: "env" | "file", name: string) => {
		const resolved = kind === "env" ? process.env[name] : readFile(name);
		const trimmed = resolved?.trim();
		if (!trimmed) {
			throw new Error(`{${kind}:${name}} has no value`);
		}
		return trimmed;
	});
}

function resolveApiProvider(api: Api) {
	const provider = getApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

function resolveBaseUrl<TApi extends Api>(model: Model<TApi>): Model<TApi> {
	try {
		const baseUrl = resolveConfigTemplate(model.baseUrl);
		return baseUrl === undefined ? model : { ...model, baseUrl };
	} catch (error) {
		throw new Error(`Provider "${model.provider}": ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	const resolvedModel = resolveBaseUrl(model);
	const provider = resolveApiProvider(resolvedModel.api);
	return provider.stream(resolvedModel, context, withOpenCodeSessionHeader(resolvedModel, options) as StreamOptions);
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	const s = stream(model, context, options);
	return s.result();
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const resolvedModel = resolveBaseUrl(model);
	const provider = resolveApiProvider(resolvedModel.api);
	return provider.streamSimple(resolvedModel, context, withOpenCodeSessionHeader(resolvedModel, options));
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}
