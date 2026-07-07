import { resolve } from "node:path";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Builds the browser client into dist/static, served by the dashboard server.
export default defineConfig({
	plugins: [solid()],
	root: resolve(import.meta.dirname, "src/client"),
	base: "./",
	build: {
		outDir: resolve(import.meta.dirname, "dist/static"),
		emptyOutDir: true,
	},
});
