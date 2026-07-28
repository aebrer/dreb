import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
	plugins: [solid()],
	root,
	server: {
		open: "/ask-user.browser-harness.html",
	},
	build: {
		outDir: resolve(root, "../../.ask-user-prototype"),
		emptyOutDir: true,
		rollupOptions: {
			input: resolve(root, "ask-user.browser-harness.html"),
		},
	},
});
