import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { CloudAvailabilityDto, CloudWorkspacesDto } from "../../shared/protocol.js";
import { api } from "../api.js";
import { Topbar } from "../components/common.js";
import type { AppStore } from "../state/store.js";
import "../styles/cloud-workspaces.css";

type Target = { kind: "workspace" | "project"; id: string };

function errorMessage(error: unknown): string {
	const body = error && typeof error === "object" && "body" in error ? error.body : undefined;
	const code = body && typeof body === "object" && "code" in body ? String(body.code) : undefined;
	const message = error instanceof Error ? error.message : String(error);
	return `${code ? `${code}: ` : ""}${message}${
		code === "PARTIAL_INITIALIZATION"
			? " A marker may already have been written. Keep the same identity; retry the same operation as directed, or connect/link the existing marker. Do not initialize a replacement identity."
			: ""
	}`;
}

function Availability(props: { status: CloudAvailabilityDto }) {
	const text = () => {
		const status = props.status;
		return status.available
			? `Available — canonical host path: ${status.path}`
			: `Unavailable — ${status.error.code}: ${status.error.message}`;
	};
	return <p class="cloud-availability">{text()}</p>;
}

/** Independent metadata management; normal Dashboard shell behavior is unchanged. */
export function CloudWorkspacesScreen(props: { store: AppStore }) {
	const [snapshot, setSnapshot] = createSignal<CloudWorkspacesDto>();
	const [loading, setLoading] = createSignal(true);
	const [loadError, setLoadError] = createSignal("");
	const [writeError, setWriteError] = createSignal("");
	const [notice, setNotice] = createSignal("");
	const [pending, setPending] = createSignal(false);
	const [workspacePath, setWorkspacePath] = createSignal("");
	const [workspaceMode, setWorkspaceMode] = createSignal("existing");
	const [projectPath, setProjectPath] = createSignal("");
	const [projectMode, setProjectMode] = createSignal("existing");
	const [projectId, setProjectId] = createSignal("");
	const [workspaceBinding, setWorkspaceBinding] = createSignal("");
	const [editor, setEditor] = createSignal<Target>();
	const [editPath, setEditPath] = createSignal("");
	const [editBinding, setEditBinding] = createSignal("");
	const [removal, setRemoval] = createSignal<Target>();
	let disposed = false;
	let loadGeneration = 0;
	let mutationGeneration = 0;
	const workspaces = createMemo(() => [...(snapshot()?.workspaces ?? [])].sort((a, b) => a.id.localeCompare(b.id)));
	const projects = createMemo(() => [...(snapshot()?.projects ?? [])].sort((a, b) => a.id.localeCompare(b.id)));
	const placeholder = () => (snapshot()?.pathStyle === "windows" ? "C:\\Users\\you\\Projects" : "/home/you/projects");

	onCleanup(() => {
		disposed = true;
		loadGeneration += 1;
		mutationGeneration += 1;
	});

	async function load() {
		const generation = ++loadGeneration;
		setLoading(true);
		setLoadError("");
		try {
			const data = await api.cloudWorkspaces();
			if (disposed || generation !== loadGeneration) return;
			setSnapshot(data);
		} catch (error) {
			if (disposed || generation !== loadGeneration) return;
			setLoadError(errorMessage(error));
		} finally {
			if (!disposed && generation === loadGeneration) setLoading(false);
		}
	}
	onMount(() => void load());

	async function mutate(action: () => Promise<unknown>, success: string, onSuccess?: () => void) {
		// This guard is set synchronously, before invoking the API or awaiting anything.
		if (disposed || pending()) return;
		setPending(true);
		const generation = ++mutationGeneration;
		loadGeneration += 1;
		setLoading(false);
		setWriteError("");
		setNotice("");
		try {
			await action();
		} catch (error) {
			if (!disposed && generation === mutationGeneration) {
				setWriteError(errorMessage(error));
				setPending(false);
			}
			return;
		}
		if (disposed || generation !== mutationGeneration) return;
		setNotice(success);
		onSuccess?.();
		// A reload failure is separate from a successful durable mutation. Never retry the write.
		await load();
		if (!disposed && generation === mutationGeneration) setPending(false);
	}

	function beginEdit(target: Target, path: string, binding = "") {
		if (pending()) return;
		setRemoval(undefined);
		setEditor(target);
		setEditPath(path);
		setEditBinding(binding);
	}

	function BindingSelect(selectProps: { value: string; onChange: (value: string) => void }) {
		return (
			<label>
				Project binding
				<select value={selectProps.value} onChange={(event) => selectProps.onChange(event.currentTarget.value)}>
					<option value="">Direct local (outside a workspace is allowed)</option>
					<For each={workspaces()}>
						{(workspace) => <option value={workspace.id}>Workspace-relative — {workspace.id}</option>}
					</For>
					<Show when={selectProps.value && !workspaces().some((workspace) => workspace.id === selectProps.value)}>
						<option value={selectProps.value}>Disconnected workspace — {selectProps.value}</option>
					</Show>
				</select>
			</label>
		);
	}

	function RowActions(row: Target & { path: string; binding?: string }) {
		const currentPath = createMemo(() => row.path);
		const currentBinding = createMemo(() => row.binding);
		const isEditing = () => editor()?.kind === row.kind && editor()?.id === row.id;
		const isRemoving = () => removal()?.kind === row.kind && removal()?.id === row.id;
		return (
			<div class="cloud-row-actions">
				<div class="cloud-actions">
					<button
						class="btn"
						type="button"
						disabled={pending()}
						onClick={() => beginEdit({ kind: row.kind, id: row.id }, currentPath(), currentBinding())}
					>
						Rebind {row.kind}
					</button>
					<button
						class="btn"
						type="button"
						disabled={pending()}
						onClick={() => {
							if (pending()) return;
							setEditor(undefined);
							setRemoval({ kind: row.kind, id: row.id });
						}}
					>
						{row.kind === "workspace" ? "Disconnect workspace" : "Unlink project"}
					</button>
				</div>
				<Show when={isEditing()}>
					<form
						aria-label={`Rebind ${row.id}`}
						onSubmit={(event) => {
							event.preventDefault();
							const target = editor();
							if (!target || pending()) return;
							const path = editPath();
							const binding = editBinding();
							void mutate(
								() =>
									target.kind === "workspace"
										? api.rebindWorkspace(target.id, path)
										: api.rebindProject(target.id, { path, ...(binding ? { workspaceId: binding } : {}) }),
								`Rebound ${target.id} successfully.`,
								() => setEditor(undefined),
							);
						}}
					>
						<fieldset disabled={pending()}>
							<legend>Rebind the same identity: {row.id}</legend>
							<p>No replacement identity is initialized. The target must match this full ID.</p>
							<label>
								New absolute host path
								<input
									required
									value={editPath()}
									placeholder={placeholder()}
									onInput={(event) => setEditPath(event.currentTarget.value)}
								/>
							</label>
							<Show when={row.kind === "project"}>
								<BindingSelect value={editBinding()} onChange={setEditBinding} />
							</Show>
							<div class="cloud-actions">
								<button class="btn" type="submit">
									Save rebind
								</button>
								<button class="btn" type="button" onClick={() => setEditor(undefined)}>
									Cancel rebind
								</button>
							</div>
						</fieldset>
					</form>
				</Show>
				<Show when={isRemoving()}>
					<fieldset disabled={pending()} class="cloud-confirmation">
						<legend>Confirm local-only removal</legend>
						<p>
							Remove the local mapping for <strong>{row.id}</strong>? This preserves the folder, marker, session
							bytes and cloud content.
						</p>
						<Show when={row.kind === "workspace"}>
							<p>
								Dependent project identities remain visible but unavailable until their workspace is connected
								again or they are rebound.
							</p>
						</Show>
						<div class="cloud-actions">
							<button
								class="btn"
								type="button"
								onClick={() => {
									const target = removal();
									if (!target || pending()) return;
									void mutate(
										() =>
											target.kind === "workspace"
												? api.disconnectWorkspace(target.id)
												: api.unlinkProject(target.id),
										`Removed local mapping ${target.id} successfully.`,
										() => setRemoval(undefined),
									);
								}}
							>
								Confirm {row.kind === "workspace" ? "disconnect" : "unlink"}
							</button>
							<button class="btn" type="button" onClick={() => setRemoval(undefined)}>
								Cancel removal
							</button>
						</div>
					</fieldset>
				</Show>
			</div>
		);
	}

	return (
		<>
			<Topbar store={props.store} active="settings" />
			<main class="container cloud-workspaces">
				<a href="#/settings">Back to Settings</a>
				<h1>Cloud Workspaces</h1>
				<p>
					Local workflows need no registration. This host is the computer running the backend, not your phone or
					browser.
				</p>
				<p>
					Connecting workspaces and linking projects manage metadata only: they do not synchronize code or
					sessions, grant trust, or make sessions portable. Available means reachable on this host, not
					synchronized.
				</p>
				<p>
					Initialize a first marker only once. On other hosts, connect or link the existing identity only after its
					marker arrives. A missing marker is not permission to initialize a replacement identity.
				</p>
				<div class="cloud-actions">
					<button
						class="btn"
						type="button"
						disabled={pending()}
						onClick={() => {
							if (!pending()) void load();
						}}
					>
						Refresh metadata
					</button>
					<Show when={pending()}>
						<output aria-live="polite">Saving metadata…</output>
					</Show>
				</div>
				<Show when={loading()}>
					<output aria-live="polite">
						{snapshot() ? "Refreshing metadata; showing last-good snapshot…" : "Loading metadata…"}
					</output>
				</Show>
				<Show when={loadError()}>
					<p role="alert" class="cloud-error">
						{snapshot() ? "Refresh failed. Last-good metadata is stale: " : "Could not load metadata: "}
						{loadError()}
					</p>
				</Show>
				<Show when={writeError()}>
					<p role="alert" class="cloud-error">
						Mutation failed: {writeError()} Entered values and last-good metadata have been retained.
					</p>
				</Show>
				<Show when={notice()}>
					<output aria-live="polite">{notice()}</output>
				</Show>
				<div class="cloud-forms">
					<form
						aria-label="Connect workspace"
						onSubmit={(event) => {
							event.preventDefault();
							const path = workspacePath();
							const initialize = workspaceMode() === "initialize";
							void mutate(
								() => api.connectWorkspace({ path, ...(initialize ? { initialize: true } : {}) }),
								"Workspace connected successfully.",
							);
						}}
					>
						<fieldset disabled={pending() || !snapshot()}>
							<legend>Connect workspace</legend>
							<label>
								Workspace absolute host path
								<input
									required
									value={workspacePath()}
									placeholder={placeholder()}
									onInput={(event) => setWorkspacePath(event.currentTarget.value)}
								/>
							</label>
							<label>
								Workspace identity mode
								<select
									value={workspaceMode()}
									onChange={(event) => setWorkspaceMode(event.currentTarget.value)}
								>
									<option value="existing">Existing identity (default)</option>
									<option value="initialize">Initialize first marker</option>
								</select>
							</label>
							<button class="btn" type="submit">
								Connect workspace
							</button>
						</fieldset>
					</form>
					<form
						aria-label="Link project"
						onSubmit={(event) => {
							event.preventDefault();
							const body = {
								path: projectPath(),
								...(projectMode() === "initialize" ? { initialize: true } : {}),
								...(projectMode() === "known" ? { projectId: projectId() } : {}),
								...(workspaceBinding() ? { workspaceId: workspaceBinding() } : {}),
							};
							void mutate(() => api.linkProject(body), "Project linked successfully.");
						}}
					>
						<fieldset disabled={pending() || !snapshot()}>
							<legend>Link project</legend>
							<label>
								Project absolute host path
								<input
									required
									value={projectPath()}
									placeholder={placeholder()}
									onInput={(event) => setProjectPath(event.currentTarget.value)}
								/>
							</label>
							<label>
								Project identity mode
								<select value={projectMode()} onChange={(event) => setProjectMode(event.currentTarget.value)}>
									<option value="existing">Existing marker (default)</option>
									<option value="initialize">Initialize first marker</option>
									<option value="known">Known full ID (markerless)</option>
								</select>
							</label>
							<Show when={projectMode() === "known"}>
								<label>
									Known full project ID
									<input
										required
										value={projectId()}
										onInput={(event) => setProjectId(event.currentTarget.value)}
									/>
								</label>
							</Show>
							<BindingSelect value={workspaceBinding()} onChange={setWorkspaceBinding} />
							<p>
								Enter an absolute host path in either mode. Workspace-relative binding records its relationship
								to the explicitly selected workspace; no folders are moved or discovered.
							</p>
							<button class="btn" type="submit">
								Link project
							</button>
						</fieldset>
					</form>
				</div>
				<Show when={snapshot()}>
					<Show when={workspaces().length === 0 && projects().length === 0}>
						<p>No registered workspaces or projects. Ordinary local sessions work without setup.</p>
					</Show>
					<section aria-label="Registered workspaces">
						<h2>Workspaces</h2>
						<Show when={workspaces().length === 0}>
							<p>No workspaces registered.</p>
						</Show>
						<For each={workspaces()}>
							{(workspace) => (
								<article class="cloud-row" aria-label={`Workspace ${workspace.id}`}>
									<h3>{workspace.id}</h3>
									<p>Configured host path: {workspace.path}</p>
									<Availability status={workspace.status} />
									<RowActions kind="workspace" id={workspace.id} path={workspace.path} />
								</article>
							)}
						</For>
					</section>
					<section aria-label="Registered projects">
						<h2>Projects</h2>
						<Show when={projects().length === 0}>
							<p>No projects registered.</p>
						</Show>
						<For each={projects()}>
							{(project) => (
								<article class="cloud-row" aria-label={`Project ${project.id}`}>
									<h3>{project.id}</h3>
									<p>
										{project.location.kind === "local"
											? `Configured local path: ${project.location.path}`
											: `Workspace ID: ${project.location.workspaceId} — relative path: ${project.location.relativePath}`}
									</p>
									<p>Marker required: {project.markerRequired ? "yes" : "no (known-ID markerless binding)"}</p>
									<Availability status={project.status} />
									<RowActions
										kind="project"
										id={project.id}
										path={
											project.status.available
												? project.status.path
												: project.location.kind === "local"
													? project.location.path
													: ""
										}
										binding={project.location.kind === "workspace" ? project.location.workspaceId : ""}
									/>
								</article>
							)}
						</For>
					</section>
				</Show>
			</main>
		</>
	);
}
