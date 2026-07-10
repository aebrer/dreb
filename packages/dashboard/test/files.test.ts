import { mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalizePath, FileApi } from "../src/server/files.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	// realpath: macOS tmpdir() returns /var/... which symlinks to /private/var,
	// while FileApi resolves paths via realpath — compare like with like.
	const dir = await realpath(await mkdtemp(join(tmpdir(), "dreb-dash-files-")));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("canonicalizePath", () => {
	it("resolves an existing absolute path", async () => {
		const dir = await makeTempDir();
		await expect(canonicalizePath(dir, { mustExist: true })).resolves.toBeTruthy();
	});

	it("rejects relative paths", async () => {
		await expect(canonicalizePath("relative/path", { mustExist: true })).rejects.toMatchObject({ status: 400 });
	});

	it("rejects empty paths", async () => {
		await expect(canonicalizePath("", { mustExist: true })).rejects.toMatchObject({ status: 400 });
	});

	it("rejects null bytes", async () => {
		await expect(canonicalizePath("/tmp/x\0y", { mustExist: true })).rejects.toMatchObject({ status: 400 });
	});

	it("rejects lingering percent-encoded traversal sequences", async () => {
		await expect(canonicalizePath("/tmp/%2e%2e/etc", { mustExist: true })).rejects.toMatchObject({ status: 400 });
		await expect(canonicalizePath("/tmp/%2Fescape", { mustExist: true })).rejects.toMatchObject({ status: 400 });
		await expect(canonicalizePath("/tmp/%00", { mustExist: true })).rejects.toMatchObject({ status: 400 });
	});

	it("404s on nonexistent paths when mustExist", async () => {
		await expect(canonicalizePath("/definitely/not/a/real/path/xyz", { mustExist: true })).rejects.toMatchObject({
			status: 404,
		});
	});

	it("resolves symlinks to their real path", async () => {
		const dir = await makeTempDir();
		await writeFile(join(dir, "real.txt"), "hello");
		await symlink(join(dir, "real.txt"), join(dir, "link.txt"));
		const resolved = await canonicalizePath(join(dir, "link.txt"), { mustExist: true });
		expect(resolved.endsWith("real.txt")).toBe(true);
	});

	it("normalizes .. traversal to the real target (no jail — canonicalization only)", async () => {
		const dir = await makeTempDir();
		const resolved = await canonicalizePath(join(dir, "sub", ".."), { mustExist: true });
		// realpath(tmpdir) may differ from tmpdir on macOS (/private prefix); compare suffix.
		expect(resolved.endsWith(dir.split("/").pop()!)).toBe(true);
	});

	it("for creation targets resolves the parent and validates the leaf", async () => {
		const dir = await makeTempDir();
		const resolved = await canonicalizePath(join(dir, "new-file.txt"), { mustExist: false });
		expect(resolved.endsWith("new-file.txt")).toBe(true);
		await expect(canonicalizePath(join(dir, "nonexistent-sub", "x.txt"), { mustExist: false })).rejects.toMatchObject(
			{ status: 404 },
		);
	});
});

describe("FileApi", () => {
	function makeApi() {
		const log = vi.fn();
		return { api: new FileApi(log), log };
	}

	it("lists a directory with types and logs the operation", async () => {
		const dir = await makeTempDir();
		await writeFile(join(dir, "a.txt"), "aa");
		const { api, log } = makeApi();
		const listing = await api.list(dir);
		expect(listing.entries.map((e) => e.name)).toContain("a.txt");
		expect(listing.entries.find((e) => e.name === "a.txt")?.type).toBe("file");
		expect(log).toHaveBeenCalledWith("list", expect.any(String));
	});
	it("refuses to list a file", async () => {
		const dir = await makeTempDir();
		await writeFile(join(dir, "a.txt"), "aa");
		const { api } = makeApi();
		await expect(api.list(join(dir, "a.txt"))).rejects.toMatchObject({ status: 400 });
	});

	it("download resolves only files", async () => {
		const dir = await makeTempDir();
		await writeFile(join(dir, "a.txt"), "aa");
		const { api } = makeApi();
		await expect(api.resolveDownload(join(dir, "a.txt"))).resolves.toMatchObject({ size: 2 });
		await expect(api.resolveDownload(dir)).rejects.toMatchObject({ status: 400 });
	});

	it("upload collision returns 409 without overwrite, succeeds with it", async () => {
		const dir = await makeTempDir();
		await writeFile(join(dir, "exists.txt"), "old");
		const { api } = makeApi();
		await expect(api.prepareUpload(dir, "exists.txt", false)).rejects.toMatchObject({ status: 409 });
		const { path, stream, commit } = await api.prepareUpload(dir, "exists.txt", true);
		expect(path).toBe(join(dir, "exists.txt"));
		await new Promise<void>((resolve, reject) => {
			stream.on("finish", () => resolve());
			stream.on("error", reject);
			stream.end("new");
		});
		await commit();
		expect(await readFile(join(dir, "exists.txt"), "utf8")).toBe("new");
	});

	it("upload commit refuses a no-overwrite race and removes the temp file", async () => {
		const dir = await makeTempDir();
		const { api } = makeApi();
		const { stream, commit } = await api.prepareUpload(dir, "race.txt", false);
		await new Promise<void>((resolve, reject) => {
			stream.on("finish", () => resolve());
			stream.on("error", reject);
			stream.end("uploaded");
		});
		await writeFile(join(dir, "race.txt"), "winner");

		await expect(commit()).rejects.toMatchObject({ status: 409 });
		expect(await readFile(join(dir, "race.txt"), "utf8")).toBe("winner");
		expect((await readdir(dir)).filter((name) => name.startsWith(".dreb-upload-"))).toEqual([]);
	});

	it("upload rejects path-like file names", async () => {
		const dir = await makeTempDir();
		const { api } = makeApi();
		await expect(api.prepareUpload(dir, "../escape.txt", false)).rejects.toMatchObject({ status: 400 });
		await expect(api.prepareUpload(dir, "a/b.txt", false)).rejects.toMatchObject({ status: 400 });
		await expect(api.prepareUpload(dir, "..", false)).rejects.toMatchObject({ status: 400 });
	});

	it("mkdir creates and rejects path-like names", async () => {
		const dir = await makeTempDir();
		const { api } = makeApi();
		const created = await api.mkdir(dir, "newdir");
		expect(created).toBe(join(dir, "newdir"));
		await expect(api.mkdir(dir, "../up")).rejects.toMatchObject({ status: 400 });
		await expect(api.mkdir(dir, "a/b")).rejects.toMatchObject({ status: 400 });
	});
});
