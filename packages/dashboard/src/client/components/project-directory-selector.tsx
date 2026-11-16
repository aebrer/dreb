import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import type { CloudProjectDto, RuntimeDirectorySelection } from "../../shared/protocol.js";
import { api } from "../api.js";
import "../styles/project-directory-selector.css";

function projectPath(project: CloudProjectDto): string {
	if (project.status.available) return project.status.path;
	return project.location.kind === "local"
		? project.location.path
		: `${project.location.workspaceId}/${project.location.relativePath}`;
}

function projectLabel(project: CloudProjectDto): string {
	return `${project.id} — ${projectPath(project)} — ${project.status.available ? "available" : "unavailable"}`;
}

/** Explicit directory choice; only a project identity, never its displayed path, is launch authority. */
export function ProjectDirectorySelector(props: {
	idPrefix: string;
	selection: RuntimeDirectorySelection;
	onChange: (selection: RuntimeDirectorySelection) => void;
	recentProjects: string[];
	disabled?: boolean;
	localLabel: string;
}): JSX.Element {
	let lastLocalCwd = props.selection.kind === "local" ? props.selection.cwd : "";
	let generation = 0;
	let disposed = false;
	const [projects, setProjects] = createSignal<CloudProjectDto[]>([]);
	const [loaded, setLoaded] = createSignal(false);
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal<string>();
	const [selectionNotice, setSelectionNotice] = createSignal<string>();
	const linked = () => props.selection.kind === "project";
	const selectedId = () => (props.selection.kind === "project" ? props.selection.projectId : "");
	const selectedProject = createMemo(() => projects().find((project) => project.id === selectedId()));

	function invalidate(): void {
		generation++;
		setLoading(false);
	}

	createEffect(() => {
		const selection = props.selection;
		if (selection.kind === "local") {
			lastLocalCwd = selection.cwd;
			invalidate();
		}
	});
	onCleanup(() => {
		disposed = true;
		generation++;
	});

	async function load(): Promise<void> {
		if (disposed || props.disabled || !linked() || loading()) return;
		const requestGeneration = ++generation;
		setLoading(true);
		setError(undefined);
		try {
			const result = await api.cloudWorkspaces();
			if (disposed || requestGeneration !== generation || !linked()) return;
			const next = [...result.projects].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
			const id = selectedId();
			const selected = next.find((project) => project.id === id);
			if (id && (!selected || !selected.status.available)) {
				setSelectionNotice(
					selected && !selected.status.available
						? `Selection cleared: linked project ${id} is unavailable (${selected.status.error.code}: ${selected.status.error.message}). Choose a project explicitly after resolving the problem.`
						: `Selection cleared: linked project ${id} is no longer registered. Choose a project explicitly; no replacement was selected.`,
				);
				props.onChange({ kind: "project", projectId: "" });
			}
			setProjects(next);
			setLoaded(true);
		} catch (err) {
			if (disposed || requestGeneration !== generation || !linked()) return;
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (!disposed && requestGeneration === generation && linked()) setLoading(false);
		}
	}

	function changeSource(value: string): void {
		if (disposed || props.disabled || value === props.selection.kind) return;
		if (value === "local") {
			invalidate();
			props.onChange({ kind: "local", cwd: lastLocalCwd });
		} else if (value === "project") {
			if (props.selection.kind === "local") lastLocalCwd = props.selection.cwd;
			invalidate();
			setProjects([]);
			setLoaded(false);
			setError(undefined);
			setSelectionNotice(undefined);
			props.onChange({ kind: "project", projectId: "" });
			void load();
		}
	}

	function changeLocal(cwd: string): void {
		if (disposed || props.disabled || linked()) return;
		lastLocalCwd = cwd;
		props.onChange({ kind: "local", cwd });
	}

	function changeProject(projectId: string): void {
		if (disposed || props.disabled || !linked() || loading()) return;
		if (projectId && !projects().some((project) => project.id === projectId && project.status.available)) return;
		setSelectionNotice(undefined);
		props.onChange({ kind: "project", projectId });
	}

	return (
		<fieldset class="project-directory-selector" disabled={props.disabled}>
			<legend class="project-directory-legend">project directory</legend>
			<div class="field">
				<label for={`${props.idPrefix}-source`}>directory source</label>
				<select
					id={`${props.idPrefix}-source`}
					value={props.selection.kind}
					onChange={(event) => changeSource(event.currentTarget.value)}
				>
					<option value="local">local directory</option>
					<option value="project">linked project</option>
				</select>
			</div>
			<Show
				when={linked()}
				fallback={
					<>
						<div class="field">
							<label for={`${props.idPrefix}-cwd`}>{props.localLabel}</label>
							<input
								id={`${props.idPrefix}-cwd`}
								type="text"
								value={props.selection.kind === "local" ? props.selection.cwd : ""}
								placeholder="/path/to/project"
								onInput={(event) => changeLocal(event.currentTarget.value)}
							/>
						</div>
						<Show when={props.recentProjects.length > 0}>
							<fieldset class="project-directory-recents">
								<legend class="field-label">recent projects</legend>
								<div class="recent-projects">
									<For each={props.recentProjects}>
										{(path) => (
											<button type="button" onClick={() => changeLocal(path)}>
												{path}
											</button>
										)}
									</For>
								</div>
							</fieldset>
						</Show>
					</>
				}
			>
				<div class="field">
					<label for={`${props.idPrefix}-project`}>linked project</label>
					<select
						id={`${props.idPrefix}-project`}
						value={selectedId()}
						disabled={loading()}
						aria-describedby={`${props.idPrefix}-project-status`}
						onChange={(event) => changeProject(event.currentTarget.value)}
					>
						<option value="">choose linked project</option>
						<For each={projects()}>
							{(project) => (
								<option value={project.id} disabled={!project.status.available}>
									{projectLabel(project)}
								</option>
							)}
						</For>
					</select>
				</div>
				<div id={`${props.idPrefix}-project-status`} aria-live="polite" aria-busy={loading()}>
					<Show when={loading()}>
						<p class="muted small">Loading linked projects…</p>
					</Show>
					<Show when={error()}>
						<p class="pair-error" role="alert">
							Could not load linked projects: {error()}.{" "}
							{loaded()
								? "Last-known choices are stale; availability must be revalidated at launch."
								: "No registry result is available. Retry to load choices."}
						</p>
					</Show>
					<Show when={loaded() && !loading() && !error() && projects().length === 0}>
						<p class="muted small">
							No linked projects are registered on this host. Manage cloud workspaces to link one, or use a local
							directory.
						</p>
					</Show>
					<Show when={selectedId()}>
						<p class="project-directory-identity">
							Selected project: <code>{selectedId()}</code>
							<br />
							Host path: <code>{selectedProject() ? projectPath(selectedProject()!) : "not yet loaded"}</code>
						</p>
					</Show>
					<Show when={selectionNotice()}>
						<p class="pair-error" role="alert">
							{selectionNotice()}
						</p>
					</Show>
					<For each={projects().filter((project) => !project.status.available)}>
						{(project) => (
							<p class="pair-error" role="alert">
								{projectLabel(project)}:{" "}
								{!project.status.available && `${project.status.error.code}: ${project.status.error.message}`}
							</p>
						)}
					</For>
				</div>
				<div class="project-directory-actions">
					<button type="button" class="btn btn-small" disabled={loading()} onClick={() => void load()}>
						{error() ? "retry linked projects" : "refresh linked projects"}
					</button>
					<a
						href={props.disabled ? undefined : "#/settings/cloud-workspaces"}
						aria-disabled={props.disabled ? "true" : undefined}
						tabIndex={props.disabled ? -1 : undefined}
						onClick={(event) => {
							if (disposed || props.disabled) event.preventDefault();
						}}
					>
						manage cloud workspaces
					</a>
				</div>
				<p class="muted small">
					Availability status is not synchronization or proof of code equivalence. The server revalidates the
					selected project ID at launch.
				</p>
			</Show>
			<p class="muted small">
				Start/Resume runs normal project settings, context and extensions in the chosen directory. This directory
				choice does not persist a project association or move transcripts.
			</p>
		</fieldset>
	);
}
