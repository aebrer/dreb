import { sumCostFromFile } from "./daily-cost-tracker.js";
import { type BackgroundAgentInfo, getBackgroundAgents } from "./tools/subagent.js";

/**
 * Tracks the summed cost of all sub-agents spawned from the current parent session.
 * Uses `getBackgroundAgents()` which returns agents registered for the current process.
 * Caches the result and refreshes periodically (60s) for O(1) footer access.
 */
export class SubagentSessionCostTracker {
	private static readonly REFRESH_INTERVAL_MS = 60_000;

	private cachedCost = 0;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;

	constructor() {
		// Kick off initial async scan
		void this.initialRefresh();
	}

	/** Get cached sub-agent session cost. O(1). */
	getCost(): number {
		return this.cachedCost;
	}

	/** Force an async refresh of the sub-agent session cost. */
	async refresh(): Promise<void> {
		if (this.disposed) return;
		const cost = await SubagentSessionCostTracker.computeCost();
		if (!this.disposed) {
			this.cachedCost = cost;
		}
	}

	/** Clean up timer and prevent in-flight scans from updating cache. */
	dispose(): void {
		this.disposed = true;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	private async initialRefresh(): Promise<void> {
		const cost = await SubagentSessionCostTracker.computeCost();
		if (!this.disposed) {
			this.cachedCost = cost;
			this.scheduleNextRefresh();
		}
	}

	private scheduleNextRefresh(): void {
		if (this.disposed) return;
		this.refreshTimer = setTimeout(async () => {
			this.refreshTimer = null;
			if (this.disposed) return;
			const cost = await SubagentSessionCostTracker.computeCost();
			if (!this.disposed) {
				this.cachedCost = cost;
				this.scheduleNextRefresh();
			}
		}, SubagentSessionCostTracker.REFRESH_INTERVAL_MS);
		if (this.refreshTimer && typeof this.refreshTimer === "object" && "unref" in this.refreshTimer) {
			this.refreshTimer.unref();
		}
	}

	/**
	 * Compute total cost from all background agents that have a session file.
	 * Uses the exported `sumCostFromFile` which reads JSONL and sums assistant costs.
	 */
	private static async computeCost(): Promise<number> {
		try {
			const agents: readonly Readonly<BackgroundAgentInfo>[] = getBackgroundAgents();
			const agentsWithFiles = agents.filter(
				(a): a is Readonly<BackgroundAgentInfo> & { sessionFile: string } => typeof a.sessionFile === "string",
			);
			if (agentsWithFiles.length === 0) return 0;

			const costs = await Promise.all(agentsWithFiles.map((a) => sumCostFromFile(a.sessionFile)));
			return costs.reduce((sum, c) => sum + c, 0);
		} catch {
			// Never crash the app
			return 0;
		}
	}
}
