import { createSignal, type JSX, onCleanup, Show } from "solid-js";
import type { FleetDto, RuntimeDirectorySelection } from "../../shared/protocol.js";
import { runtimeDirectoryReady } from "../state/runtime-directory.js";
import { Modal } from "./common.js";
import { ProjectDirectorySelector } from "./project-directory-selector.js";

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
	onResume: (directory: string | RuntimeDirectorySelection) => Promise<void>;
	onClose: () => void;
}): JSX.Element {
	const [directory, setDirectory] = createSignal<RuntimeDirectorySelection>({
		kind: "local",
		cwd: props.initialCwd ?? "",
	});
	const [error, setError] = createSignal<string>();
	const [busy, setBusy] = createSignal(false);
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});

	async function resume(): Promise<void> {
		if (disposed || busy() || !runtimeDirectoryReady(directory())) return;
		setBusy(true);
		setError(undefined);
		try {
			const selected = directory();
			await props.onResume(selected.kind === "local" ? selected.cwd : selected);
		} catch (err) {
			if (!disposed) {
				setError(err instanceof Error ? err.message : String(err));
				setBusy(false);
			}
		}
	}

	return (
		<Modal
			title="choose runtime directory"
			manageFocus
			dismissDisabled={busy()}
			onDismiss={() => {
				if (!busy()) props.onClose();
			}}
			class="resume-session-modal"
			actions={
				<>
					<button
						type="button"
						class="btn btn-small"
						disabled={busy()}
						onClick={() => {
							if (!busy()) props.onClose();
						}}
					>
						cancel
					</button>
					<button
						type="button"
						class="btn btn-small btn-primary"
						disabled={busy() || !runtimeDirectoryReady(directory())}
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
			<ProjectDirectorySelector
				idPrefix="resume-runtime"
				selection={directory()}
				onChange={setDirectory}
				recentProjects={props.recentProjects}
				disabled={busy()}
				localLabel="runtime project path"
			/>
			<p class="muted small">Tools and project context will use this directory. Session history stays unchanged.</p>
			<Show when={error()}>
				<p class="pair-error" role="alert">
					{error()}
				</p>
			</Show>
		</Modal>
	);
}
