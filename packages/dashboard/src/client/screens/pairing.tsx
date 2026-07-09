/**
 * Pairing screen — remote first-login. Identity echo, pairing-code entry with
 * the two verbatim security copy blocks. Shown outside the tab structure.
 */

import { createSignal, type JSX, Show } from "solid-js";
import { api } from "../api.js";
import type { AppStore } from "../state/store.js";

export function PairingScreen(props: { store: AppStore }): JSX.Element {
	const [pin, setPin] = createSignal("");
	const [error, setError] = createSignal<string>();
	const [busy, setBusy] = createSignal(false);

	const auth = () => props.store.auth();
	const denied = () => auth()?.error && !auth()?.needsPairing;
	const isMobile = () => typeof window.matchMedia === "function" && window.matchMedia("(max-width: 700px)").matches;

	async function pair() {
		setBusy(true);
		setError(undefined);
		try {
			await api.pair(pin());
			// Paired — restart the app flow (auth now passes, SSE connects).
			await props.store.start();
			props.store.navigate({ screen: "fleet" });
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div class="pair-wrap">
			<Show
				when={!denied()}
				fallback={
					<main class="denied-card">
						<span class="wordmark">dreb</span>
						<h1>access denied</h1>
						<p>{auth()?.error}</p>
						<Show when={auth()?.identity}>
							<p class="muted small">rejected identity: {auth()!.identity}</p>
						</Show>
						<p class="muted small">
							If this device should have access, add its Tailscale identity to the dashboard allowlist on the
							host and reload.
						</p>
					</main>
				}
			>
				<main class="pair-card">
					<span class="wordmark">dreb</span>
					<h1>pair this device</h1>
					<p class="sub">First login from a new device needs the current pairing code.</p>

					<div class="identity">
						<span class="row-line">
							<span class="k">tailscale identity</span>
							<span>{auth()?.identity ?? "unknown"}</span>
						</span>
						<span class="row-line">
							<span class="k">allowlist</span>
							<span class="chip chip-running" style={{ "align-self": "flex-end" }}>
								<span class="dot">●</span> allowed
							</span>
						</span>
					</div>

					<div class="field">
						<label for="pairing-pin">6-digit code</label>
						<input
							id="pairing-pin"
							class="pin-input"
							type="text"
							inputmode="numeric"
							maxlength="6"
							autocomplete="one-time-code"
							value={pin()}
							onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, "").slice(0, 6))}
							onKeyDown={(e) => {
								if (e.key === "Enter" && pin().length === 6 && !isMobile()) pair();
							}}
						/>
					</div>
					<p class="pin-hint">
						The code is shown in the dashboard <strong>Settings tab on the host machine</strong>. It rotates every
						30 seconds.
					</p>

					<Show when={error()}>
						<p class="pair-error">{error()}</p>
					</Show>

					<div class="pair-actions">
						<button type="button" class="btn btn-primary" disabled={pin().length !== 6 || busy()} onClick={pair}>
							{busy() ? "pairing…" : "pair device"}
						</button>
					</div>

					<div class="security-note">
						<p>
							<strong>Why a PIN?</strong> Your network identity got you here, but identity alone doesn't grant
							control. The code proves you can see the host machine's local dashboard — so a stolen or shared
							allowlist entry can't quietly gain access.
						</p>
						<p>
							<strong>What pairing grants.</strong> This browser gets a signed cookie for this host. It can chat
							with agents, run commands through them, browse the host's files, and upload/download — the same
							power as sitting at the terminal. Unpair anytime from settings → devices.
						</p>
					</div>
				</main>
			</Show>
		</div>
	);
}
