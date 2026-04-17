export interface SecretPattern {
	name: string;
	pattern: RegExp;
}

export interface ScrubResult {
	scrubbed: string;
	redactionCount: number;
}

// Multi-line patterns (processed first)
const pemPrivateKey =
	/-----BEGIN (?:RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/g;
const opensshPrivateKey = /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g;

// Single-line patterns
const awsAccessKey = /\bAKIA[0-9A-Z]{16}\b/g;
const githubToken =
	/ghp_[A-Za-z0-9_]{36,}|gho_[A-Za-z0-9_]{36,}|ghu_[A-Za-z0-9_]{36,}|ghs_[A-Za-z0-9_]{36,}|ghr_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{22,}/g;
const gitlabToken = /glpat-[0-9a-zA-Z_-]{20,}/g;
const anthropicKey = /sk-ant-[a-zA-Z0-9_-]{90,}/g;
const openaiKey = /sk-(?!ant-)[a-zA-Z0-9_-]{20,}/g;
const slackToken = /xox[baprs]-[0-9a-zA-Z-]{10,}/g;
const stripeKey = /[sr]k_(?:test|live)_[0-9a-zA-Z]{24,}/g;
const urlCredentials = /(https?:\/\/)([^\s:]+):([^\s@]+)@/g;

const MULTILINE_PATTERNS: SecretPattern[] = [
	{ name: "pem_private_key", pattern: pemPrivateKey },
	{ name: "openssh_private_key", pattern: opensshPrivateKey },
];

const SINGLELINE_PATTERNS: SecretPattern[] = [
	{ name: "aws_access_key", pattern: awsAccessKey },
	{ name: "github_token", pattern: githubToken },
	{ name: "gitlab_token", pattern: gitlabToken },
	{ name: "anthropic_key", pattern: anthropicKey },
	{ name: "openai_key", pattern: openaiKey },
	{ name: "slack_token", pattern: slackToken },
	{ name: "stripe_key", pattern: stripeKey },
	{ name: "url_credentials", pattern: urlCredentials },
];

export const DEFAULT_SECRET_PATTERNS: SecretPattern[] = [...MULTILINE_PATTERNS, ...SINGLELINE_PATTERNS];

export function scrubSecrets(text: string, extraPatterns?: SecretPattern[]): ScrubResult {
	let scrubbed = text;
	let redactionCount = 0;

	function applyPattern(sp: SecretPattern): void {
		// Reset lastIndex since we reuse compiled regexes
		sp.pattern.lastIndex = 0;

		if (sp.name === "url_credentials") {
			scrubbed = scrubbed.replace(sp.pattern, (_match, protocol, user, _password) => {
				redactionCount++;
				return `${protocol}${user}:<REDACTED:url_credentials>@`;
			});
		} else {
			scrubbed = scrubbed.replace(sp.pattern, () => {
				redactionCount++;
				return `<REDACTED:${sp.name}>`;
			});
		}
	}

	// Multi-line patterns first
	for (const sp of MULTILINE_PATTERNS) {
		applyPattern(sp);
	}

	// Single-line patterns
	for (const sp of SINGLELINE_PATTERNS) {
		applyPattern(sp);
	}

	// Extra patterns last
	if (extraPatterns) {
		for (const sp of extraPatterns) {
			applyPattern(sp);
		}
	}

	return { scrubbed, redactionCount };
}
