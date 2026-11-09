import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type {
	CloudAvailabilityDto,
	CloudProjectDto,
	CloudSessionStorageDto,
	CloudWorkspacesDto,
} from "../../shared/protocol.js";
import { api } from "../api.js";
import { Topbar } from "../components/common.js";
import type { AppStore } from "../state/store.js";
import "../styles/cloud-workspaces.css";

type Target = { kind: "workspace" | "project"; id: string };
type StorageConfirmation = {
	root: string | null;
	expected: { sessionDir: string | null; subagentSessionDir: string | null };
	subdirectories: CloudSessionStorageDto["subdirectories"];
};

/** Display/join only straightforward native paths; the backend validates every binding. */
function joinedPath(root: string, relative: string, windows: boolean): string {
	const separator = windows ? "\\" : "/";
	const suffix = windows ? relative.replaceAll("/", "\\") : relative;
	if (suffix === "." || suffix === "") return root;
	return `${root.endsWith(separator) ? root : root + separator}${suffix}`;
}

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
	const [folderPath, setFolderPath] = createSignal("");
	const [setupPath, setSetupPath] = createSignal<string>();
	const [storage, setStorage] = createSignal<CloudSessionStorageDto>();
	const [storageLoading, setStorageLoading] = createSignal(true);
	const [storageError, setStorageError] = createSignal("");
	const [storageConfirmation, setStorageConfirmation] = createSignal<StorageConfirmation>();
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
	let storageLoadGeneration = 0;
	const workspaces = createMemo(() => [...(snapshot()?.workspaces ?? [])].sort((a, b) => a.id.localeCompare(b.id)));
	const projects = createMemo(() => [...(snapshot()?.projects ?? [])].sort((a, b) => a.id.localeCompare(b.id)));
	const placeholder = () => (snapshot()?.pathStyle === "windows" ? "C:\\Users\\you\\Projects" : "/home/you/projects");

	onCleanup(() => {
		disposed = true;
		loadGeneration += 1;
		mutationGeneration += 1;
		storageLoadGeneration += 1;
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
	async function loadStorage() {
		setStorageConfirmation(undefined);
		const generation = ++storageLoadGeneration;
		setStorageLoading(true);
		setStorageError("");
		try {
			const data = await api.cloudSessionStorage();
			if (disposed || generation !== storageLoadGeneration) return;
			setStorage(data);
		} catch (error) {
			if (disposed || generation !== storageLoadGeneration) return;
			setStorageError(errorMessage(error));
		} finally {
			if (!disposed && generation === storageLoadGeneration) setStorageLoading(false);
		}
	}
	onMount(() => {
		void load();
		void loadStorage();
	});

	async function mutate(
		action: () => Promise<unknown>,
		success: string,
		onSuccess?: () => void,
		onError?: (error: unknown) => boolean,
	) {
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
				if (!onError?.(error)) setWriteError(errorMessage(error));
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

	function configuredProjectPath(project: CloudProjectDto): string | undefined {
		if (project.location.kind === "local") return project.location.path;
		const location = project.location;
		const workspace = workspaces().find((candidate) => candidate.id === location.workspaceId);
		return workspace
			? joinedPath(workspace.path, location.relativePath, snapshot()?.pathStyle === "windows")
			: undefined;
	}

	function connectFolder() {
		if (disposed || pending() || !snapshot() || !folderPath()) return;
		const path = folderPath();
		setSetupPath(undefined);
		const known = projects().find(
			(project) =>
				configuredProjectPath(project) === path || (project.status.available && project.status.path === path),
		);
		void mutate(
			() =>
				api.linkProject({
					path,
					...(known ? { projectId: known.id } : {}),
					...(known?.location.kind === "workspace" ? { workspaceId: known.location.workspaceId } : {}),
				}),
			`Folder connected successfully: ${path}`,
			undefined,
			(error) => {
				const body = error && typeof error === "object" && "body" in error ? error.body : undefined;
				// Only an untargeted lookup's missing marker permits first-use setup.
				if (!known && body && typeof body === "object" && "code" in body && body.code === "NOT_FOUND") {
					if (folderPath() === path) setSetupPath(path);
					return true;
				}
				return false;
			},
		);
	}

	const storageReady = () => !!storage() && !storageLoading() && !storageError();
	function confirmStorage(root: string | null) {
		const current = storage();
		if (disposed || pending() || !storageReady() || !current || root === "") return;
		setStorageConfirmation({
			root,
			expected: { sessionDir: current.sessionDir, subagentSessionDir: current.subagentSessionDir },
			subdirectories: { ...current.subdirectories },
		});
	}

	async function saveStorage() {
		const confirmation = storageConfirmation();
		if (disposed || pending() || !storageReady() || !confirmation) return;
		// Share the synchronous single-flight guard with all metadata forms/actions.
		setPending(true);
		const generation = ++mutationGeneration;
		setWriteError("");
		setNotice("");
		try {
			const data = await api.saveCloudSessionStorage(confirmation.root, confirmation.expected);
			if (disposed || generation !== mutationGeneration) return;
			setStorage(data);
			setStorageConfirmation(undefined);
			setNotice("Session log locations saved. Existing logs and active sessions are unchanged.");
		} catch (error) {
			if (!disposed && generation === mutationGeneration) setWriteError(errorMessage(error));
		} finally {
			if (!disposed && generation === mutationGeneration) setPending(false);
		}
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
				<h1>cloud workspaces</h1>
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
							if (!pending()) {
								void load();
								void loadStorage();
							}
						}}
					>
						Refresh metadata
					</button>
					<Show when={pending()}>
						<output aria-live="polite">Saving changes…</output>
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
				<form
					aria-label="Connect folder"
					onSubmit={(event) => {
						event.preventDefault();
						connectFolder();
					}}
				>
					<fieldset disabled={pending()}>
						<legend>Connect a folder</legend>
						<label>
							Folder path on this computer
							<input
								required
								value={folderPath()}
								placeholder={placeholder()}
								onInput={(event) => {
									setFolderPath(event.currentTarget.value);
									setSetupPath(undefined);
									setStorageConfirmation(undefined);
								}}
							/>
						</label>
						<p>
							The same path can be used independently for a project connection and optional session logs.
							Projects may remain elsewhere. Connecting a folder does not change log locations.
						</p>
						<button class="btn" type="submit" disabled={!snapshot() || !folderPath()}>
							Connect folder
						</button>
					</fieldset>
				</form>
				<Show when={setupPath()}>
					{(path) => (
						<fieldset class="cloud-confirmation" disabled={pending()}>
							<legend>Set up this folder for the first time?</legend>
							<p>{path()}</p>
							<p>
								If this folder was already set up on another computer, wait for its synced identity to arrive.
								Do not set it up again or initialize a replacement identity.
							</p>
							<div class="cloud-actions">
								<button
									class="btn"
									type="button"
									onClick={() => {
										if (disposed || pending() || setupPath() !== folderPath()) return;
										const capturedPath = path();
										// Dismiss before writing: a partial initialization must retry through Connect.
										setSetupPath(undefined);
										void mutate(
											() => api.linkProject({ path: capturedPath, initialize: true }),
											`Folder connected successfully: ${capturedPath}`,
										);
									}}
								>
									Set up folder
								</button>
								<button class="btn" type="button" onClick={() => setSetupPath(undefined)}>
									Cancel setup
								</button>
							</div>
						</fieldset>
					)}
				</Show>
				<section aria-label="Session log storage">
					<h2>Session log storage</h2>
					<Show when={storageLoading()}>
						<output aria-live="polite">Loading session storage…</output>
					</Show>
					<Show when={storageError()}>
						<p role="alert" class="cloud-error">
							Could not load session storage: {storageError()} Project connections are independent.
						</p>
						<button
							class="btn"
							type="button"
							disabled={pending()}
							onClick={() => {
								if (!pending()) void loadStorage();
							}}
						>
							Retry session storage
						</button>
					</Show>
					<Show when={storage()}>
						{(current) => (
							<>
								<p>Main session logs: {current().sessionDir ?? "Local default (~/.dreb/agent/sessions)"}</p>
								<p>
									Subagent session logs:{" "}
									{current().subagentSessionDir ?? "Local default (~/.dreb/agent/subagent-sessions)"}
								</p>
								<Show when={current().restartRequired}>
									<output aria-live="polite">
										Dashboard inventory still uses its startup log location. Restart Dashboard only when
										agents are idle to refresh inventory. Saving does not restart Dashboard.
									</output>
								</Show>
							</>
						)}
					</Show>
					<div class="cloud-actions">
						<button
							class="btn"
							type="button"
							disabled={pending() || !storageReady() || !folderPath()}
							onClick={() => confirmStorage(folderPath())}
						>
							Store session logs here
						</button>
						<button
							class="btn"
							type="button"
							disabled={pending() || !storageReady()}
							onClick={() => confirmStorage(null)}
						>
							Use local log defaults
						</button>
					</div>
					<Show when={storageConfirmation()}>
						{(confirmation) => (
							<fieldset class="cloud-confirmation" disabled={pending()}>
								<legend>
									{confirmation().root === null
										? "Return to local log defaults?"
										: "Store session logs in this folder?"}
								</legend>
								<Show
									when={confirmation().root !== null}
									fallback={<p>Use local defaults for main and subagent session logs.</p>}
								>
									<p>Folder: {confirmation().root}</p>
									<p>Main logs: {confirmation().subdirectories.sessionDir}</p>
									<p>Subagent logs: {confirmation().subdirectories.subagentSessionDir}</p>
								</Show>
								<p>
									This changes global defaults for all projects. Existing logs are not moved, copied or
									deleted. Active sessions keep their existing files. Project/CLI overrides remain in effect.
									No folders or markers are created. There is no automatic restart. Cloud sync is not a lock.
								</p>
								<div class="cloud-actions">
									<button class="btn" type="button" onClick={() => void saveStorage()}>
										Save log locations
									</button>
									<button class="btn" type="button" onClick={() => setStorageConfirmation(undefined)}>
										Cancel log change
									</button>
								</div>
							</fieldset>
						)}
					</Show>
				</section>
				<details class="cloud-advanced">
					<summary>advanced setup</summary>
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
									<select
										value={projectMode()}
										onChange={(event) => setProjectMode(event.currentTarget.value)}
									>
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
									Enter an absolute host path in either mode. Workspace-relative binding records its
									relationship to the explicitly selected workspace; no folders are moved or discovered.
								</p>
								<button class="btn" type="submit">
									Link project
								</button>
							</fieldset>
						</form>
					</div>
					<Show when={snapshot()}>
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
					</Show>
				</details>
				<Show when={snapshot()}>
					<Show when={workspaces().length === 0 && projects().length === 0}>
						<p>No registered workspaces or projects. Ordinary local sessions work without setup.</p>
					</Show>
					<section aria-label="Registered projects">
						<h2>Projects</h2>
						<Show when={projects().length === 0}>
							<p>No projects registered.</p>
						</Show>
						<For each={projects()}>
							{(project) => (
								<article class="cloud-row" aria-label={`Project ${project.id}`}>
									<h3>
										{configuredProjectPath(project) ??
											(project.status.available
												? project.status.path
												: project.location.kind === "workspace"
													? project.location.relativePath
													: "")}
									</h3>
									<details class="cloud-technical">
										<summary>technical details</summary>
										<p>Project ID: {project.id}</p>
										<p>
											{project.location.kind === "local"
												? `Configured local path: ${project.location.path}`
												: `Workspace ID: ${project.location.workspaceId} — relative path: ${project.location.relativePath}`}
										</p>
										<p>
											Marker required: {project.markerRequired ? "yes" : "no (known-ID markerless binding)"}
										</p>
									</details>
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
