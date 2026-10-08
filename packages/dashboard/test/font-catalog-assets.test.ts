import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const assets = new URL("../src/client/assets/fonts/expanded/", import.meta.url);
const catalog: {
	id: string;
	family: string;
	faces: {
		file: string;
		sha256: string;
		bytes: number;
		style: string;
		weight: string;
		sourceUrl: string;
		sourceSha256: string;
	}[];
	licenseFiles: string[];
	coverage: string[];
}[] = JSON.parse(readFileSync(new URL("catalog.json", assets), "utf8"));

describe("licensed font assets", () => {
	it("hashes every WOFF2, uses immutable source provenance and declares all four real core styles", () => {
		const css = readFileSync(new URL("../src/client/styles/font-catalog.css", import.meta.url), "utf8");
		const provenance = readFileSync(new URL("PROVENANCE.md", assets), "utf8");
		const files: string[] = [];
		for (const entry of catalog) {
			expect(provenance).toContain(entry.id);
			expect(css).toContain(`--mono-font: '${entry.family}'`);
			for (const style of ["normal", "italic"])
				for (const weight of [400, 700]) {
					expect(
						entry.faces.some((face) => {
							const range = face.weight.split(" ").map(Number);
							return face.style === style && weight >= range[0] && weight <= (range[1] ?? range[0]);
						}),
						`${entry.id} ${style} ${weight}`,
					).toBe(true);
				}
			for (const face of entry.faces) {
				const buffer = readFileSync(new URL(face.file, assets));
				expect(buffer.subarray(0, 4).toString()).toBe("wOF2");
				expect(buffer.length).toBe(face.bytes);
				expect(createHash("sha256").update(buffer).digest("hex")).toBe(face.sha256);
				expect(face.sourceUrl).toContain("/9710da1eacb3be272583c3224dcb70f9da6eadbb/");
				expect(face.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
				expect(css).toContain(`expanded/${face.file}`);
				files.push(face.file);
			}
			expect(entry.licenseFiles).toContain(`licenses/${entry.id}/OFL.txt`);
			for (const file of entry.licenseFiles)
				expect(readFileSync(new URL(file, assets), "utf8").length).toBeGreaterThan(100);
		}
		expect(catalog.find((entry) => entry.id === "google-sans")!.licenseFiles).toContain(
			"licenses/google-sans/TRADEMARKS.md",
		);
		expect(
			readdirSync(assets)
				.filter((file) => file.endsWith(".woff2"))
				.sort(),
		).toEqual(files.sort());
	});
	it("includes all legal/provenance records without duplicating source binaries in npm distribution", () => {
		const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const paths = new Set<string>(JSON.parse(output)[0].files.map((file: { path: string }) => file.path));
		expect(paths.has("scripts/build-font-catalog.py")).toBe(true);
		const prefix = "src/client/assets/fonts/expanded/";
		for (const file of ["catalog.json", "sources.lock.json", "selection-metadata.json", "PROVENANCE.md"])
			expect(paths.has(prefix + file), file).toBe(true);
		for (const entry of catalog) {
			for (const file of entry.licenseFiles) expect(paths.has(prefix + file), file).toBe(true);
			expect(paths.has(`${prefix}metadata/${entry.id}.pb`)).toBe(true);
			for (const face of entry.faces) expect(paths.has(prefix + face.file)).toBe(false);
		}
	}, 30_000);
});
