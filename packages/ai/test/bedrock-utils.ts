/**
 * Utility functions for Amazon Bedrock tests
 */

/**
 * Check if any valid AWS credentials are configured for Bedrock.
 * Returns true if any of the following are set:
 * - AWS_PROFILE (named profile from ~/.aws/credentials)
 * - AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (IAM keys)
 * - AWS_BEARER_TOKEN_BEDROCK (Bedrock API key)
 */
export function hasBedrockCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
	return !!(env.AWS_PROFILE || (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) || env.AWS_BEARER_TOKEN_BEDROCK);
}

/** Check whether the explicitly enabled extensive Bedrock suite may make live calls. */
export function shouldRunBedrockExtensiveTests(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.DREB_SKIP_LIVE_API !== "1" && !!env.BEDROCK_EXTENSIVE_MODEL_TEST && hasBedrockCredentials(env);
}
