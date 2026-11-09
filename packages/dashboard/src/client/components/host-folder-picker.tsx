import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { CloudFolderListingDto } from "../../shared/protocol.js";
import { api } from "../api.js";
import { Modal } from "./common.js";
import "../styles/host-folder-picker.css";

/** A host-side selection only: never uploads, connects, initializes, or saves settings. */
export function HostFolderPicker(props: {
	initialPath: string;
	onSelect: (path: string) => void;
	onDismiss: () => void;
}) {
	const [location, setLocation] = createSignal(props.initialPath);
	const [listing, setListing] = createSignal<CloudFolderListingDto>();
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal("");
	let generation = 0;
	let disposed = false;
	let request: AbortController | undefined;
	let homeButton: HTMLButtonElement | undefined;

	onCleanup(() => {
		disposed = true;
		generation += 1;
		request?.abort();
	});

	async function browse(path?: string) {
		if (disposed) return;
		const current = ++generation;
		request?.abort();
		request = new AbortController();
		// Navigated rows disappear while loading; keep focus off the background page.
		homeButton?.focus({ preventScroll: true });
		setLoading(true);
		setError("");
		setLocation(path ?? "");
		try {
			const result = await api.cloudFolders(path, request.signal);
			if (disposed || current !== generation) return;
			setListing(result);
			setLocation(result.path);
		} catch (reason) {
			if (disposed || current !== generation) return;
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			if (!disposed && current === generation) setLoading(false);
		}
	}
	onMount(() => void browse(props.initialPath === "" ? undefined : props.initialPath));
	const selectable = () => !loading() && !error() && listing()?.path === location();

	return (
		<Modal
			title="Choose a folder on this computer"
			class="host-folder-picker"
			manageFocus
			onDismiss={props.onDismiss}
			actions={
				<>
					<button
						class="btn btn-primary"
						type="button"
						disabled={!selectable()}
						onClick={() => {
							const current = listing();
							if (current && selectable()) props.onSelect(current.path);
						}}
					>
						Choose folder
					</button>
					<button class="btn" type="button" onClick={props.onDismiss}>
						Cancel folder selection
					</button>
				</>
			}
		>
			<p>Browse the computer running dreb, not your browser or phone. Choosing only fills the path field.</p>
			<div class="host-folder-navigation">
				<button ref={homeButton} class="btn" type="button" onClick={() => void browse()}>
					Home folder
				</button>
				<button
					class="btn"
					type="button"
					disabled={loading() || !listing()?.parent}
					onClick={() => {
						const parent = listing()?.parent;
						if (parent && !loading()) void browse(parent);
					}}
				>
					Up one folder
				</button>
			</div>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (location() && !loading()) void browse(location());
				}}
			>
				<label>
					Browse location on this computer
					<input
						value={location()}
						disabled={loading()}
						onInput={(event) => setLocation(event.currentTarget.value)}
					/>
				</label>
				<button class="btn" type="submit" disabled={loading() || !location()}>
					Go to folder
				</button>
			</form>
			<Show when={loading()}>
				<output aria-live="polite">Loading folders…</output>
			</Show>
			<Show when={error()}>
				<p role="alert">Could not browse folders: {error()}</p>
				<button class="btn" type="button" onClick={() => void browse(location() || undefined)}>
					Retry folders
				</button>
			</Show>
			<Show when={!loading() && !error() && listing()}>
				{(current) => (
					<>
						<p class="host-folder-current">Current folder: {current().path}</p>
						<Show when={current().truncated}>
							<output>Some folders are not shown. Enter a full path above to reach another folder.</output>
						</Show>
						<ul aria-label="Folders" class="host-folder-list">
							<For
								each={current().entries}
								fallback={
									<li>
										{current().truncated
											? "No folders in the displayed portion."
											: "No subfolders in this folder."}
									</li>
								}
							>
								{(entry) => (
									<li>
										<button class="btn" type="button" onClick={() => void browse(entry.path)}>
											{entry.name}
										</button>
									</li>
								)}
							</For>
						</ul>
					</>
				)}
			</Show>
		</Modal>
	);
}
