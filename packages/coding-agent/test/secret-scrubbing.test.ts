import { homedir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SECRET_PATTERNS, type SecretPattern, scrubSecrets } from "../src/core/secret-scrubber.js";
import { DEFAULT_SENSITIVE_PATTERNS, isSensitivePath } from "../src/core/sensitive-paths.js";

// ============================================================================
// Layer 1: Output Scrubbing (secret-scrubber.ts)
// ============================================================================

describe("scrubSecrets", () => {
	describe("pattern registry", () => {
		it("exports DEFAULT_SECRET_PATTERNS with all expected patterns", () => {
			const names = DEFAULT_SECRET_PATTERNS.map((p) => p.name);
			expect(names).toContain("aws_access_key");
			expect(names).toContain("github_token");
			expect(names).toContain("gitlab_token");
			expect(names).toContain("anthropic_key");
			expect(names).toContain("openai_key");
			expect(names).toContain("slack_token");
			expect(names).toContain("stripe_key");
			expect(names).toContain("url_credentials");
			expect(names).toContain("pem_private_key");
			expect(names).toContain("openssh_private_key");
		});
	});

	describe("AWS access key", () => {
		it("redacts AWS access key", () => {
			const input = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
			const { scrubbed, redactionCount } = scrubSecrets(input);
			expect(scrubbed).toBe("AWS_ACCESS_KEY_ID=<REDACTED:aws_access_key>");
			expect(redactionCount).toBe(1);
		});

		it("redacts AWS key embedded in text", () => {
			const input = "Found key AKIAIOSFODNN7EXAMPLE in config";
			const { scrubbed } = scrubSecrets(input);
			expect(scrubbed).toContain("<REDACTED:aws_access_key>");
			expect(scrubbed).not.toContain("AKIAIOSFODNN7EXAMPLE");
		});

		it("does not redact MD5 hash", () => {
			const input = "hash: d41d8cd98f00b204e9800998ecf8427e";
			const { scrubbed, redactionCount } = scrubSecrets(input);
			expect(scrubbed).toBe(input);
			expect(redactionCount).toBe(0);
		});

		it("does not redact short strings that happen to start with AKIA", () => {
			const input = "AKIA1234"; // only 4 chars after AKIA, need 16
			const { scrubbed, redactionCount } = scrubSecrets(input);
			expect(scrubbed).toBe(input);
			expect(redactionCount).toBe(0);
		});
	});

	describe("GitHub tokens", () => {
		it("redacts ghp_ personal access token", () => {
			const token = "ghp_ABCDEFghijklmnop1234567890abcdefghij";
			const { scrubbed, redactionCount } = scrubSecrets(`token=${token}`);
			expect(scrubbed).toBe("token=<REDACTED:github_token>");
			expect(redactionCount).toBe(1);
		});

		it("redacts ghs_ service token", () => {
			const token = "ghs_ABCDEFghijklmnop1234567890abcdefghij";
			const { scrubbed } = scrubSecrets(token);
			expect(scrubbed).toBe("<REDACTED:github_token>");
		});

		it("redacts gho_ OAuth token", () => {
			const token = "gho_ABCDEFghijklmnop1234567890abcdefghij";
			const { scrubbed } = scrubSecrets(token);
			expect(scrubbed).toBe("<REDACTED:github_token>");
		});

		it("redacts ghu_ user token", () => {
			const token = "ghu_ABCDEFghijklmnop1234567890abcdefghij";
			const { scrubbed } = scrubSecrets(token);
			expect(scrubbed).toBe("<REDACTED:github_token>");
		});

		it("redacts ghr_ refresh token", () => {
			const token = "ghr_ABCDEFghijklmnop1234567890abcdefghij";
			const { scrubbed } = scrubSecrets(token);
			expect(scrubbed).toBe("<REDACTED:github_token>");
		});

		it("does not redact ghp_ with insufficient length", () => {
			const input = "ghp_short";
			const { scrubbed, redactionCount } = scrubSecrets(input);
			expect(scrubbed).toBe(input);
			expect(redactionCount).toBe(0);
		});
	});

	describe("GitHub fine-grained PATs", () => {
		it("redacts github_pat_ token", () => {
			const token = `github_pat_${"A".repeat(82)}`;
			const { scrubbed, redactionCount } = scrubSecrets(`GITHUB_TOKEN=${token}`);
			expect(scrubbed).toBe("GITHUB_TOKEN=<REDACTED:github_token>");
			expect(redactionCount).toBe(1);
		});

		it("does not redact github_pat_ with insufficient length", () => {
			const input = "github_pat_short";
			const { scrubbed, redactionCount } = scrubSecrets(input);
			expect(scrubbed).toBe(input);
			expect(redactionCount).toBe(0);
		});
	});

	describe("GitLab tokens", () => {
		it("redacts glpat- token", () => {
			const token = "glpat-ABCDEFghijklmnop12345";
			const { scrubbed } = scrubSecrets(`GITLAB_TOKEN=${token}`);
			expect(scrubbed).toBe("GITLAB_TOKEN=<REDACTED:gitlab_token>");
		});

		it("does not redact glpat- with insufficient length", () => {
			const input = "glpat-short";
			const { scrubbed, redactionCount } = scrubSecrets(input);
			expect(scrubbed).toBe(input);
			expect(redactionCount).toBe(0);
		});
	});

	describe("OpenAI keys", () => {
		it("redacts sk-proj- style key", () => {
			const key = "sk-proj-abc123def456ghi789jkl";
			const { scrubbed } = scrubSecrets(`OPENAI_API_KEY=${key}`);
			expect(scrubbed).toBe("OPENAI_API_KEY=<REDACTED:openai_key>");
		});

		it("redacts sk- key with sufficient length", () => {
			const key = "sk-abcdefghijklmnopqrstuvwx";
			const { scrubbed } = scrubSecrets(key);
			expect(scrubbed).toBe("<REDACTED:openai_key>");
		});

		it("does not redact short sk- prefix", () => {
			const input = "sk-abc";
			const { scrubbed, redactionCount } = scrubSecrets(input);
			expect(scrubbed).toBe(input);
			expect(redactionCount).toBe(0);
		});

		it("does not redact sk-ant- (handled by anthropic pattern)", () => {
			const key = `sk-ant-${"a".repeat(95)}`;
			const { scrubbed } = scrubSecrets(key);
			expect(scrubbed).toBe("<REDACTED:anthropic_key>");
			expect(scrubbed).not.toContain("openai_key");
		});
	});

	describe("Anthropic keys", () => {
		it("redacts sk-ant- key", () => {
			const key = `sk-ant-api03-${"A".repeat(90)}`;
			const { scrubbed } = scrubSecrets(`key=${key}`);
			expect(scrubbed).toBe("key=<REDACTED:anthropic_key>");
		});

		it("does not redact sk-ant- with insufficient length", () => {
			const input = "sk-ant-short";
			const { redactionCount } = scrubSecrets(input);
			// This is too short for anthropic (needs 90+ after sk-ant-), but might match openai
			// sk-ant-short is 12 chars after sk- which is < 20, so no match for either
			expect(redactionCount).toBe(0);
		});
	});

	describe("Slack tokens", () => {
		it("redacts xoxb- bot token", () => {
			const token = "xoxb-1234567890-abcdefghij";
			const { scrubbed } = scrubSecrets(`SLACK_TOKEN=${token}`);
			expect(scrubbed).toBe("SLACK_TOKEN=<REDACTED:slack_token>");
		});

		it("redacts xoxp- user token", () => {
			const token = "xoxp-1234567890-abcdefghij";
			const { scrubbed } = scrubSecrets(token);
			expect(scrubbed).toBe("<REDACTED:slack_token>");
		});

		it("redacts xoxa- app token", () => {
			const token = "xoxa-1234567890-abcdefghij";
			const { scrubbed } = scrubSecrets(token);
			expect(scrubbed).toBe("<REDACTED:slack_token>");
		});

		it("does not redact xoxb- with insufficient length", () => {
			const input = "xoxb-short";
			const { scrubbed, redactionCount } = scrubSecrets(input);
			expect(scrubbed).toBe(input);
			expect(redactionCount).toBe(0);
		});
	});

	describe("Stripe keys", () => {
		it("redacts sk_live_ key", () => {
			const key = `sk_live_${"a".repeat(24)}`;
			const { scrubbed } = scrubSecrets(`STRIPE_KEY=${key}`);
			expect(scrubbed).toBe("STRIPE_KEY=<REDACTED:stripe_key>");
		});

		it("redacts sk_test_ key", () => {
			const key = `sk_test_${"b".repeat(24)}`;
			const { scrubbed } = scrubSecrets(key);
			expect(scrubbed).toBe("<REDACTED:stripe_key>");
		});

		it("redacts rk_live_ restricted key", () => {
			const key = `rk_live_${"c".repeat(24)}`;
			const { scrubbed } = scrubSecrets(key);
			expect(scrubbed).toBe("<REDACTED:stripe_key>");
		});

		it("does not redact sk_live_ with insufficient length", () => {
			const input = "sk_live_short";
			const { scrubbed, redactionCount } = scrubSecrets(input);
			expect(scrubbed).toBe(input);
			expect(redactionCount).toBe(0);
		});
	});

	describe("URL credentials", () => {
		it("redacts password in https URL", () => {
			const input = "https://admin:s3cret@db.example.com:5432/mydb";
			const { scrubbed, redactionCount } = scrubSecrets(input);
			expect(scrubbed).toBe("https://admin:<REDACTED:url_credentials>@db.example.com:5432/mydb");
			expect(redactionCount).toBe(1);
		});

		it("redacts password in http URL", () => {
			const input = "http://user:password123@host.com";
			const { scrubbed } = scrubSecrets(input);
			expect(scrubbed).toBe("http://user:<REDACTED:url_credentials>@host.com");
		});

		it("does not redact URL without credentials", () => {
			const input = "https://host.com/path";
			const { scrubbed, redactionCount } = scrubSecrets(input);
			expect(scrubbed).toBe(input);
			expect(redactionCount).toBe(0);
		});

		it("does not redact URL with only user (no password)", () => {
			const input = "https://user@host.com";
			const { scrubbed, redactionCount } = scrubSecrets(input);
			expect(scrubbed).toBe(input);
			expect(redactionCount).toBe(0);
		});
	});

	describe("PEM private keys", () => {
		it("redacts RSA private key block", () => {
			const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA2a2rwplBQLcD2B4VkXqKV++jGz1z7FxCVHZ8h1jFJYBP
KQEFhBSWFkZjhGk1LZ0qb1FQfr1XQ2v3Oag9N3hb0q7k1Ef
-----END RSA PRIVATE KEY-----`;
			const { scrubbed, redactionCount } = scrubSecrets(`cert:\n${pem}\nmore text`);
			expect(scrubbed).toBe("cert:\n<REDACTED:pem_private_key>\nmore text");
			expect(redactionCount).toBe(1);
		});

		it("redacts EC private key block", () => {
			const pem = `-----BEGIN EC PRIVATE KEY-----
MHQCAQEEIOLwH3zAA1NwDXxBUJkIc0gA8j+7OzQ5Bz6JFnSFYW
-----END EC PRIVATE KEY-----`;
			const { scrubbed } = scrubSecrets(pem);
			expect(scrubbed).toBe("<REDACTED:pem_private_key>");
		});

		it("redacts ENCRYPTED private key block", () => {
			const pem = `-----BEGIN ENCRYPTED PRIVATE KEY-----
MIIFHDBOBgkqhkiG9w0BBQ0wQTApBgkqhkiG9w0BBQwwHAQI
-----END ENCRYPTED PRIVATE KEY-----`;
			const { scrubbed } = scrubSecrets(pem);
			expect(scrubbed).toBe("<REDACTED:pem_private_key>");
		});

		it("redacts plain PRIVATE KEY block (PKCS8)", () => {
			const pem = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEA
-----END PRIVATE KEY-----`;
			const { scrubbed } = scrubSecrets(pem);
			expect(scrubbed).toBe("<REDACTED:pem_private_key>");
		});

		it("does NOT redact public key block", () => {
			const pem = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA
-----END PUBLIC KEY-----`;
			const { scrubbed, redactionCount } = scrubSecrets(pem);
			expect(scrubbed).toBe(pem);
			expect(redactionCount).toBe(0);
		});

		it("does NOT redact certificate block", () => {
			const cert = `-----BEGIN CERTIFICATE-----
MIIDdTCCAl2gAwIBAgIJAOi7KK
-----END CERTIFICATE-----`;
			const { scrubbed, redactionCount } = scrubSecrets(cert);
			expect(scrubbed).toBe(cert);
			expect(redactionCount).toBe(0);
		});
	});

	describe("OpenSSH private keys", () => {
		it("redacts OpenSSH private key block", () => {
			const key = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACDd1X+ILZvDDJ6x/VB5oTxqMR
-----END OPENSSH PRIVATE KEY-----`;
			const { scrubbed, redactionCount } = scrubSecrets(`key file:\n${key}`);
			expect(scrubbed).toBe("key file:\n<REDACTED:openssh_private_key>");
			expect(redactionCount).toBe(1);
		});
	});

	describe("false positive avoidance", () => {
		it("does not redact UUIDs", () => {
			const input = "id: 550e8400-e29b-41d4-a716-446655440000";
			const { scrubbed, redactionCount } = scrubSecrets(input);
			expect(scrubbed).toBe(input);
			expect(redactionCount).toBe(0);
		});

		it("does not redact SHA-256 hashes", () => {
			const input = "sha256: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
			const { scrubbed, redactionCount } = scrubSecrets(input);
			expect(scrubbed).toBe(input);
			expect(redactionCount).toBe(0);
		});

		it("does not redact generic base64 data", () => {
			const input = "data: SGVsbG8gV29ybGQhIFRoaXMgaXMgYSB0ZXN0Lg==";
			const { scrubbed, redactionCount } = scrubSecrets(input);
			expect(scrubbed).toBe(input);
			expect(redactionCount).toBe(0);
		});

		it("does not redact git commit hashes", () => {
			const input = "commit abc123def456789012345678901234567890abcd";
			const { scrubbed, redactionCount } = scrubSecrets(input);
			expect(scrubbed).toBe(input);
			expect(redactionCount).toBe(0);
		});

		it("does not redact normal PATH-like environment variables", () => {
			const input = "PATH=/usr/local/bin:/usr/bin:/bin\nHOME=/home/user\nTERM=xterm-256color";
			const { scrubbed, redactionCount } = scrubSecrets(input);
			expect(scrubbed).toBe(input);
			expect(redactionCount).toBe(0);
		});
	});

	describe("multiple secrets", () => {
		it("redacts multiple different secrets in one output", () => {
			const input = [
				`ANTHROPIC_API_KEY=sk-ant-api03-${"B".repeat(90)}`,
				"GITHUB_TOKEN=ghp_ABCDEFghijklmnop1234567890abcdefghij",
				"DATABASE_URL=https://admin:password@db.example.com/mydb",
			].join("\n");
			const { scrubbed, redactionCount } = scrubSecrets(input);
			expect(redactionCount).toBe(3);
			expect(scrubbed).toContain("<REDACTED:anthropic_key>");
			expect(scrubbed).toContain("<REDACTED:github_token>");
			expect(scrubbed).toContain("<REDACTED:url_credentials>");
		});

		it("redacts multiple instances of the same pattern", () => {
			const input = "key1=AKIAIOSFODNN7EXAMPLE key2=AKIAIOSFODNN7EXAMPLF";
			const { scrubbed, redactionCount } = scrubSecrets(input);
			expect(redactionCount).toBe(2);
			expect(scrubbed).toBe("key1=<REDACTED:aws_access_key> key2=<REDACTED:aws_access_key>");
		});
	});

	describe("extra patterns", () => {
		it("applies extra patterns after defaults", () => {
			const extra: SecretPattern[] = [{ name: "custom_secret", pattern: /CUSTOM_SECRET_[A-Z0-9]{10,}/g }];
			const input = "key=CUSTOM_SECRET_ABCDEF1234";
			const { scrubbed, redactionCount } = scrubSecrets(input, extra);
			expect(scrubbed).toBe("key=<REDACTED:custom_secret>");
			expect(redactionCount).toBe(1);
		});

		it("extra patterns do not interfere with defaults", () => {
			const extra: SecretPattern[] = [{ name: "custom", pattern: /CUSTOM_[A-Z]+/g }];
			const input = "ghp_ABCDEFghijklmnop1234567890abcdefghij";
			const { scrubbed } = scrubSecrets(input, extra);
			expect(scrubbed).toBe("<REDACTED:github_token>");
		});
	});

	describe("idempotency", () => {
		it("calling scrubSecrets twice produces the same result", () => {
			const input = "key=AKIAIOSFODNN7EXAMPLE and token=ghp_ABCDEFghijklmnop1234567890abcdefghij";
			const first = scrubSecrets(input);
			const second = scrubSecrets(first.scrubbed);
			expect(second.scrubbed).toBe(first.scrubbed);
			expect(second.redactionCount).toBe(0);
		});
	});

	describe("empty and edge inputs", () => {
		it("handles empty string", () => {
			const { scrubbed, redactionCount } = scrubSecrets("");
			expect(scrubbed).toBe("");
			expect(redactionCount).toBe(0);
		});

		it("handles text with no secrets", () => {
			const input = "Just a normal log line with no secrets.";
			const { scrubbed, redactionCount } = scrubSecrets(input);
			expect(scrubbed).toBe(input);
			expect(redactionCount).toBe(0);
		});
	});
});

// ============================================================================
// Layer 2: Sensitive File Access Guard (sensitive-paths.ts)
// ============================================================================

describe("isSensitivePath", () => {
	const home = homedir();

	describe("pattern registry", () => {
		it("exports DEFAULT_SENSITIVE_PATTERNS with expected entries", () => {
			expect(DEFAULT_SENSITIVE_PATTERNS).toContain("~/.ssh/id_*");
			expect(DEFAULT_SENSITIVE_PATTERNS).toContain("~/.gnupg/private-keys-v1.d/*");
			expect(DEFAULT_SENSITIVE_PATTERNS).toContain("~/.dreb/secrets/*");
			expect(DEFAULT_SENSITIVE_PATTERNS).toContain("~/.dreb/agent/auth.json");
			expect(DEFAULT_SENSITIVE_PATTERNS).toContain("~/.aws/credentials");
			expect(DEFAULT_SENSITIVE_PATTERNS).toContain("~/.config/gcloud/credentials.db");
		});
	});

	describe("SSH private keys", () => {
		it("blocks ~/.ssh/id_rsa", () => {
			const result = isSensitivePath("~/.ssh/id_rsa");
			expect(result.blocked).toBe(true);
			expect(result.pattern).toBe("~/.ssh/id_*");
		});

		it("blocks ~/.ssh/id_ed25519", () => {
			expect(isSensitivePath("~/.ssh/id_ed25519").blocked).toBe(true);
		});

		it("blocks ~/.ssh/id_ecdsa", () => {
			expect(isSensitivePath("~/.ssh/id_ecdsa").blocked).toBe(true);
		});

		it("blocks ~/.ssh/id_dsa", () => {
			expect(isSensitivePath("~/.ssh/id_dsa").blocked).toBe(true);
		});

		it("allows ~/.ssh/id_rsa.pub", () => {
			expect(isSensitivePath("~/.ssh/id_rsa.pub").blocked).toBe(false);
		});

		it("allows ~/.ssh/id_ed25519.pub", () => {
			expect(isSensitivePath("~/.ssh/id_ed25519.pub").blocked).toBe(false);
		});

		it("allows ~/.ssh/known_hosts", () => {
			expect(isSensitivePath("~/.ssh/known_hosts").blocked).toBe(false);
		});

		it("allows ~/.ssh/config", () => {
			expect(isSensitivePath("~/.ssh/config").blocked).toBe(false);
		});

		it("allows ~/.ssh/authorized_keys", () => {
			expect(isSensitivePath("~/.ssh/authorized_keys").blocked).toBe(false);
		});

		it("blocks absolute path to SSH private key", () => {
			expect(isSensitivePath(`${home}/.ssh/id_rsa`).blocked).toBe(true);
		});

		it("allows absolute path to SSH public key", () => {
			expect(isSensitivePath(`${home}/.ssh/id_rsa.pub`).blocked).toBe(false);
		});
	});

	describe("dreb secrets", () => {
		it("blocks ~/.dreb/secrets/providers.env", () => {
			const result = isSensitivePath("~/.dreb/secrets/providers.env");
			expect(result.blocked).toBe(true);
			expect(result.pattern).toBe("~/.dreb/secrets/*");
		});

		it("blocks ~/.dreb/secrets/any-file", () => {
			expect(isSensitivePath("~/.dreb/secrets/any-file").blocked).toBe(true);
		});

		it("blocks ~/.dreb/agent/auth.json", () => {
			const result = isSensitivePath("~/.dreb/agent/auth.json");
			expect(result.blocked).toBe(true);
			expect(result.pattern).toBe("~/.dreb/agent/auth.json");
		});

		it("allows ~/.dreb/memory/something.md", () => {
			expect(isSensitivePath("~/.dreb/memory/something.md").blocked).toBe(false);
		});

		it("allows ~/.dreb/agent/sessions/", () => {
			expect(isSensitivePath("~/.dreb/agent/sessions/abc.json").blocked).toBe(false);
		});
	});

	describe("AWS credentials", () => {
		it("blocks ~/.aws/credentials", () => {
			const result = isSensitivePath("~/.aws/credentials");
			expect(result.blocked).toBe(true);
			expect(result.pattern).toBe("~/.aws/credentials");
		});

		it("allows ~/.aws/config", () => {
			expect(isSensitivePath("~/.aws/config").blocked).toBe(false);
		});
	});

	describe("GPG private keys", () => {
		it("blocks ~/.gnupg/private-keys-v1.d/somefile", () => {
			const result = isSensitivePath("~/.gnupg/private-keys-v1.d/somefile");
			expect(result.blocked).toBe(true);
			expect(result.pattern).toBe("~/.gnupg/private-keys-v1.d/*");
		});

		it("allows ~/.gnupg/pubring.kbx", () => {
			expect(isSensitivePath("~/.gnupg/pubring.kbx").blocked).toBe(false);
		});
	});

	describe("Google Cloud credentials", () => {
		it("blocks ~/.config/gcloud/credentials.db", () => {
			const result = isSensitivePath("~/.config/gcloud/credentials.db");
			expect(result.blocked).toBe(true);
			expect(result.pattern).toBe("~/.config/gcloud/credentials.db");
		});

		it("allows ~/.config/gcloud/properties", () => {
			expect(isSensitivePath("~/.config/gcloud/properties").blocked).toBe(false);
		});
	});

	describe("safe paths", () => {
		it("allows /tmp/safe-file", () => {
			expect(isSensitivePath("/tmp/safe-file").blocked).toBe(false);
		});

		it("allows regular project files", () => {
			expect(isSensitivePath("./src/index.ts").blocked).toBe(false);
		});

		it("allows /etc/hosts", () => {
			expect(isSensitivePath("/etc/hosts").blocked).toBe(false);
		});
	});

	describe("path traversal prevention", () => {
		it("blocks traversal to SSH key via ..", () => {
			// From a typical cwd, ../../.ssh/id_rsa should resolve to home
			const traversal = `${home}/projects/myapp/../../.ssh/id_rsa`;
			expect(isSensitivePath(traversal).blocked).toBe(true);
		});

		it("blocks absolute path with .. that resolves to sensitive file", () => {
			expect(isSensitivePath(`${home}/.ssh/../.ssh/id_ed25519`).blocked).toBe(true);
		});
	});

	describe("extra patterns", () => {
		it("blocks paths matching extra exact patterns", () => {
			const result = isSensitivePath("~/.config/hub", ["~/.config/hub"]);
			expect(result.blocked).toBe(true);
			expect(result.pattern).toBe("~/.config/hub");
		});

		it("blocks paths matching extra prefix patterns", () => {
			const result = isSensitivePath("~/.vault/token", ["~/.vault/*"]);
			expect(result.blocked).toBe(true);
		});

		it("does not block non-matching extra patterns", () => {
			expect(isSensitivePath("/tmp/file", ["~/.vault/*"]).blocked).toBe(false);
		});

		it("extra patterns do not override default allowlists", () => {
			// .pub files are still allowed even with extra patterns
			expect(isSensitivePath("~/.ssh/id_rsa.pub", ["~/.extra/*"]).blocked).toBe(false);
		});

		it("warns and skips mid-path wildcard patterns", () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const result = isSensitivePath("~/vaults/myteam/key.pem", ["~/vaults/*/key.pem"]);
			expect(result.blocked).toBe(false);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("Skipping unsupported mid-path wildcard pattern"),
			);
			warnSpy.mockRestore();
		});

		it("does not warn for trailing wildcard patterns", () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			isSensitivePath("~/.vault/token", ["~/.vault/*"]);
			expect(warnSpy).not.toHaveBeenCalled();
			warnSpy.mockRestore();
		});
	});
});

// ============================================================================
// Empty/Invalid Pattern Guards (agent-session.ts wiring validation)
// ============================================================================

describe("empty-string regex behavior", () => {
	it("empty-string regex pattern mangles output (documents why caller must guard)", () => {
		// An empty-string regex matches every zero-width position between characters.
		// This is why agent-session.ts guards against empty patterns before calling scrubSecrets.
		const emptyPattern: SecretPattern[] = [{ name: "bad", pattern: /(?:)/g }];
		const input = "hello";
		const { scrubbed, redactionCount } = scrubSecrets(input, emptyPattern);
		// Inserts <REDACTED:bad> between every character + at start/end
		expect(redactionCount).toBe(6); // h-e-l-l-o = 5 chars, 6 zero-width positions
		expect(scrubbed).toContain("<REDACTED:bad>");
		expect(scrubbed.length).toBeGreaterThan(input.length * 5);
	});
});
