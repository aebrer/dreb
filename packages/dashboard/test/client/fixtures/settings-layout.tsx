import { render } from "solid-js/web";
import { ScopedModelsEditor } from "../../../src/client/components/scoped-models-editor.js";
import "../../../src/client/styles/tokens.css";
import "../../../src/client/styles/app.css";
import "../../../src/client/styles/themes.css";

const longPath = `/home/actors/${"deeply-nested/project-layer/".repeat(4)}dreb`;

function LayoutFixture() {
	return (
		<main class="container settings-wrap">
			<section class="settings-section">
				<h2>agent models</h2>
				<div class="setting-row agent-context-row" data-agent-row>
					<span class="setting-label" data-agent-label>
						<span class="name">agent definition context</span>
						<span class="hint">choose a project to include its .dreb/agents definitions</span>
					</span>
					<span class="setting-control" data-agent-control>
						<select data-agent-select title={longPath}>
							<option value="">global/home only</option>
							<option value={longPath} selected>
								{longPath}
							</option>
						</select>
					</span>
				</div>
				<div class="setting-row" data-short-row>
					<span class="setting-label">
						<span class="name">appearance</span>
						<span class="hint">short control regression guard</span>
					</span>
					<span class="setting-control">
						<select data-short-select>
							<option selected>system</option>
							<option>light</option>
							<option>dark</option>
						</select>
					</span>
				</div>
			</section>
			<ScopedModelsEditor cwd={longPath} projectRoots={[longPath]} onCwdChange={() => {}} />
		</main>
	);
}

render(() => <LayoutFixture />, document.getElementById("root")!);
