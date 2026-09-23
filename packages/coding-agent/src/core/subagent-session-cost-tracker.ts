import { sumCostFromFile } from "./daily-cost-tracker.js";
import { discoverSessionFiles, getBackgroundAgents } from "./tools/subagent.js";

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
	 * Compute total cost from all background agents.
	 * For chain agents with multiple step-N/ directories, discovers and sums
	 * all step files (not just the newest one) via `discoverSessionFiles`.
	 * Falls back to the single `sessionFile` when `sessionDir` is unavailable.
	 */
	private static async computeCost(): Promise<number> {
		try {
			const agents = getBackgroundAgents();
			const filePaths: string[] = [];

			for (const agent of agents) {
				if (agent.sessionDir) {
					// Discover all session files including chain step-N/ subdirectories
					const files = discoverSessionFiles(agent.sessionDir, agent.agentType);
					filePaths.push(...files);
				} else if (agent.sessionFile) {
					// Fallback: single file when sessionDir is unavailable
					filePaths.push(agent.sessionFile);
				}
			}

			if (filePaths.length === 0) return 0;

			const costs = await Promise.all(filePaths.map((f) => sumCostFromFile(f)));
			return costs.reduce((sum, c) => sum + c, 0);
		} catch {
			// Never crash the app
			return 0;
		}
	}
}
