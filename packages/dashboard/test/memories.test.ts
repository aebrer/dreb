import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_MEMORY_CONTENT_BYTES, MemoryApi } from "../src/server/memories.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "dreb-dash-memory-")));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeProject(name: string): Promise<string> {
	const root = join(await tempDir(), name);
	await mkdir(join(root, ".git"), { recursive: true });
	await mkdir(join(root, ".dreb", "memory"), { recursive: true });
	return root;
}

function entry(name = "alpha", type = "project"): string {
	return `---\nname: ${name}\ndescription: ${name} desc\ntype: ${type}\n---\n\nBody ${name}\n`;
}

describe("MemoryApi", () => {
	it("discovers global and project scopes with dedupe and stable ordering", async () => {
		const home = await tempDir();
		await mkdir(join(home, ".dreb", "memory"), { recursive: true });
		await mkdir(join(home, ".git"), { recursive: true });
		const b = await makeProject("b-project");
		const a = await makeProject("a-project");
		await writeFile(join(a, ".dreb", "memory", "MEMORY.md"), "# A\n");
		await writeFile(join(b, ".dreb", "memory", "b.md"), entry("B"));
		await mkdir(join(a, "src"), { recursive: true });
		const aAlias = join(await tempDir(), "a-alias");
		await symlink(a, aAlias);
		const api = new MemoryApi(home, vi.fn());

		const scopes = await api.scopes([home, join(b, "missing"), b, join(a, "src"), a, aAlias]);

		expect(scopes.map((scope) => scope.kind)).toEqual(["global", "project", "project"]);
		expect(scopes.slice(1).map((scope) => scope.projectRoot)).toEqual(
			[a, b].sort((left, right) => left.localeCompare(right)),
		);
		expect(new Set(scopes.map((scope) => scope.id)).size).toBe(scopes.length);
		expect(new Set(scopes.map((scope) => scope.memoryDir)).size).toBe(scopes.length);
	});

	it("omits project scopes whose memory directory is missing or empty", async () => {
		const home = await tempDir();
		const missing = join(await tempDir(), "missing-memory");
		await mkdir(join(missing, ".git"), { recursive: true });
		const empty = await makeProject("empty-memory");
		const populated = await makeProject("populated-memory");
		await writeFile(join(populated, ".dreb", "memory", "MEMORY.md"), "# Project memory\n");
		const api = new MemoryApi(home, vi.fn());

		const scopes = await api.scopes([missing, empty, populated]);

		expect(scopes.map((scope) => scope.kind)).toEqual(["global", "project"]);
		expect(scopes[1]?.projectRoot).toBe(populated);
	});

	it("lists missing directories without creating them and flags long complete indexes", async () => {
		const home = await tempDir();
		const api = new MemoryApi(home, vi.fn());
		const missing = await api.listing("global", []);
		expect(missing.indexContent).toBeNull();
		expect(missing.entries).toEqual([]);
		expect(await readdir(home)).toEqual([]);

		await mkdir(join(home, ".dreb", "memory"), { recursive: true });
		await writeFile(
			join(home, ".dreb", "memory", "MEMORY.md"),
			Array.from({ length: 201 }, (_, i) => `line ${i}`).join("\n"),
		);
		const listing = await api.listing("global", []);
		expect(listing.indexContent?.split("\n")).toHaveLength(201);
		expect(listing.indexOverLimit).toBe(true);
	});

	it("enforces the content limit at the exact byte boundary for reads and saves", async () => {
		const home = await tempDir();
		const memory = join(home, ".dreb", "memory");
		await mkdir(memory, { recursive: true });
		const base = entry("Boundary");
		const atLimit = `${base}${"x".repeat(MAX_MEMORY_CONTENT_BYTES - Buffer.byteLength(base))}`;
		await writeFile(join(memory, "boundary.md"), atLimit);
		const api = new MemoryApi(home, vi.fn());

		const document = await api.readDocument("global", "boundary.md", []);
		expect(Buffer.byteLength(document.content)).toBe(MAX_MEMORY_CONTENT_BYTES);
		await api.saveDocument("global", "boundary.md", { content: atLimit, revision: document.revision }, []);
		await expect(
			api.saveDocument("global", "boundary.md", { content: `${atLimit}x`, revision: document.revision }, []),
		).rejects.toMatchObject({ status: 413 });

		await writeFile(join(memory, "oversized.md"), `${atLimit}x`);
		await expect(api.readDocument("global", "oversized.md", [])).rejects.toMatchObject({ status: 413 });
	});

	it("surfaces malformed metadata while accepting valid entry summaries", async () => {
		const home = await tempDir();
		const memory = join(home, ".dreb", "memory");
		await mkdir(memory, { recursive: true });
		await writeFile(join(memory, "good.md"), entry("Good", "navigation"));
		await writeFile(join(memory, "bad.md"), "---\nname: Bad\ntype: nope\n---\nbody");
		const api = new MemoryApi(home, vi.fn());

		const listing = await api.listing("global", []);
		expect(listing.entries.map((item) => item.file)).toEqual(["bad.md", "good.md"]);
		expect(listing.entries.find((item) => item.file === "good.md")?.metadata).toMatchObject({ type: "navigation" });
		expect(listing.entries.find((item) => item.file === "bad.md")?.metadataError).toContain(
			"frontmatter.description",
		);
	});

	it("rejects traversal, invalid names, and entry or index symlink escapes", async () => {
		const home = await tempDir();
		const memory = join(home, ".dreb", "memory");
		await mkdir(memory, { recursive: true });
		await writeFile(join(memory, "good.md"), entry());
		const outside = join(home, "outside.md");
		await writeFile(outside, entry("Outside"));
		await symlink(outside, join(memory, "link.md"));
		const outsideIndex = join(home, "outside-index.md");
		await writeFile(outsideIndex, "- [Good](good.md) — outside\n");
		await symlink(outsideIndex, join(memory, "MEMORY.md"));
		const api = new MemoryApi(home, vi.fn());

		await expect(api.readDocument("global", "../outside.md", [])).rejects.toMatchObject({ status: 400 });
		await expect(api.readDocument("global", ".hidden.md", [])).rejects.toMatchObject({ status: 400 });
		await expect(api.readDocument("global", "link.md", [])).rejects.toMatchObject({ status: 400 });
		await expect(api.listing("global", [])).rejects.toMatchObject({ status: 400 });
		const doc = await api.readDocument("global", "good.md", []);
		await expect(
			api.deleteEntry("global", "good.md", { revision: doc.revision, indexRevision: null }, []),
		).rejects.toMatchObject({ status: 400 });
		expect(await readFile(outsideIndex, "utf8")).toContain("[Good](good.md)");
	});

	it("enforces revisions and entry metadata validation on save", async () => {
		const home = await tempDir();
		const memory = join(home, ".dreb", "memory");
		await mkdir(memory, { recursive: true });
		await writeFile(join(memory, "MEMORY.md"), "# Memory\n");
		await writeFile(join(memory, "good.md"), entry());
		const api = new MemoryApi(home, vi.fn());
		const doc = await api.readDocument("global", "good.md", []);

		await expect(
			api.saveDocument("global", "good.md", { content: entry("New"), revision: "stale" }, []),
		).rejects.toMatchObject({ status: 409 });
		await expect(
			api.saveDocument("global", "good.md", { content: "no frontmatter", revision: doc.revision }, []),
		).rejects.toMatchObject({ status: 400 });
		await api.saveDocument("global", "good.md", { content: entry("New"), revision: doc.revision }, []);
		expect(await readFile(join(memory, "good.md"), "utf8")).toContain("name: New");
		expect((await readdir(memory)).filter((name) => name.startsWith(".dreb-memory-"))).toEqual([]);
	});

	it("deletes entries only after synchronized index cleanup and preserves unrelated formatting", async () => {
		const home = await tempDir();
		const memory = join(home, ".dreb", "memory");
		await mkdir(memory, { recursive: true });
		await writeFile(join(memory, "delete.md"), entry("Delete"));
		await writeFile(join(memory, "keep.md"), entry("Keep"));
		const index = "# Memory\r\n\r\n- [Delete](delete.md) — remove me\r\n- [Keep](keep.md) — keep me\r\n";
		await writeFile(join(memory, "MEMORY.md"), index);
		const api = new MemoryApi(home, vi.fn());
		const doc = await api.readDocument("global", "delete.md", []);
		const listing = await api.listing("global", []);

		await api.deleteEntry(
			"global",
			"delete.md",
			{ revision: doc.revision, indexRevision: listing.indexRevision },
			[],
		);

		await expect(readFile(join(memory, "delete.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		const updated = await readFile(join(memory, "MEMORY.md"), "utf8");
		expect(updated).toBe("# Memory\r\n\r\n- [Keep](keep.md) — keep me\r\n");
	});

	it("allows no-index and unindexed deletes, and rejects unsafe index rewrites loudly", async () => {
		const home = await tempDir();
		const memory = join(home, ".dreb", "memory");
		await mkdir(memory, { recursive: true });
		await writeFile(join(memory, "loose.md"), entry("Loose"));
		const api = new MemoryApi(home, vi.fn());
		let doc = await api.readDocument("global", "loose.md", []);
		await api.deleteEntry("global", "loose.md", { revision: doc.revision, indexRevision: null }, []);

		await writeFile(join(memory, "unsafe.md"), entry("Unsafe"));
		await writeFile(join(memory, "MEMORY.md"), "prefix [Unsafe](unsafe.md) suffix\n");
		doc = await api.readDocument("global", "unsafe.md", []);
		const listing = await api.listing("global", []);
		await expect(
			api.deleteEntry("global", "unsafe.md", { revision: doc.revision, indexRevision: listing.indexRevision }, []),
		).rejects.toMatchObject({ status: 409 });
		expect(await readFile(join(memory, "unsafe.md"), "utf8")).toContain("Unsafe");
	});
});
