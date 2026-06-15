/**
 * Tests for RpcClient spawn-option handling (issue 279).
 *
 * Verifies that optional `uid`/`gid` are:
 *  - omitted from the spawn options object when unset (default unchanged), and
 *  - forwarded verbatim when set,
 * and that asynchronous spawn failures (the 'error' event — e.g. EPERM when a
 * non-privileged parent tries to drop to a uid/gid) surface loudly through
 * `start()` and reject in-flight requests rather than crashing or hanging.
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: vi.fn(),
	};
});

type FakeChild = ReturnType<typeof spawn> & {
	stdout: PassThrough;
	stderr: PassThrough;
	stdin: PassThrough;
	exitCode: number | null;
};

function makeFakeChild(): FakeChild {
	const proc = new EventEmitter() as FakeChild;
	proc.stdout = new PassThrough();
	proc.stderr = new PassThrough();
	proc.stdin = new PassThrough();
	proc.exitCode = null;
	proc.kill = vi.fn(() => {
		proc.exitCode = 0;
		process.nextTick(() => proc.emit("exit", 0, null));
		return true;
	}) as unknown as FakeChild["kill"];
	return proc;
}

/** Options object passed as the third argument to spawn(). */
function lastSpawnOptions(): Record<string, unknown> {
	const calls = vi.mocked(spawn).mock.calls;
	return calls[calls.length - 1][2] as Record<string, unknown>;
}

beforeEach(() => {
	vi.mocked(spawn).mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("RpcClient spawn uid/gid forwarding", () => {
	test("omits uid/gid from spawn options when unset", async () => {
		const child = makeFakeChild();
		vi.mocked(spawn).mockReturnValue(child);

		const client = new RpcClient({ cliPath: "dist/cli.js" });
		await client.start();

		const opts = lastSpawnOptions();
		expect(opts).not.toHaveProperty("uid");
		expect(opts).not.toHaveProperty("gid");

		await client.stop();
	});

	test("forwards uid and gid to spawn when set", async () => {
		const child = makeFakeChild();
		vi.mocked(spawn).mockReturnValue(child);

		const client = new RpcClient({ cliPath: "dist/cli.js", uid: 1234, gid: 5678 });
		await client.start();

		const opts = lastSpawnOptions();
		expect(opts.uid).toBe(1234);
		expect(opts.gid).toBe(5678);

		await client.stop();
	});

	test("forwards uid alone without injecting gid", async () => {
		const child = makeFakeChild();
		vi.mocked(spawn).mockReturnValue(child);

		const client = new RpcClient({ cliPath: "dist/cli.js", uid: 1000 });
		await client.start();

		const opts = lastSpawnOptions();
		expect(opts.uid).toBe(1000);
		expect(opts).not.toHaveProperty("gid");

		await client.stop();
	});
});

describe("RpcClient spawn failure handling", () => {
	test("start() rejects loudly when the child emits an 'error' (e.g. EPERM)", async () => {
		const child = makeFakeChild();
		vi.mocked(spawn).mockReturnValue(child);

		const client = new RpcClient({ cliPath: "dist/cli.js", uid: 1234 });
		// The spawn failure surfaces asynchronously after start() has attached its
		// 'error' listener.
		process.nextTick(() => child.emit("error", new Error("EACCES: setuid not permitted")));

		await expect(client.start()).rejects.toThrow(/failed to spawn/i);
	});

	test("in-flight requests reject when the child emits an 'error'", async () => {
		const child = makeFakeChild();
		vi.mocked(spawn).mockReturnValue(child);

		const client = new RpcClient({ cliPath: "dist/cli.js" });
		await client.start();

		const pending = client.getState();
		child.emit("error", new Error("boom"));

		await expect(pending).rejects.toThrow(/failed to spawn/i);
	});

	test("a spawn 'error' after start() resolves surfaces loudly on the next call", async () => {
		// The race in start() resolves once the grace window elapses with the child
		// alive. A spawn/runtime 'error' that arrives later must still fail loudly:
		// the client is marked dead and the next request rejects with the real
		// cause rather than hanging or silently running.
		const child = makeFakeChild();
		vi.mocked(spawn).mockReturnValue(child);

		const client = new RpcClient({ cliPath: "dist/cli.js", uid: 1234 });
		await client.start();

		child.emit("error", new Error("EACCES: setuid not permitted"));

		// Subsequent calls reject loudly and carry the captured cause.
		await expect(client.getState()).rejects.toThrow(/not running.*setuid not permitted/i);
	});

	test("in-flight requests reject when the child emits 'exit'", async () => {
		// Sibling path to the 'error' case: a process that crashes mid-request must
		// reject the pending call with the exit reason, not leave it hanging.
		const child = makeFakeChild();
		vi.mocked(spawn).mockReturnValue(child);

		const client = new RpcClient({ cliPath: "dist/cli.js" });
		await client.start();

		const pending = client.getState();
		child.exitCode = 1;
		child.emit("exit", 1, "SIGKILL");

		await expect(pending).rejects.toThrow(/exited with code 1/i);
	});
});
