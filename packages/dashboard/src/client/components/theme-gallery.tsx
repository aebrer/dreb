/**
 * Theme gallery — the dashboard's appearance control surface.
 *
 * A color-mode selector (system / light / dark) plus a grid of scoped preview
 * cards, one per curated theme (default first). Each card is a *self-contained*
 * preview: the card element itself carries `data-theme` (INCLUDING "default",
 * which themes.css maps to the tokens.css baseline via an explicit scope) and
 * `data-color-mode` (omitted for system), so themes.css resolves that theme's
 * palette LOCALLY over the ENTIRE card — background, status chips, code snippet
 * and footer. This makes every preview independent of which theme is currently
 * active on :root (the surrounding page). The document root is untouched until
 * the user commits by clicking a card. Everything here is browser-local
 * (localStorage via state/appearance.ts); there is no server/RPC involvement.
 */

import { For, type JSX } from "solid-js";
import { type ColorMode, colorMode, MODES, setColorMode, setTheme, THEMES, theme } from "../state/appearance.js";
import { StatusChip } from "./common.js";

/** Order matters only for display; matches StatusChip's own glyph set. */
const STATUSES = ["running", "attention", "idle", "error"] as const;

export function ThemeGallery(): JSX.Element {
	// The preview cards mirror the CURRENT selected mode. In system mode we omit
	// the attribute so each preview follows the OS (via themes.css media rules).
	const previewMode = (): ColorMode | undefined => {
		const mode = colorMode();
		return mode === "system" ? undefined : mode;
	};

	return (
		<div class="appearance-controls">
			<div class="setting-row">
				<span class="setting-label">
					<span class="name">color mode</span>
					<span class="hint">this browser only — “system” follows your OS light/dark preference</span>
				</span>
				<span class="setting-control">
					<select
						id="pref-color-mode"
						value={colorMode()}
						onChange={(e) => setColorMode(e.currentTarget.value as ColorMode)}
					>
						<For each={MODES}>{(mode) => <option value={mode}>{mode}</option>}</For>
					</select>
				</span>
			</div>

			<div class="theme-gallery">
				<For each={THEMES}>
					{(entry) => {
						const active = () => theme() === entry.id;
						return (
							// The card element carries the scope so themes.css remaps the palette
							// over the WHOLE card (chrome + preview + footer), independent of the
							// theme active on :root. data-theme is set for every card INCLUDING
							// "default" (themes.css has an explicit [data-theme="default"] scope);
							// data-color-mode mirrors the current selection (omitted for system).
							<button
								type="button"
								class="theme-card"
								classList={{ active: active() }}
								data-theme-card={entry.id}
								data-theme={entry.id}
								data-color-mode={previewMode()}
								aria-pressed={active()}
								aria-current={active() ? "true" : undefined}
								title={`use the ${entry.label} theme`}
								onClick={() => setTheme(entry.id)}
							>
								<div class="theme-card-preview">
									<div class="theme-card-swatch">
										<span class="theme-card-name">{entry.label}</span>
										<span class="theme-card-muted">The quick brown fox.</span>
									</div>
									<div class="theme-card-chips">
										<For each={STATUSES}>{(status) => <StatusChip status={status} label="" />}</For>
									</div>
									<pre class="theme-card-code">
										<code class="hljs">
											<span class="hljs-keyword">const</span> <span class="hljs-variable">count</span>
											<span class="hljs-operator"> = </span>
											<span class="hljs-number">42</span>
											<span class="hljs-punctuation">;</span>
											{"\n"}
											<span class="hljs-comment">{"// preview"}</span>
											{"\n"}
											<span class="hljs-function">render</span>
											<span class="hljs-punctuation">(</span>
											<span class="hljs-string">"ok"</span>
											<span class="hljs-punctuation">)</span>
											<span class="hljs-punctuation">;</span>
										</code>
									</pre>
								</div>
								<span class="theme-card-footer">
									<span class="theme-card-title">{entry.label}</span>
									<span class="theme-card-state">{active() ? "✓ active" : "select"}</span>
								</span>
							</button>
						);
					}}
				</For>
			</div>
		</div>
	);
}
