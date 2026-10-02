import { render } from "solid-js/web";
import { ThemeGallery } from "../../../src/client/components/theme-gallery.js";
import { initAppearance, setFont, setTheme } from "../../../src/client/state/appearance.js";
import "../../../src/client/styles/tokens.css";
import "../../../src/client/styles/app.css";
import "../../../src/client/styles/themes.css";
import "../../../src/client/styles/font-catalog.css";

initAppearance();
render(
	() => (
		<main class="container settings-wrap">
			<button type="button" id="before">
				before
			</button>
			<section class="settings-section">
				<ThemeGallery />
			</section>
			<button type="button" id="after">
				after
			</button>
			<button type="button" id="force-theme" onClick={() => setTheme("gruvbox")}>
				Gruvbox
			</button>
			<button type="button" id="force-font" onClick={() => setFont("inter")}>
				Inter
			</button>
			<p class="probe">Résumé € 42 — ● ◆ ○ ✕ ↻ 日本語 한글 हिन्दी</p>
			<p id="core-style-probes"></p>
		</main>
	),
	document.getElementById("root")!,
);
