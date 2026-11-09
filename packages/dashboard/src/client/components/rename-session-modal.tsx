import { createSignal, type JSX, onCleanup, Show } from "solid-js";
import type { SessionInfoDto } from "../../shared/protocol.js";
import { Modal } from "./common.js";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Rename a past session: manual entry pre-filled with the current name, plus an
 * auto-generate action that asks the tab-title generator for a title from the
 * saved session log. Every failure stays visible in the modal.
 */
export function RenameSessionModal(props: {
	session: SessionInfoDto;
	/** Persist the trimmed name; a rejection is shown in the modal, which stays open. */
	onRename: (name: string) => Promise<void>;
	/** Produce a suggested title; aborted when the modal closes so a late result is dropped. */
	onGenerate: (signal: AbortSignal) => Promise<string>;
	onClose: () => void;
}): JSX.Element {
	const [name, setName] = createSignal(props.session.name ?? "");
	const [error, setError] = createSignal<string>();
	const [saving, setSaving] = createSignal(false);
	const [generating, setGenerating] = createSignal(false);
	const busy = () => saving() || generating();
	let generation: AbortController | undefined;
	onCleanup(() => generation?.abort());

	async function generate(): Promise<void> {
		if (busy()) return;
		const controller = new AbortController();
		generation = controller;
		setGenerating(true);
		setError(undefined);
		try {
			const title = await props.onGenerate(controller.signal);
			if (!controller.signal.aborted) setName(title);
		} catch (err) {
			if (!controller.signal.aborted) setError(`Failed to generate a title: ${errorMessage(err)}`);
		} finally {
			if (generation === controller) {
				generation = undefined;
				setGenerating(false);
			}
		}
	}

	async function save(): Promise<void> {
		const next = name().trim();
		if (busy() || !next) return;
		setSaving(true);
		setError(undefined);
		try {
			await props.onRename(next);
		} catch (err) {
			setError(`Failed to rename session: ${errorMessage(err)}`);
		} finally {
			setSaving(false);
		}
	}

	function close(): void {
		if (saving()) return;
		props.onClose();
	}

	return (
		<Modal
			title="rename session"
			class="rename-session-modal"
			onDismiss={close}
			actions={
				<>
					<button type="button" class="btn btn-small" disabled={saving()} onClick={close}>
						cancel
					</button>
					<button
						type="button"
						class="btn btn-small btn-primary"
						disabled={busy() || !name().trim()}
						onClick={() => void save()}
					>
						{saving() ? "renaming…" : "rename"}
					</button>
				</>
			}
		>
			<div class="field">
				<label for="rename-session-name">session name</label>
				<input
					id="rename-session-name"
					type="text"
					value={name()}
					placeholder={props.session.firstMessage.slice(0, 60)}
					disabled={busy()}
					onInput={(event) => setName(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") void save();
					}}
				/>
			</div>
			<div class="rename-session-generate">
				<button
					type="button"
					class="btn btn-small"
					disabled={busy()}
					aria-busy={generating()}
					onClick={() => void generate()}
				>
					{generating() ? "generating…" : "auto-generate"}
				</button>
				<span class="muted small">suggests a title from the saved session log</span>
			</div>
			<Show when={error()}>
				<p class="pair-error" role="alert">
					{error()}
				</p>
			</Show>
		</Modal>
	);
}
