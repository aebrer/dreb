import { render } from "solid-js/web";
import { App } from "./app.js";

const root = document.getElementById("root");
if (!root) throw new Error("dashboard: #root element missing from index.html");
render(() => <App />, root);
