/**
 * Live provider API tests are opt-in. They make real, billed requests (API keys and
 * subscription OAuth logins from ~/.dreb/agent/auth.json), so plain `npm test` must never
 * run them.
 *
 * - `DREB_LIVE_API=1` enables live provider tests.
 * - `DREB_LIVE_API_EXPENSIVE=1` additionally enables very large requests (e.g. prompts sized
 *   past a model's full context window). It has no effect without `DREB_LIVE_API=1`.
 */
export function isLiveApiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.DREB_LIVE_API === "1";
}

export function isExpensiveLiveApiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return isLiveApiEnabled(env) && env.DREB_LIVE_API_EXPENSIVE === "1";
}
