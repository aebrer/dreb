/**
 * Memories tab — dreb global/project memory browser and editor.
 * Existing documents only: MEMORY.md index plus direct child .md entries.
 */

import { batch, createEffect, createResource, createSignal, For, type JSX, Show } from "solid-js";
import type {
	MemoryDocumentDto,
	MemoryEntrySummaryDto,
	MemoryListingDto,
	MemoryScopeDto,
} from "../../shared/protocol.js";
import { api } from "../api.js";
import { Modal, Topbar } from "../components/common.js";
import { MarkdownBody } from "../components/transcript.js";
import type { AppStore } from "../state/store.js";

const INDEX_FILE = "MEMORY.md";

type SelectedDocument = { scopeId: string; file: string };

function metadataLine(entry: MemoryEntrySummaryDto): string {
	if (entry.metadata) return `${entry.metadata.name} · ${entry.metadata.type}`;
	return entry.metadataError ? `metadata error: ${entry.metadataError}` : "metadata unavailable";
}

function documentTitle(document: MemoryDocumentDto | undefined, file: string | undefined): string {
	if (!document) return file ?? "memory";
	if (document.kind === "index") return "MEMORY.md index";
	return document.metadata?.name ?? document.file;
}

function selectDefaultFile(listing: MemoryListingDto | undefined): string | undefined {
	if (!listing) return undefined;
	if (listing.indexContent !== null) return INDEX_FILE;
	return listing.entries[0]?.file;
}

export function MemoriesScreen(props: { store: AppStore }): JSX.Element {
	const [selectedScopeId, setSelectedScopeId] = createSignal<string>();
	const [selectedFile, setSelectedFile] = createSignal<string>();
	const [error, setError] = createSignal<string>();
	const [status, setStatus] = createSignal<string>();
	const [draft, setDraft] = createSignal("");
	const [dirty, setDirty] = createSignal(false);
	const [saving, setSaving] = createSignal(false);
	const [deleteTarget, setDeleteTarget] = createSignal<MemoryDocumentDto>();

	const [scopes, { refetch: refetchScopes }] = createResource(async () => {
		try {
			const result = await api.memoryScopes();
			return result.scopes;
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
			return [];
		}
	});

	createEffect(() => {
		const all = scopes();
		if (!all?.length) return;
		const current = selectedScopeId();
		if (!current || !all.some((scope) => scope.id === current)) setSelectedScopeId(all[0].id);
	});

	const [listing, { mutate: mutateListing, refetch: refetchListing }] = createResource(
		() => selectedScopeId(),
		async (scopeId): Promise<MemoryListingDto | undefined> => {
			setError(undefined);
			setStatus(undefined);
			try {
				return await api.memoryListing(scopeId);
			} catch (failure) {
				setError(failure instanceof Error ? failure.message : String(failure));
				return undefined;
			}
		},
	);

	createEffect(() => {
		const current = listing();
		if (!current) return;
		const file = selectedFile();
		const available = new Set([
			...(current.indexContent !== null ? [INDEX_FILE] : []),
			...current.entries.map((e) => e.file),
		]);
		if (!file || !available.has(file)) setSelectedFile(selectDefaultFile(current));
	});

	const [document, { mutate: mutateDocument, refetch: refetchDocument }] = createResource(
		(): SelectedDocument | undefined => {
			const scopeId = selectedScopeId();
			const file = selectedFile();
			return scopeId && file ? { scopeId, file } : undefined;
		},
		async (selection): Promise<MemoryDocumentDto | undefined> => {
			setError(undefined);
			setStatus(undefined);
			try {
				return await api.memoryDocument(selection.scopeId, selection.file);
			} catch (failure) {
				setError(failure instanceof Error ? failure.message : String(failure));
				return undefined;
			}
		},
	);

	createEffect(() => {
		const doc = document();
		if (!doc || dirty()) return;
		setDraft(doc.content);
	});

	function chooseScope(scope: MemoryScopeDto) {
		if (selectedScopeId() === scope.id) return;
		batch(() => {
			setSelectedFile(undefined);
			setSelectedScopeId(scope.id);
			mutateDocument(undefined);
			setDirty(false);
			setDraft("");
		});
	}

	function chooseFile(file: string) {
		if (selectedFile() === file) return;
		setSelectedFile(file);
		mutateDocument(undefined);
		setDirty(false);
		setDraft("");
	}

	async function refreshAll() {
		await refetchScopes();
		await refetchListing();
		if (selectedFile()) await refetchDocument();
	}

	async function save() {
		const scopeId = selectedScopeId();
		const doc = document();
		if (!scopeId || !doc) return;
		setSaving(true);
		setError(undefined);
		setStatus(undefined);
		try {
			const result = await api.saveMemoryDocument(scopeId, doc.file, draft(), doc.revision);
			mutateListing(result.listing);
			if (result.document) mutateDocument(result.document);
			setDraft(result.document?.content ?? draft());
			setDirty(false);
			setStatus("saved");
		} catch (err: any) {
			setError(
				err?.status === 409
					? `${err.message} Your draft is still here.`
					: err instanceof Error
						? err.message
						: String(err),
			);
		} finally {
			setSaving(false);
		}
	}

	async function confirmDelete() {
		const scopeId = selectedScopeId();
		const doc = deleteTarget();
		const currentListing = listing();
		if (!scopeId || !doc || doc.kind !== "entry" || !currentListing) return;
		setSaving(true);
		setError(undefined);
		setStatus(undefined);
		try {
			const result = await api.deleteMemoryEntry(scopeId, doc.file, doc.revision, currentListing.indexRevision);
			mutateListing(result.listing);
			mutateDocument(undefined);
			setDeleteTarget(undefined);
			setSelectedFile(selectDefaultFile(result.listing));
			setDirty(false);
			setDraft("");
			setStatus(`deleted ${doc.file}; index links cleaned up`);
		} catch (err: any) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}

	return (
		<div class="screen-fill">
			<Topbar store={props.store} active="memories" />
			<main class="container memories-screen">
				<div class="memories-head">
					<div>
						<h1>Memories</h1>
						<p class="scope-note">
							Edit dreb memory only: global ~/.dreb/memory plus known project .dreb/memory scopes. Claude memory
							paths are never included.
						</p>
					</div>
					<button
						type="button"
						class="btn"
						onClick={() => void refreshAll()}
						disabled={scopes.loading || listing.loading}
					>
						refresh
					</button>
				</div>

				<Show when={error()}>
					<p class="settings-error">{error()}</p>
				</Show>
				<Show when={status()}>
					<p class="settings-success">{status()}</p>
				</Show>

				<div class="memories-layout">
					<aside class="memories-sidebar">
						<section class="memory-panel">
							<h2>Scopes</h2>
							<Show when={!scopes.loading} fallback={<p class="muted">loading scopes…</p>}>
								<Show
									when={(scopes() ?? []).length > 0}
									fallback={<p class="muted">No active dreb memory scopes.</p>}
								>
									<For each={scopes() ?? []}>
										{(scope) => (
											<button
												type="button"
												class="memory-nav-item"
												classList={{ active: selectedScopeId() === scope.id }}
												onClick={() => chooseScope(scope)}
											>
												<span>{scope.kind === "global" ? "global" : scope.label}</span>
												<small>{scope.exists ? scope.memoryDir : `${scope.memoryDir} (missing)`}</small>
											</button>
										)}
									</For>
								</Show>
							</Show>
						</section>

						<section class="memory-panel">
							<h2>Documents</h2>
							<Show when={!listing.loading} fallback={<p class="muted">loading documents…</p>}>
								<Show
									when={listing()?.scope.exists}
									fallback={<p class="muted">Memory directory is missing; nothing to edit.</p>}
								>
									<Show
										when={listing()?.indexContent !== null}
										fallback={<p class="muted">MEMORY.md index missing.</p>}
									>
										<button
											type="button"
											class="memory-nav-item"
											classList={{ active: selectedFile() === INDEX_FILE }}
											onClick={() => chooseFile(INDEX_FILE)}
										>
											<span>MEMORY.md</span>
											<small>complete editable index</small>
										</button>
									</Show>
									<Show
										when={(listing()?.entries.length ?? 0) > 0}
										fallback={<p class="muted">No memory entries.</p>}
									>
										<For each={listing()?.entries ?? []}>
											{(entry) => (
												<button
													type="button"
													class="memory-nav-item"
													classList={{
														active: selectedFile() === entry.file,
														error: Boolean(entry.metadataError),
													}}
													onClick={() => chooseFile(entry.file)}
												>
													<span>{entry.file}</span>
													<small>{metadataLine(entry)}</small>
												</button>
											)}
										</For>
									</Show>
								</Show>
							</Show>
						</section>
					</aside>

					<section class="memory-editor">
						<Show when={listing()?.indexOverLimit}>
							<div class="context-trust-warning">
								<strong>Complete index warning:</strong> MEMORY.md is over 200 lines. The dashboard shows the
								full file for repair, while the agent prompt may only load the indexed prefix.
							</div>
						</Show>
						<Show when={document()} fallback={<p class="muted">Select an existing memory document.</p>}>
							{(doc) => (
								<>
									<div class="memory-doc-head">
										<div>
											<h2>{documentTitle(doc(), selectedFile())}</h2>
											<p class="scope-note">
												{doc().file} · revision {doc().revision.slice(0, 12)}
											</p>
										</div>
										<div class="head-actions">
											<button
												type="button"
												class="btn"
												disabled={document.loading}
												onClick={() => void refetchDocument()}
											>
												reload
											</button>
											<Show when={doc().kind === "entry"}>
												<button type="button" class="btn btn-danger" onClick={() => setDeleteTarget(doc())}>
													delete entry
												</button>
											</Show>
										</div>
									</div>

									<Show when={doc().metadata}>
										{(meta) => (
											<div class="memory-metadata">
												<strong>{meta().name}</strong>
												<span>{meta().type}</span>
												<span>{meta().description}</span>
											</div>
										)}
									</Show>
									<Show when={doc().metadataError}>
										<p class="settings-error">Metadata error: {doc().metadataError}</p>
									</Show>

									<div class="memory-edit-actions">
										<button
											type="button"
											class="btn btn-primary"
											disabled={!dirty() || saving()}
											onClick={() => void save()}
										>
											{saving() ? "saving…" : "save"}
										</button>
										<button
											type="button"
											class="btn"
											disabled={!dirty() || saving()}
											onClick={() => {
												setDraft(doc().content);
												setDirty(false);
											}}
										>
											revert draft
										</button>
										<span class="muted">{dirty() ? "unsaved draft" : "saved revision loaded"}</span>
									</div>

									<textarea
										class="memory-textarea"
										value={draft()}
										onInput={(event) => {
											setDraft(event.currentTarget.value);
											setDirty(event.currentTarget.value !== doc().content);
										}}
									/>

									<details class="memory-preview" open>
										<summary>preview</summary>
										<MarkdownBody text={draft()} throttle />
									</details>
								</>
							)}
						</Show>
					</section>
				</div>

				<Show when={deleteTarget()}>
					{(target) => (
						<Modal
							title={`Delete ${target().file}?`}
							onDismiss={() => setDeleteTarget(undefined)}
							actions={
								<>
									<button type="button" class="btn" onClick={() => setDeleteTarget(undefined)}>
										cancel
									</button>
									<button
										type="button"
										class="btn btn-danger"
										disabled={saving()}
										onClick={() => void confirmDelete()}
									>
										{saving() ? "deleting…" : "delete entry"}
									</button>
								</>
							}
						>
							<p>
								This deletes the entry file and first removes matching <code>[…]({target().file})</code> or{" "}
								<code>[…](./{target().file})</code> lines from MEMORY.md. If the index changed, deletion will
								fail with a conflict instead of leaving a dangling link.
							</p>
						</Modal>
					)}
				</Show>
			</main>
		</div>
	);
}
