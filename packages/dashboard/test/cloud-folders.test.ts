import type { Dir, Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse } from "node:path";
import { CloudWorkspaceError } from "@dreb/coding-agent/cloud-workspaces";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browseCloudFolders } from "../src/server/cloud-folders.js";

// Keep real native filesystem behavior, with narrow stream/failure injection below.
vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));

let root: string;
beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "dreb-cloud-folders-")));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(root, { recursive: true, force: true });
});

function nativeError(code: string): Error {
	return Object.assign(new Error("synthetic private filesystem detail"), { code });
}

function entry(name: string, kind: "directory" | "file" | "symlink" = "directory"): Dirent {
	return {
		name,
		isDirectory: vi.fn(() => kind === "directory"),
		isSymbolicLink: vi.fn(() => kind === "symlink"),
	} as unknown as Dirent;
}

/** A Dir-like streaming iterator: records fetched entries and closes even on abrupt exits. */
function injectStream(target: string, entries: Iterable<Dirent>, failure?: Error) {
	const fetched = vi.fn();
	const closed = vi.fn();
	const directory = {
		async *[Symbol.asyncIterator]() {
			try {
				for (const value of entries) {
					fetched();
					yield value;
				}
				if (failure) throw failure;
			} finally {
				closed();
			}
		},
	} as unknown as Dir;
	const open = vi.spyOn(fs, "opendir").mockImplementation(async (path) => {
		expect(String(path)).toBe(target);
		return directory;
	});
	return { fetched, closed, open };
}

function* repeatedEntries(count: number, kind: "directory" | "file") {
	for (let index = 0; index < count; index++) yield entry(`entry-${String(index).padStart(5, "0")}`, kind);
}

describe("browseCloudFolders native read-only metadata", () => {
	it("defaults only an absent path to the supplied home and returns sorted immediate folders", async () => {
		const names = ["Zulu", "alpha", "Résumé notes", " space inside"];
		if (process.platform !== "win32") names.push(" trailing space ");
		for (const name of names) await fs.mkdir(join(root, name));
		await fs.mkdir(join(root, "alpha", "not-immediate"));
		await fs.writeFile(join(root, "ordinary-file.txt"), "never read these bytes");
		const read = vi.spyOn(fs, "readFile");
		const open = vi.spyOn(fs, "open");
		const readdir = vi.spyOn(fs, "readdir");
		const stat = vi.spyOn(fs, "stat");
		const listing = await browseCloudFolders(undefined, root);
		expect(listing).toEqual({
			path: root,
			parent: dirname(root),
			entries: names.sort((a, b) => a.localeCompare(b)).map((name) => ({ name, path: join(root, name) })),
			truncated: false,
		});
		expect(isAbsolute(listing.path)).toBe(true);
		for (const child of listing.entries) expect(isAbsolute(child.path)).toBe(true);
		expect(stat).toHaveBeenCalledExactlyOnceWith(root);
		expect(read).not.toHaveBeenCalled();
		expect(open).not.toHaveBeenCalled();
		expect(readdir).not.toHaveBeenCalled();
	});

	it("returns an explicit empty directory and never falls back to the supplied home", async () => {
		const empty = join(root, "empty");
		await fs.mkdir(empty);
		expect(await browseCloudFolders(empty, join(root, "missing-home"))).toEqual({
			path: empty,
			parent: root,
			entries: [],
			truncated: false,
		});
	});

	it("includes directory symlinks but omits file and broken symlinks, and canonicalizes an opened alias", async () => {
		const target = join(root, "target");
		const alias = join(root, "alias");
		const file = join(root, "file.txt");
		await fs.mkdir(target);
		await fs.mkdir(join(target, "child"));
		await fs.writeFile(file, "private contents");
		await fs.symlink(target, alias, "dir");
		await fs.symlink(file, join(root, "file-alias"), "file");
		await fs.symlink(join(root, "missing"), join(root, "broken-alias"), "dir");
		const read = vi.spyOn(fs, "readFile");
		const stat = vi.spyOn(fs, "stat");
		expect((await browseCloudFolders(root, root)).entries).toEqual([
			{ name: "alias", path: alias },
			{ name: "target", path: target },
		]);
		expect(stat.mock.calls.map(([path]) => String(path))).not.toContain(file);
		expect(await browseCloudFolders(alias, root)).toEqual({
			path: target,
			parent: root,
			entries: [{ name: "child", path: join(target, "child") }],
			truncated: false,
		});
		expect(read).not.toHaveBeenCalled();
	});

	it.each(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"])(
		"skips a broken/unreadable symlink with %s while retaining other directories",
		async (code) => {
			const link = join(root, "unavailable-alias");
			await fs.symlink(root, link, "dir");
			await fs.mkdir(join(root, "available"));
			const stat = fs.stat;
			vi.spyOn(fs, "stat").mockImplementation(async (path, options) => {
				if (String(path) === link) throw nativeError(code);
				return stat(path, options);
			});
			expect((await browseCloudFolders(root, root)).entries).toEqual([
				{ name: "available", path: join(root, "available") },
			]);
		},
	);

	it("uses the native root parent rule without enumerating the host root", async () => {
		const nativeRoot = parse(root).root;
		const stream = injectStream(nativeRoot, []);
		expect(await browseCloudFolders(nativeRoot, root)).toEqual({
			path: nativeRoot,
			parent: null,
			entries: [],
			truncated: false,
		});
		expect(dirname(nativeRoot)).toBe(nativeRoot);
		expect(stream.closed).toHaveBeenCalledOnce();
	});

	it("breaks locale-equal names by deterministic raw name order", async () => {
		const names = ["é", "e\u0301", "Zulu", "alpha"];
		expect(names[0].localeCompare(names[1])).toBe(0);
		injectStream(
			root,
			names.map((name) => entry(name)),
		);
		expect((await browseCloudFolders(root, root)).entries.map(({ name }) => name)).toEqual([
			"alpha",
			"e\u0301",
			"é",
			"Zulu",
		]);
	});

	it.skipIf(process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0))(
		"reports a real directory lacking read/search permission",
		async () => {
			const denied = join(root, "denied");
			await fs.mkdir(denied);
			try {
				await fs.chmod(denied, 0o000);
				await expect(browseCloudFolders(denied, root)).rejects.toMatchObject({ code: "UNAVAILABLE" });
			} finally {
				await fs.chmod(denied, 0o700);
			}
		},
	);
});

describe("browseCloudFolders stable errors", () => {
	it.each(["", "relative", "~/folder", "bad\0path"])("rejects invalid path %j without enumeration", async (path) => {
		const open = vi.spyOn(fs, "opendir");
		await expect(browseCloudFolders(path, root)).rejects.toMatchObject({ code: "INVALID_PATH" });
		expect(open).not.toHaveBeenCalled();
	});

	it.skipIf(process.platform === "win32")("rejects a foreign Windows path on POSIX", async () => {
		await expect(browseCloudFolders("C:\\Foreign\\Folder", root)).rejects.toMatchObject({ code: "INVALID_PATH" });
	});

	it("distinguishes missing paths, non-directories and non-directory ancestors", async () => {
		const file = join(root, "file");
		await fs.writeFile(file, "not a directory");
		await expect(browseCloudFolders(join(root, "missing"), root)).rejects.toMatchObject({ code: "UNAVAILABLE" });
		await expect(browseCloudFolders(file, root)).rejects.toMatchObject({ code: "INVALID_PATH" });
		await expect(browseCloudFolders(join(file, "child"), root)).rejects.toMatchObject({ code: "INVALID_PATH" });
		await expect(browseCloudFolders(undefined, join(root, "missing-home"))).rejects.toMatchObject({
			code: "UNAVAILABLE",
		});
	});

	it.each([
		["ENAMETOOLONG", "INVALID_PATH"],
		["EINVAL", "INVALID_PATH"],
		["ENOTDIR", "INVALID_PATH"],
		["ENOENT", "UNAVAILABLE"],
		["EACCES", "UNAVAILABLE"],
		["EPERM", "UNAVAILABLE"],
		["EIO", "IO_ERROR"],
	] as const)("classifies a wrapped native %s failure as %s", async (code, expected) => {
		vi.spyOn(fs, "realpath").mockRejectedValueOnce(nativeError(code));
		await expect(browseCloudFolders(root, root)).rejects.toMatchObject({ code: expected });
	});

	it("classifies search-denied validation separately from unexpected stat failures", async () => {
		const access = vi.spyOn(fs, "access").mockRejectedValueOnce(nativeError("EACCES"));
		await expect(browseCloudFolders(root, root)).rejects.toMatchObject({ code: "UNAVAILABLE" });
		access.mockRestore();
		vi.spyOn(fs, "stat").mockRejectedValueOnce(nativeError("EIO"));
		await expect(browseCloudFolders(root, root)).rejects.toMatchObject({ code: "IO_ERROR" });
	});

	it.each([
		["ENOENT", "UNAVAILABLE"],
		["EACCES", "UNAVAILABLE"],
		["ENOTDIR", "INVALID_PATH"],
		["EINVAL", "INVALID_PATH"],
		["EIO", "IO_ERROR"],
	] as const)("classifies an opendir %s race as %s", async (code, expected) => {
		vi.spyOn(fs, "opendir").mockRejectedValueOnce(nativeError(code));
		await expect(browseCloudFolders(root, root)).rejects.toMatchObject({ code: expected });
	});

	it.each(["realpath", "stat", "access"] as const)(
		"does not mistake an unknown wrapped %s failure for an unavailable path",
		async (operation) => {
			vi.spyOn(fs, operation).mockRejectedValueOnce(new Error("private unexpected validator failure"));
			await expect(browseCloudFolders(root, root)).rejects.toMatchObject({ code: "IO_ERROR" });
		},
	);

	it("does not leak unknown error details or return an empty listing on I/O failure", async () => {
		vi.spyOn(fs, "opendir").mockRejectedValueOnce(new Error("private unknown error details"));
		const error = await browseCloudFolders(root, root).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(CloudWorkspaceError);
		expect(error).toMatchObject({
			code: "IO_ERROR",
			message: "Could not browse folders on the backend host. Check storage permissions and retry.",
		});
		expect((error as Error).message).not.toContain("private");
	});
});

describe("browseCloudFolders honest streaming limits and resource cleanup", () => {
	it.each([499, 500, 501, 900])("bounds %i folders at 500 and detects the next folder", async (count) => {
		const stream = injectStream(root, repeatedEntries(count, "directory"));
		const listing = await browseCloudFolders(root, root);
		expect(listing.entries).toHaveLength(Math.min(count, 500));
		expect(listing.truncated).toBe(count > 500);
		expect(stream.fetched).toHaveBeenCalledTimes(Math.min(count, 501));
		expect(stream.closed).toHaveBeenCalledOnce();
	});

	it("does not claim truncation for 500 folders followed only by regular files", async () => {
		const stream = injectStream(root, [...repeatedEntries(500, "directory"), ...repeatedEntries(40, "file")]);
		const stat = vi.spyOn(fs, "stat");
		const listing = await browseCloudFolders(root, root);
		expect(listing.entries).toHaveLength(500);
		expect(listing.truncated).toBe(false);
		expect(stream.fetched).toHaveBeenCalledTimes(540);
		expect(stat).toHaveBeenCalledExactlyOnceWith(root);
		expect(stream.closed).toHaveBeenCalledOnce();
	});

	it.each([9999, 10_000, 10_001, 15_000])("inspects at most 10000 of %i dirents", async (count) => {
		const candidate = entry("regular-file", "file");
		function* entries() {
			for (let index = 0; index < count; index++) yield candidate;
		}
		const stream = injectStream(root, entries());
		const stat = vi.spyOn(fs, "stat");
		const listing = await browseCloudFolders(root, root);
		expect(listing.entries).toEqual([]);
		expect(listing.truncated).toBe(count > 10_000);
		expect(candidate.isDirectory).toHaveBeenCalledTimes(Math.min(count, 10_000));
		expect(candidate.isSymbolicLink).toHaveBeenCalledTimes(Math.min(count, 10_000));
		expect(stream.fetched).toHaveBeenCalledTimes(Math.min(count, 10_001));
		expect(stat).toHaveBeenCalledExactlyOnceWith(root);
		expect(stream.closed).toHaveBeenCalledOnce();
	});

	it("retains bounded partial folders but does not inspect a folder beyond the inspection limit", async () => {
		const uninspected = entry("beyond-limit");
		const stream = injectStream(root, [
			...repeatedEntries(499, "directory"),
			...repeatedEntries(9501, "file"),
			uninspected,
		]);
		const listing = await browseCloudFolders(root, root);
		expect(listing.entries).toHaveLength(499);
		expect(listing.truncated).toBe(true);
		expect(uninspected.isDirectory).not.toHaveBeenCalled();
		expect(uninspected.isSymbolicLink).not.toHaveBeenCalled();
		expect(stream.closed).toHaveBeenCalledOnce();
	});

	it("closes on iterator read errors without returning a misleading partial success", async () => {
		const stream = injectStream(root, [entry("before-error")], nativeError("EIO"));
		await expect(browseCloudFolders(root, root)).rejects.toMatchObject({ code: "IO_ERROR" });
		expect(stream.closed).toHaveBeenCalledOnce();
	});

	it("closes on unexpected symlink-stat errors instead of silently skipping them", async () => {
		const stream = injectStream(root, [entry("alias", "symlink")]);
		const stat = fs.stat;
		vi.spyOn(fs, "stat").mockImplementation(async (path, options) => {
			if (String(path) === join(root, "alias")) throw nativeError("EIO");
			return stat(path, options);
		});
		await expect(browseCloudFolders(root, root)).rejects.toMatchObject({ code: "IO_ERROR" });
		expect(stream.closed).toHaveBeenCalledOnce();
	});

	it("closes a real native Dir after normal enumeration", async () => {
		await fs.mkdir(join(root, "child"));
		const directory = await fs.opendir(root);
		vi.spyOn(fs, "opendir").mockResolvedValueOnce(directory);
		expect((await browseCloudFolders(root, root)).entries).toHaveLength(1);
		await expect(directory.read()).rejects.toMatchObject({ code: "ERR_DIR_CLOSED" });
	});

	it("closes a real native Dir on an early result-limit break", async () => {
		for (let index = 0; index < 501; index++) await fs.mkdir(join(root, `folder-${index}`));
		const directory = await fs.opendir(root);
		vi.spyOn(fs, "opendir").mockResolvedValueOnce(directory);
		const listing = await browseCloudFolders(root, root);
		expect(listing.entries).toHaveLength(500);
		expect(listing.truncated).toBe(true);
		await expect(directory.read()).rejects.toMatchObject({ code: "ERR_DIR_CLOSED" });
	});
});
