import { render } from "solid-js/web";
import { App } from "./app.js";
import { initAppearance } from "./state/appearance.js";

// Reconcile persisted appearance (theme/mode) → DOM attributes + chrome color
// and register the matchMedia/storage listeners BEFORE Solid mounts, so the app
// tree renders against the correct palette from its first frame.
initAppearance();

const root = document.getElementById("root");
if (!root) throw new Error("dashboard: #root element missing from index.html");
render(() => <App />, root);
