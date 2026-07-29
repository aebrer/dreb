import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	loadAndValidateModelRoutingGuide,
	MAX_MODEL_ROUTING_GUIDE_BYTES,
	validateModelRoutingGuideContent,
} from "../src/core/model-routing-guide.js";

const REQUIRED_SUBSECTIONS = [
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
];

function guide(
	modelIds = ["provider/model-a"],
	options: {
		duplicateHeading?: boolean;
		omit?: string;
		headingModelIds?: string[];
		schemaVersion?: number;
		omitRootHeading?: boolean;
		omitSafeguards?: boolean;
		localEvidence?: "available" | "cold-start";
		dateStart?: string | null;
		dateEnd?: string | null;
	} = {},
): string {
	const headingModelIds = options.headingModelIds ?? modelIds;
	const localEvidence = options.localEvidence ?? "cold-start";
	const dateStart =
		options.dateStart === undefined ? (localEvidence === "available" ? "2026-07-01" : null) : options.dateStart;
	const dateEnd =
		options.dateEnd === undefined ? (localEvidence === "available" ? "2026-07-28" : null) : options.dateEnd;
	const yamlDate = (value: string | null) => (value === null ? "null" : `"${value}"`);
	const sections = headingModelIds
		.map(
			(modelId) =>
				`## Model: ${modelId}\n${REQUIRED_SUBSECTIONS.filter((name) => name !== options.omit)
					.map((name) => `### ${name}\nUnknown`)
					.join("\n")}`,
		)
		.join("\n");
	return `---
schema_version: ${options.schemaVersion ?? 1}
generated_at: "2026-07-28T00:00:00Z"
covered_model_ids:
${modelIds.map((id) => `  - "${id}"`).join("\n")}
local_evidence: "${localEvidence}"
analyzed_session_directories:
  - "~/.dreb/agent/subagent-sessions/"
session_date_range:
  start: ${yamlDate(dateStart)}
  end: ${yamlDate(dateEnd)}
---
${options.omitRootHeading ? "" : "# Model Routing Guide"}
${options.omitSafeguards ? "" : "## Routing safeguards\nUse role and cost fit."}
${sections}
${options.duplicateHeading ? sections : ""}
`;
}

let tempDir: string | undefined;
afterEach(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

describe("model routing guide validation", () => {
	test("accepts the stage 1 schema with exact canonical live-scope coverage", () => {
		const result = validateModelRoutingGuideContent(guide(["provider/model-a", "other/model-b"]), [
			"other/model-b",
			"provider/model-a",
		]);
		expect(result.coveredModelIds).toEqual(["provider/model-a", "other/model-b"]);
		expect(result.localEvidence).toBe("cold-start");
	});

	test("accepts a guide backed by available local-history evidence", () => {
		const result = validateModelRoutingGuideContent(
			guide(["provider/model-a"], {
				localEvidence: "available",
				dateStart: "2026-07-01",
				dateEnd: "2026-07-28",
			}),
			["provider/model-a"],
		);
		expect(result.localEvidence).toBe("available");
	});

	test.each([
		[
			"available evidence without a start date",
			{ localEvidence: "available", dateStart: null },
			/non-null session date-range bounds/,
		],
		[
			"available evidence without an end date",
			{ localEvidence: "available", dateEnd: null },
			/non-null session date-range bounds/,
		],
		[
			"cold-start evidence with a start date",
			{ localEvidence: "cold-start", dateStart: "2026-07-01" },
			/null session date-range bounds/,
		],
		[
			"cold-start evidence with an end date",
			{ localEvidence: "cold-start", dateEnd: "2026-07-28" },
			/null session date-range bounds/,
		],
	] as const)("rejects %s", (_label, options, expected) => {
		expect(() =>
			validateModelRoutingGuideContent(guide(["provider/model-a"], options), ["provider/model-a"]),
		).toThrow(expected);
	});

	test.each([
		["missing", ["provider/model-a", "other/model-b"], ["provider/model-a"]],
		["extra", ["provider/model-a"], ["provider/model-a", "other/model-b"]],
	] as const)("rejects %s frontmatter coverage", (_label, covered, active) => {
		expect(() => validateModelRoutingGuideContent(guide([...covered]), [...active])).toThrow(
			/Routing guide frontmatter coverage does not match/,
		);
	});

	test.each([
		["missing", []],
		["extra", ["provider/model-a", "other/model-b"]],
		["mismatched", ["other/model-b"]],
	] as const)("rejects %s model-heading coverage independently of valid frontmatter", (_label, headingModelIds) => {
		expect(() =>
			validateModelRoutingGuideContent(guide(["provider/model-a"], { headingModelIds: [...headingModelIds] }), [
				"provider/model-a",
			]),
		).toThrow(/Routing guide model headings does not match/);
	});

	test("rejects unsupported schema versions", () => {
		expect(() =>
			validateModelRoutingGuideContent(guide(["provider/model-a"], { schemaVersion: 2 }), ["provider/model-a"]),
		).toThrow(/schema_version must be 1/);
	});

	test.each([
		["root heading", { omitRootHeading: true }, /requires the heading "# Model Routing Guide"/],
		["routing safeguards", { omitSafeguards: true }, /requires the section "## Routing safeguards"/],
	] as const)("rejects a guide missing its required %s", (_label, options, expected) => {
		expect(() =>
			validateModelRoutingGuideContent(guide(["provider/model-a"], options), ["provider/model-a"]),
		).toThrow(expected);
	});

	test("rejects duplicate model headings", () => {
		expect(() =>
			validateModelRoutingGuideContent(guide(["provider/model-a"], { duplicateHeading: true }), [
				"provider/model-a",
			]),
		).toThrow(/duplicate model heading/);
	});

	test("rejects missing or empty required model subsections", () => {
		expect(() =>
			validateModelRoutingGuideContent(guide(["provider/model-a"], { omit: "Latency and cost" }), [
				"provider/model-a",
			]),
		).toThrow(/Latency and cost/);
		const emptyStrengths = guide().replace("### Strengths\nUnknown", "### Strengths\n");
		expect(() => validateModelRoutingGuideContent(emptyStrengths, ["provider/model-a"])).toThrow(/empty subsection/);
	});

	test("rejects malformed YAML and empty live scope loudly", () => {
		expect(() => validateModelRoutingGuideContent("---\ncovered_model_ids: [\n---\n", ["provider/model-a"])).toThrow(
			/malformed/,
		);
		expect(() => validateModelRoutingGuideContent(guide(), [])).toThrow(/non-empty explicit live model scope/);
	});

	test("reads once from the configured path and rejects oversized guides before parsing", () => {
		const dir = mkdtempSync(join(tmpdir(), "dreb-routing-guide-"));
		tempDir = dir;
		const validPath = join(dir, "guide.md");
		writeFileSync(validPath, guide());
		expect(loadAndValidateModelRoutingGuide(validPath, dir, ["provider/model-a"]).path).toBe(validPath);

		const largePath = join(dir, "large.md");
		writeFileSync(largePath, "x".repeat(MAX_MODEL_ROUTING_GUIDE_BYTES + 1));
		expect(() => loadAndValidateModelRoutingGuide(largePath, dir, ["provider/model-a"])).toThrow(/too large/);
	});
});
