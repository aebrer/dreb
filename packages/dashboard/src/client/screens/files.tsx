/**
 * Files tab — host-wide browse with places shortcuts, breadcrumbs to /,
 * new-folder, download, drop-zone upload with collision prompt, "new session
 * here". Warning copy is fixed on the screen, not a toast.
 */

import { createResource, createSignal, For, type JSX, Show } from "solid-js";
import type { DirListingDto } from "../../shared/protocol.js";
import { api } from "../api.js";
import { formatBytes, Modal, relativeTime, Topbar } from "../components/common.js";
import type { AppStore } from "../state/store.js";

function crumbs(path: string): Array<{ label: string; path: string }> {
	const parts = path.split("/").filter(Boolean);
	const result = [{ label: "/", path: "/" }];
	let current = "";
	for (const part of parts) {
		current += `/${part}`;
		result.push({ label: part, path: current });
	}
	return result;
}

export function FilesScreen(props: { store: AppStore; initialPath?: string }): JSX.Element {
	const [path, setPath] = createSignal(props.initialPath ?? "");
	const [error, setError] = createSignal<string>();
	const [dragActive, setDragActive] = createSignal(false);
	const [collision, setCollision] = createSignal<File>();
	const [showMkdir, setShowMkdir] = createSignal(false);
	const [mkdirName, setMkdirName] = createSignal("");
	const [trustMutating, setTrustMutating] = createSignal(false);

	const [places] = createResource(async () => {
		const { places } = await api.places();
		return places;
	});

	const [listing, { mutate, refetch }] = createResource(
		() => path(),
		async (p): Promise<DirListingDto> => {
			setError(undefined);
			if (!p) {
				const { places: all } = await api.places();
				const home = all.find((place) => place.label === "home");
				const target = home?.path ?? "/";
				setPath(target);
				return api.listFiles(target);
			}
			return api.listFiles(p);
		},
	);

	async function upload(file: File, overwrite: boolean) {
		try {
			await api.upload(path(), file, overwrite);
			setCollision(undefined);
			await refetch();
		} catch (err: any) {
			if (err?.status === 409 && !overwrite) {
				setCollision(file);
			} else {
				setError(err instanceof Error ? err.message : String(err));
			}
		}
	}

	async function newSessionHere() {
		try {
			const runtime = await api.createRuntime(path());
			props.store.upsertRuntime(runtime);
			await props.store.refreshDiskSessions();
			props.store.navigate({ screen: "session", key: runtime.key });
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	async function changeContextTrust(action: "trust" | "untrust") {
		const current = listing();
		if (!current) return;
		setError(undefined);
		setTrustMutating(true);
		try {
			const result =
				action === "trust"
					? await api.trustContextFolder(current.path)
					: await api.untrustContextFolder(current.path);
			// Do not let a completed mutation overwrite a listing reached by navigation.
			const displayed = listing();
			if (path() === current.path && displayed?.path === current.path) {
				mutate({ ...displayed, contextTrust: result.evaluation });
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setTrustMutating(false);
		}
	}

	let fileInput: HTMLInputElement | undefined;

	return (
		<div class="screen-fill">
			<Topbar store={props.store} active="files" />
			<main class="container">
				<div class="files-head">
					<div>
						<nav class="crumbs" aria-label="breadcrumb">
							<For each={crumbs(path())}>
								{(crumb, index) => (
									<>
										<Show when={index() > 1}>
											<span class="sep">/</span>
										</Show>
										<a
											href={`#/files/${encodeURIComponent(crumb.path)}`}
											onClick={(e) => {
												e.preventDefault();
												setPath(crumb.path);
											}}
										>
											{crumb.label}
										</a>
									</>
								)}
							</For>
						</nav>
						<p class="scope-note">whole host filesystem — you can browse anywhere the dreb process can read</p>
					</div>
					<div class="head-actions">
						<button type="button" class="btn" onClick={() => setShowMkdir(true)}>
							+ new folder
						</button>
						<button type="button" class="btn" onClick={() => fileInput?.click()}>
							↑ upload here
						</button>
						<button type="button" class="btn btn-primary" onClick={newSessionHere}>
							▸ new session here
						</button>
					</div>
				</div>

				<section class="context-trust" aria-live="polite">
					<Show when={listing()?.contextTrust} fallback={<span>nested context trust: checking…</span>}>
						{(trust) => (
							<Show
								when={trust().state === "untrusted"}
								fallback={
									<Show
										when={trust().state === "trusted-root"}
										fallback={
											<div class="context-trust-warning">
												<strong>Global expert trust is ON.</strong> Nested instructions from any resolvable
												directory may load, including prompt-injection content. Folder trust cannot override
												this global setting.{" "}
												<a href="#/settings">Disable global expert trust in Settings.</a>
											</div>
										}
									>
										<div>
											<strong>
												{trust().grantingRoot === trust().canonicalTarget
													? "Nested context trusted for this folder"
													: "Nested context inherited from a trusted root"}
											</strong>
											<p>
												{trust().grantingRoot === trust().canonicalTarget
													? `${trust().grantingRoot} and all descendants are trusted.`
													: `${trust().canonicalTarget} is covered by ${trust().grantingRoot} and its descendants.`}
											</p>
											<button
												type="button"
												class="btn btn-small btn-danger"
												disabled={trustMutating()}
												onClick={() => void changeContextTrust("untrust")}
											>
												{trustMutating() ? "removing trust…" : `untrust ${trust().grantingRoot}`}
											</button>
											<p class="context-trust-impact">
												This removes trust from {trust().grantingRoot} and all of its descendants.
											</p>
										</div>
									</Show>
								}
							>
								<div>
									<strong>Nested context is untrusted.</strong>
									<p>This folder's nested instructions are not loaded automatically.</p>
									<button
										type="button"
										class="btn btn-small btn-primary"
										disabled={trustMutating()}
										onClick={() => void changeContextTrust("trust")}
									>
										{trustMutating() ? "trusting…" : "trust this folder and descendants"}
									</button>
									<p class="context-trust-impact">Trusting this folder trusts it and all descendants.</p>
								</div>
							</Show>
						)}
					</Show>
				</section>

				<div class="places">
					<span class="label">places</span>
					<For each={places() ?? []}>
						{(place) => (
							<button type="button" class="place-chip" onClick={() => setPath(place.path)}>
								{place.label}
							</button>
						)}
					</For>
				</div>

				<Show when={error()}>
					<p class="settings-error">{error()}</p>
				</Show>

				<table class="table file-table">
					<thead>
						<tr>
							<th>name</th>
							<th class="meta cols">size</th>
							<th class="meta cols">modified</th>
							<th />
						</tr>
					</thead>
					<tbody>
						<For each={listing()?.entries ?? []}>
							{(entry) => (
								<tr>
									<td>
										<Show
											when={entry.type === "dir"}
											fallback={
												<span class="name">
													<span class="icon">·</span> {entry.name}
												</span>
											}
										>
											<button
												type="button"
												class="name"
												onClick={() => setPath(`${listing()!.path}/${entry.name}`.replace("//", "/"))}
											>
												<span class="icon">▸</span> {entry.name}/
											</button>
										</Show>
									</td>
									<td class="meta cols">{entry.type === "dir" ? "—" : formatBytes(entry.size)}</td>
									<td class="meta cols">{relativeTime(entry.modified)}</td>
									<td class="actions">
										<Show when={entry.type === "file"}>
											<a
												class="btn btn-small"
												href={api.downloadUrl(`${listing()!.path}/${entry.name}`.replace("//", "/"))}
											>
												↓ download
											</a>
										</Show>
									</td>
								</tr>
							)}
						</For>
					</tbody>
				</table>

				<section
					class="drop-zone"
					aria-label="file upload drop zone"
					classList={{ active: dragActive() }}
					onDragOver={(e) => {
						e.preventDefault();
						setDragActive(true);
					}}
					onDragLeave={() => setDragActive(false)}
					onDrop={(e) => {
						e.preventDefault();
						setDragActive(false);
						const file = e.dataTransfer?.files[0];
						if (file) upload(file, false);
					}}
				>
					drop a file here to upload to {path()}
				</section>
				<p class="upload-warning">
					Uploads land on the host machine and become visible to any agent working near this path. Existing files
					are never overwritten silently — you'll be asked first.
				</p>
				<input
					type="file"
					ref={fileInput}
					style={{ display: "none" }}
					onChange={(e) => {
						const file = e.currentTarget.files?.[0];
						if (file) upload(file, false);
						e.currentTarget.value = "";
					}}
				/>
			</main>

			<Show when={collision()}>
				{(file) => (
					<Modal
						title="file exists"
						onDismiss={() => setCollision(undefined)}
						actions={
							<>
								<button type="button" class="btn btn-small" onClick={() => setCollision(undefined)}>
									cancel
								</button>
								<button type="button" class="btn btn-small btn-danger" onClick={() => upload(file(), true)}>
									overwrite
								</button>
							</>
						}
					>
						<p>
							“{file().name}” already exists in {path()}. Overwrite it?
						</p>
					</Modal>
				)}
			</Show>

			<Show when={showMkdir()}>
				<Modal
					title="new folder"
					onDismiss={() => setShowMkdir(false)}
					actions={
						<>
							<button type="button" class="btn btn-small" onClick={() => setShowMkdir(false)}>
								cancel
							</button>
							<button
								type="button"
								class="btn btn-small btn-primary"
								disabled={!mkdirName().trim()}
								onClick={async () => {
									try {
										await api.mkdir(path(), mkdirName().trim());
										setShowMkdir(false);
										setMkdirName("");
										await refetch();
									} catch (err) {
										setError(err instanceof Error ? err.message : String(err));
										setShowMkdir(false);
									}
								}}
							>
								create
							</button>
						</>
					}
				>
					<div class="field">
						<label for="mkdir-name">folder name</label>
						<input
							id="mkdir-name"
							type="text"
							value={mkdirName()}
							onInput={(e) => setMkdirName(e.currentTarget.value)}
						/>
					</div>
				</Modal>
			</Show>
		</div>
	);
}
