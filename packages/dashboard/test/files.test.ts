import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileApi } from "../src/files.js";

async function tempDir(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

describe("FileApi", () => {
	it("lists roots and browses directories", async () => {
		const root = await tempDir("dreb-dashboard-files-");
		await writeFile(join(root, "hello.txt"), "hello");
		const api = new FileApi({ cwd: root, homeDir: root });

		expect(api.listRoots()).toEqual([{ id: "cwd", label: "Current project", path: root }]);
		const result = await api.browse("cwd", ".");
		expect(result.entries.map((entry) => entry.name)).toContain("hello.txt");
	});

	it("uploads and downloads bytes inside the selected root", async () => {
		const root = await tempDir("dreb-dashboard-files-");
		const api = new FileApi({ cwd: root, homeDir: root, maxUploadBytes: 100, maxDownloadBytes: 100 });

		await expect(api.upload("cwd", ".", "note.bin", Buffer.from([0, 1, 2]))).resolves.toEqual({
			path: "note.bin",
			size: 3,
		});
		expect(await readFile(join(root, "note.bin"))).toEqual(Buffer.from([0, 1, 2]));

		const download = await api.download("cwd", "note.bin");
		expect(download.size).toBe(3);
		expect(download.filename).toBe("note.bin");
	});

	it("rejects traversal, unsafe filenames, symlink escapes, and oversized bodies", async () => {
		const root = await tempDir("dreb-dashboard-files-");
		const outside = await tempDir("dreb-dashboard-outside-");
		await writeFile(join(outside, "secret.txt"), "secret");
		await symlink(outside, join(root, "escape"));
		const api = new FileApi({ cwd: root, homeDir: root, maxUploadBytes: 3 });

		await expect(api.browse("cwd", "../")).rejects.toMatchObject({ status: 403 });
		await expect(api.download("cwd", "escape/secret.txt")).rejects.toMatchObject({ status: 403 });
		await expect(api.upload("cwd", ".", "../evil.txt", Buffer.from("x"))).rejects.toMatchObject({ status: 400 });
		await expect(api.upload("cwd", ".", "big.txt", Buffer.from("toolong"))).rejects.toMatchObject({ status: 413 });
	});
});
