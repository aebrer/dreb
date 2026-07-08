import { existsSync, type FSWatcher, watch } from "node:fs";
import { dirname, join } from "node:path";
import { DailyCostTracker } from "./daily-cost-tracker.js";
import { findGitPaths, type GitPaths, getGitBranch, getGitBranchAsync } from "./git-branch.js";

/**
 * Provides git branch and extension statuses - data not otherwise accessible to extensions.
 * Token stats, model info available via ctx.sessionManager and ctx.model.
 */
export class FooterDataProvider {
	private static readonly WATCH_DEBOUNCE_MS = 500;

	private extensionStatuses = new Map<string, string>();
	private cachedBranch: string | null | undefined = undefined;
	private gitPaths: GitPaths | null | undefined = undefined;
	private headWatcher: FSWatcher | null = null;
	private reftableWatcher: FSWatcher | null = null;
	private branchChangeCallbacks = new Set<() => void>();
	private dailyCostTracker: DailyCostTracker;
	private availableProviderCount = 0;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private refreshInFlight = false;
	private refreshPending = false;
	private disposed = false;

	constructor() {
		this.gitPaths = findGitPaths();
		this.setupGitWatcher();
		this.dailyCostTracker = new DailyCostTracker();
	}

	/** Current git branch, null if not in repo, "detached" if detached HEAD */
	getGitBranch(): string | null {
		if (this.cachedBranch === undefined) {
			this.cachedBranch = this.resolveGitBranchSync();
		}
		return this.cachedBranch;
	}

	/** Extension status texts set via ctx.ui.setStatus() */
	getExtensionStatuses(): ReadonlyMap<string, string> {
		return this.extensionStatuses;
	}

	/** Subscribe to git branch changes. Returns unsubscribe function. */
	onBranchChange(callback: () => void): () => void {
		this.branchChangeCallbacks.add(callback);
		return () => this.branchChangeCallbacks.delete(callback);
	}

	/** Internal: set extension status */
	setExtensionStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.extensionStatuses.delete(key);
		} else {
			this.extensionStatuses.set(key, text);
		}
	}

	/** Internal: clear extension statuses */
	clearExtensionStatuses(): void {
		this.extensionStatuses.clear();
	}

	/** Cached daily cost total across all sessions. O(1). */
	getDailyCost(): number {
		return this.dailyCostTracker.getDailyCost();
	}

	/** Force refresh of the daily cost cache. */
	async refreshDailyCost(): Promise<void> {
		await this.dailyCostTracker.refresh();
	}

	/** Number of unique providers with available models (for footer display) */
	getAvailableProviderCount(): number {
		return this.availableProviderCount;
	}

	/** Internal: update available provider count */
	setAvailableProviderCount(count: number): void {
		this.availableProviderCount = count;
	}

	/** Internal: cleanup */
	dispose(): void {
		this.disposed = true;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.dailyCostTracker.dispose();
		if (this.headWatcher) {
			this.headWatcher.close();
			this.headWatcher = null;
		}
		if (this.reftableWatcher) {
			this.reftableWatcher.close();
			this.reftableWatcher = null;
		}
		this.branchChangeCallbacks.clear();
	}

	private notifyBranchChange(): void {
		for (const cb of this.branchChangeCallbacks) cb();
	}

	private scheduleRefresh(): void {
		if (this.disposed) return;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null;
			void this.refreshGitBranchAsync();
		}, FooterDataProvider.WATCH_DEBOUNCE_MS);
	}

	private async refreshGitBranchAsync(): Promise<void> {
		if (this.disposed) return;
		if (this.refreshInFlight) {
			this.refreshPending = true;
			return;
		}

		this.refreshInFlight = true;
		try {
			const nextBranch = await this.resolveGitBranchAsync();
			if (this.disposed) return;
			if (this.cachedBranch !== undefined && this.cachedBranch !== nextBranch) {
				this.cachedBranch = nextBranch;
				this.notifyBranchChange();
				return;
			}
			this.cachedBranch = nextBranch;
		} finally {
			this.refreshInFlight = false;
			if (this.refreshPending && !this.disposed) {
				this.refreshPending = false;
				this.scheduleRefresh();
			}
		}
	}

	private resolveGitBranchSync(): string | null {
		return getGitBranch();
	}

	private async resolveGitBranchAsync(): Promise<string | null> {
		return getGitBranchAsync();
	}

	private setupGitWatcher(): void {
		if (!this.gitPaths) return;

		// Watch the directory containing HEAD, not HEAD itself.
		// Git uses atomic writes (write temp, rename over HEAD), which changes the inode.
		// fs.watch on a file stops working after the inode changes.
		try {
			this.headWatcher = watch(dirname(this.gitPaths.headPath), (_eventType, filename) => {
				if (!filename || filename.toString() === "HEAD") {
					this.scheduleRefresh();
				}
			});
		} catch {
			// Silently fail if we can't watch
		}

		// In reftable repos, branch switches update files in the reftable directory
		// instead of HEAD. Watch it separately so the footer picks up those changes.
		const reftableDir = join(this.gitPaths.commonGitDir, "reftable");
		if (existsSync(reftableDir)) {
			try {
				this.reftableWatcher = watch(reftableDir, () => {
					this.scheduleRefresh();
				});
			} catch {
				// Silently fail if we can't watch
			}
		}
	}
}

/** Read-only view for extensions - excludes setExtensionStatus, setAvailableProviderCount and dispose */
export type ReadonlyFooterDataProvider = Pick<
	FooterDataProvider,
	"getGitBranch" | "getExtensionStatuses" | "getAvailableProviderCount" | "onBranchChange" | "getDailyCost"
>;
