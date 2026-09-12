import { createSignal, For, type JSX, Show } from "solid-js";
import type { FleetDto } from "../../shared/protocol.js";
import { Modal } from "./common.js";

function shortenPath(path: string): string {
	return path.replace(/^\/home\/[^/]+/, "~");
}

/** Valid canonical project roots that are safe to offer for runtime creation. */
export function runtimeProjectChoices(fleet: FleetDto): string[] {
	const paths = new Set<string>();
	for (const runtime of fleet.runtimes) paths.add(runtime.cwd);
	for (const session of fleet.diskSessions) {
		if (session.resolvedCwd) paths.add(session.resolvedCwd);
	}
	return [...paths].slice(0, 8);
}

export function ResumeSessionModal(props: {
	historicalCwd: string;
	historicalUnavailable?: boolean;
	initialCwd?: string;
	recentProjects: string[];
	onResume: (cwd: string) => Promise<void>;
	onClose: () => void;
}): JSX.Element {
	const [cwd, setCwd] = createSignal(props.initialCwd ?? "");
	const [error, setError] = createSignal<string>();
	const [busy, setBusy] = createSignal(false);

	async function resume(): Promise<void> {
		if (busy() || !cwd().trim()) return;
		setBusy(true);
		setError(undefined);
		try {
			await props.onResume(cwd());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Modal
			title="choose runtime directory"
			onDismiss={props.onClose}
			class="resume-session-modal"
			actions={
				<>
					<button type="button" class="btn btn-small" disabled={busy()} onClick={props.onClose}>
						cancel
					</button>
					<button
						type="button"
						class="btn btn-small btn-primary"
						disabled={busy() || !cwd().trim()}
						onClick={() => void resume()}
					>
						{busy() ? "resuming…" : "resume session"}
					</button>
				</>
			}
		>
			<p class="resume-cwd-warning">
				{props.historicalUnavailable
					? "The original working directory is unavailable on this host."
					: "Choose the existing project directory this resumed runtime should use."}
			</p>
			<div class="field">
				<span class="field-label">historical session path</span>
				<code class="resume-historical-cwd">{props.historicalCwd || "(not recorded)"}</code>
			</div>
			<div class="field">
				<label for="resume-runtime-cwd">runtime project path</label>
				<input
					id="resume-runtime-cwd"
					type="text"
					value={cwd()}
					placeholder="/path/to/project"
					disabled={busy()}
					onInput={(event) => setCwd(event.currentTarget.value)}
				/>
				<p class="muted small">
					Tools and project context will use this directory. Session history stays unchanged.
				</p>
			</div>
			<Show when={props.recentProjects.length > 0}>
				<div class="field">
					<label for="resume-recent-projects">available projects</label>
					<div class="recent-projects" id="resume-recent-projects">
						<For each={props.recentProjects}>
							{(project) => (
								<button type="button" disabled={busy()} onClick={() => setCwd(project)}>
									{shortenPath(project)}
								</button>
							)}
						</For>
					</div>
				</div>
			</Show>
			<Show when={error()}>
				<p class="pair-error" role="alert">
					{error()}
				</p>
			</Show>
		</Modal>
	);
}
