import { readFileSync, statSync } from "node:fs";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { resolveToCwd } from "./tools/path-utils.js";

export const DEFAULT_MODEL_ROUTING_GUIDE_PATH = "~/.dreb/agent/model-routing-guide.md";
export const MAX_MODEL_ROUTING_GUIDE_BYTES = 128 * 1024;

const REQUIRED_MODEL_SUBSECTIONS = [
	"Capabilities and thinking support",
	"Strengths",
	"Weaknesses and failure modes",
	"Recommended roles and tasks",
	"Discouraged roles and tasks",
	"Tool use, long context, and vision",
	"Latency and cost",
	"Local evidence",
	"External evidence and contrary findings",
	"Confidence and limitations",
	"Sources",
] as const;

interface RoutingGuideFrontmatter extends Record<string, unknown> {
	schema_version?: unknown;
	generated_at?: unknown;
	covered_model_ids?: unknown;
	local_evidence?: unknown;
	analyzed_session_directories?: unknown;
	session_date_range?: unknown;
}

export interface ValidatedModelRoutingGuide {
	path: string;
	content: string;
	coveredModelIds: string[];
	generatedAt: string;
	localEvidence: "available" | "cold-start";
}

export class ModelRoutingGuideError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelRoutingGuideError";
	}
}

function isCanonicalModelId(value: string): boolean {
	const slash = value.indexOf("/");
	return slash > 0 && slash < value.length - 1 && !/\s/.test(value);
}

function compareExactSets(actual: string[], expected: readonly string[], label: string): void {
	const actualSet = new Set(actual);
	const expectedSet = new Set(expected);
	const missing = [...expectedSet].filter((value) => !actualSet.has(value));
	const extra = [...actualSet].filter((value) => !expectedSet.has(value));
	if (missing.length === 0 && extra.length === 0) return;

	const details = [
		missing.length > 0 ? `missing: ${missing.join(", ")}` : undefined,
		extra.length > 0 ? `extra: ${extra.join(", ")}` : undefined,
	].filter(Boolean);
	throw new ModelRoutingGuideError(`${label} does not match the active model scope (${details.join("; ")}).`);
}

function validateDateRange(value: unknown): { start: string | null; end: string | null } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ModelRoutingGuideError("Routing guide frontmatter requires session_date_range.");
	}
	const range = value as Record<string, unknown>;
	for (const key of ["start", "end"] as const) {
		const item = range[key];
		if (item !== null && (typeof item !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item))) {
			throw new ModelRoutingGuideError(`Routing guide session_date_range.${key} must be YYYY-MM-DD or null.`);
		}
	}
	return { start: range.start as string | null, end: range.end as string | null };
}

function parseModelSections(body: string): Map<string, string> {
	const headingPattern = /^## Model: ([^\r\n]+)\s*$/gm;
	const matches = [...body.matchAll(headingPattern)];
	const sections = new Map<string, string>();

	for (let index = 0; index < matches.length; index++) {
		const match = matches[index];
		const modelId = match[1].trim();
		if (!isCanonicalModelId(modelId)) {
			throw new ModelRoutingGuideError(`Routing guide has invalid canonical model heading "${modelId}".`);
		}
		if (sections.has(modelId)) {
			throw new ModelRoutingGuideError(`Routing guide has duplicate model heading "${modelId}".`);
		}
		const start = (match.index ?? 0) + match[0].length;
		const end = matches[index + 1]?.index ?? body.length;
		sections.set(modelId, body.slice(start, end));
	}

	return sections;
}

export function validateModelRoutingGuideContent(
	content: string,
	activeModelIds: readonly string[],
	path = DEFAULT_MODEL_ROUTING_GUIDE_PATH,
): ValidatedModelRoutingGuide {
	if (activeModelIds.length === 0) {
		throw new ModelRoutingGuideError(
			"Dispatch arbitration requires a non-empty explicit live model scope. Start dreb with --models or configure enabledModels.",
		);
	}
	if (new Set(activeModelIds).size !== activeModelIds.length) {
		throw new ModelRoutingGuideError("The active model scope contains duplicate canonical model IDs.");
	}
	for (const modelId of activeModelIds) {
		if (!isCanonicalModelId(modelId)) {
			throw new ModelRoutingGuideError(`The active model scope contains invalid canonical ID "${modelId}".`);
		}
	}

	let parsed: ReturnType<typeof parseFrontmatter<RoutingGuideFrontmatter>>;
	try {
		parsed = parseFrontmatter<RoutingGuideFrontmatter>(content);
	} catch (error) {
		throw new ModelRoutingGuideError(
			`Routing guide YAML frontmatter is malformed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const { frontmatter, body } = parsed;
	if (frontmatter.schema_version !== 1) {
		throw new ModelRoutingGuideError("Routing guide schema_version must be 1.");
	}
	if (
		typeof frontmatter.generated_at !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(frontmatter.generated_at) ||
		Number.isNaN(Date.parse(frontmatter.generated_at))
	) {
		throw new ModelRoutingGuideError("Routing guide generated_at must be a valid timestamp.");
	}
	if (frontmatter.local_evidence !== "available" && frontmatter.local_evidence !== "cold-start") {
		throw new ModelRoutingGuideError('Routing guide local_evidence must be "available" or "cold-start".');
	}
	if (
		!Array.isArray(frontmatter.analyzed_session_directories) ||
		frontmatter.analyzed_session_directories.length === 0 ||
		!frontmatter.analyzed_session_directories.every((value) => typeof value === "string" && value.length > 0)
	) {
		throw new ModelRoutingGuideError("Routing guide analyzed_session_directories must be an array of strings.");
	}
	const dateRange = validateDateRange(frontmatter.session_date_range);
	if (frontmatter.local_evidence === "cold-start" && (dateRange.start !== null || dateRange.end !== null)) {
		throw new ModelRoutingGuideError("Cold-start routing guides require null session date-range bounds.");
	}
	if (frontmatter.local_evidence === "available" && (dateRange.start === null || dateRange.end === null)) {
		throw new ModelRoutingGuideError(
			"Routing guides with local evidence require non-null session date-range bounds.",
		);
	}

	if (!Array.isArray(frontmatter.covered_model_ids) || frontmatter.covered_model_ids.length === 0) {
		throw new ModelRoutingGuideError("Routing guide covered_model_ids must be a non-empty array.");
	}
	const coveredModelIds = frontmatter.covered_model_ids.map((value) => {
		if (typeof value !== "string" || !isCanonicalModelId(value)) {
			throw new ModelRoutingGuideError("Routing guide covered_model_ids contains an invalid canonical model ID.");
		}
		return value;
	});
	if (new Set(coveredModelIds).size !== coveredModelIds.length) {
		throw new ModelRoutingGuideError("Routing guide covered_model_ids contains duplicates.");
	}
	compareExactSets(coveredModelIds, activeModelIds, "Routing guide frontmatter coverage");

	if (!/^# Model Routing Guide\s*$/m.test(body)) {
		throw new ModelRoutingGuideError('Routing guide body requires the heading "# Model Routing Guide".');
	}
	if (!/^## Routing safeguards\s*$/m.test(body)) {
		throw new ModelRoutingGuideError('Routing guide body requires the section "## Routing safeguards".');
	}

	const sections = parseModelSections(body);
	compareExactSets([...sections.keys()], activeModelIds, "Routing guide model headings");
	for (const [modelId, section] of sections) {
		for (const subsection of REQUIRED_MODEL_SUBSECTIONS) {
			const escaped = subsection.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const match = new RegExp(`^### ${escaped}\\s*$`, "m").exec(section);
			if (!match) {
				throw new ModelRoutingGuideError(`Routing guide model "${modelId}" is missing subsection "${subsection}".`);
			}
			const bodyStart = (match.index ?? 0) + match[0].length;
			const remainder = section.slice(bodyStart);
			const nextHeading = remainder.search(/^### |^## /m);
			const subsectionBody = nextHeading === -1 ? remainder : remainder.slice(0, nextHeading);
			if (!subsectionBody.trim()) {
				throw new ModelRoutingGuideError(`Routing guide model "${modelId}" has empty subsection "${subsection}".`);
			}
		}
	}

	return {
		path,
		content,
		coveredModelIds,
		generatedAt: frontmatter.generated_at,
		localEvidence: frontmatter.local_evidence,
	};
}

export function loadAndValidateModelRoutingGuide(
	configuredPath: string | undefined,
	cwd: string,
	activeModelIds: readonly string[],
): ValidatedModelRoutingGuide {
	const path = resolveToCwd(configuredPath?.trim() || DEFAULT_MODEL_ROUTING_GUIDE_PATH, cwd);
	let size: number;
	try {
		size = statSync(path).size;
	} catch (error) {
		throw new ModelRoutingGuideError(
			`Cannot read routing guide at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (size > MAX_MODEL_ROUTING_GUIDE_BYTES) {
		throw new ModelRoutingGuideError(
			`Routing guide at ${path} is too large (${size} bytes; maximum ${MAX_MODEL_ROUTING_GUIDE_BYTES}).`,
		);
	}

	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch (error) {
		throw new ModelRoutingGuideError(
			`Cannot read routing guide at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (Buffer.byteLength(content, "utf8") > MAX_MODEL_ROUTING_GUIDE_BYTES) {
		throw new ModelRoutingGuideError(`Routing guide at ${path} exceeds the maximum size after reading.`);
	}
	return validateModelRoutingGuideContent(content, activeModelIds, path);
}
