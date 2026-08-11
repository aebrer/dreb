import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	DashboardAuth,
	isAllowedLocalHost,
	isLoopbackAddress,
	MemoryPairingStorage,
	normalizeAddress,
	type TailscaleIdentity,
	type TailscaleResolver,
	TailscaleResolverError,
	TailscaleWhoisResolver,
} from "../src/server/auth.js";
import { FilePairingStorage, loadOrCreateDashboardSecret } from "../src/server/pairing-storage.js";

class StubResolver implements TailscaleResolver {
	constructor(private readonly map: Record<string, TailscaleIdentity | null> = {}) {}
	async resolve(address: string): Promise<TailscaleIdentity | null> {
		if (address in this.map) return this.map[address];
		return null;
	}
}

class ThrowingResolver implements TailscaleResolver {
	async resolve(): Promise<TailscaleIdentity | null> {
		throw new Error("resolver exploded");
	}
}

class ThrowingStorage extends MemoryPairingStorage {
	override async load(): Promise<never> {
		throw new Error("storage exploded");
	}
}

const LOCAL_REQUEST = {
	remoteAddress: "127.0.0.1",
	hostHeader: "127.0.0.1:5343",
	originHeader: undefined,
	deviceToken: undefined,
};

describe("address helpers", () => {
	it("normalizes IPv6-mapped IPv4 and zone indices", () => {
		expect(normalizeAddress("::ffff:127.0.0.1")).toBe("127.0.0.1");
		expect(normalizeAddress("fe80::1%eth0")).toBe("fe80::1");
		expect(normalizeAddress("[::1]")).toBe("::1");
		expect(normalizeAddress(undefined)).toBe("");
	});

	it("identifies loopback addresses", () => {
		expect(isLoopbackAddress("127.0.0.1")).toBe(true);
		expect(isLoopbackAddress("127.1.2.3")).toBe(true);
		expect(isLoopbackAddress("::1")).toBe(true);
		expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
		expect(isLoopbackAddress("192.168.1.5")).toBe(false);
		expect(isLoopbackAddress("100.64.0.1")).toBe(false);
		expect(isLoopbackAddress(undefined)).toBe(false);
	});

	it("validates local Host headers (DNS-rebinding defense)", () => {
		expect(isAllowedLocalHost("localhost")).toBe(true);
		expect(isAllowedLocalHost("localhost:5343")).toBe(true);
		expect(isAllowedLocalHost("127.0.0.1:5343")).toBe(true);
		expect(isAllowedLocalHost("[::1]:5343")).toBe(true);
		expect(isAllowedLocalHost("evil.example.com")).toBe(false);
		expect(isAllowedLocalHost("evil.example.com:5343")).toBe(false);
		expect(isAllowedLocalHost("127.0.0.1.evil.com")).toBe(false);
		expect(isAllowedLocalHost(undefined)).toBe(false);
		expect(isAllowedLocalHost("")).toBe(false);
	});
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("TailscaleWhoisResolver", () => {
	it("single-flights concurrent normalized peers without caching completed results", async () => {
		const pending = deferred<{ stdout: string }>();
		const runner = vi.fn(async (_address: string) => pending.promise);
		const resolver = new TailscaleWhoisResolver(runner);

		const first = resolver.resolve("::ffff:100.64.0.9");
		const second = resolver.resolve("100.64.0.9");
		await Promise.resolve();
		expect(runner).toHaveBeenCalledOnce();
		expect(runner).toHaveBeenCalledWith("100.64.0.9");

		pending.resolve({
			stdout: JSON.stringify({
				Node: { Name: "phone.tailnet.ts.net." },
				UserProfile: { LoginName: "alice@example.com" },
			}),
		});
		await expect(first).resolves.toEqual({ loginName: "alice@example.com", device: "phone.tailnet.ts.net" });
		await expect(second).resolves.toEqual({ loginName: "alice@example.com", device: "phone.tailnet.ts.net" });

		await resolver.resolve("100.64.0.9");
		expect(runner).toHaveBeenCalledTimes(2);
	});

	it("keeps different peer lookups independent", async () => {
		const pending = new Map<string, ReturnType<typeof deferred<{ stdout: string }>>>();
		const runner = vi.fn((address: string) => {
			const next = deferred<{ stdout: string }>();
			pending.set(address, next);
			return next.promise;
		});
		const resolver = new TailscaleWhoisResolver(runner);
		const first = resolver.resolve("100.64.0.1");
		const second = resolver.resolve("100.64.0.2");
		await Promise.resolve();
		expect(runner).toHaveBeenCalledTimes(2);
		for (const [address, item] of pending) {
			item.resolve({
				stdout: JSON.stringify({ Node: { Name: address }, UserProfile: { LoginName: `${address}@test` } }),
			});
		}
		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
	});

	it("returns null only for clean peer-not-found or a response without a login identity", async () => {
		const notFound = new TailscaleWhoisResolver(async () => {
			throw Object.assign(new Error("command failed"), { stderr: "peer not found\n" });
		});
		await expect(notFound.resolve("100.64.0.9")).resolves.toBeNull();

		const noIdentity = new TailscaleWhoisResolver(async () => ({
			stdout: JSON.stringify({ Node: { Name: "tagged-node" }, UserProfile: null }),
		}));
		await expect(noIdentity.resolve("100.64.0.9")).resolves.toBeNull();
	});

	it("reports timeout, execution, parse, and schema failures distinctly and retries after failure", async () => {
		const errors = [
			{ error: Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }), kind: "timeout" },
			{ error: Object.assign(new Error("failed"), { stderr: "daemon unavailable" }), kind: "execution" },
		] as const;
		for (const item of errors) {
			const resolver = new TailscaleWhoisResolver(async () => {
				throw item.error;
			});
			await expect(resolver.resolve("100.64.0.9")).rejects.toMatchObject({ kind: item.kind });
		}

		await expect(
			new TailscaleWhoisResolver(async () => ({ stdout: "{" })).resolve("100.64.0.9"),
		).rejects.toMatchObject({ kind: "parse" });
		await expect(
			new TailscaleWhoisResolver(async () => ({ stdout: JSON.stringify({ UserProfile: {} }) })).resolve(
				"100.64.0.9",
			),
		).rejects.toMatchObject({ kind: "schema" });

		let attempts = 0;
		const retrying = new TailscaleWhoisResolver(async () => {
			attempts += 1;
			if (attempts === 1) throw Object.assign(new Error("failed"), { stderr: "daemon unavailable" });
			return { stdout: JSON.stringify({ Node: {}, UserProfile: { LoginName: "alice@example.com" } }) };
		});
		await expect(retrying.resolve("100.64.0.9")).rejects.toBeInstanceOf(TailscaleResolverError);
		await expect(retrying.resolve("100.64.0.9")).resolves.toMatchObject({ loginName: "alice@example.com" });
		expect(attempts).toBe(2);
	});
});

describe("DashboardAuth — local mode", () => {
	let auth: DashboardAuth;
	beforeEach(() => {
		auth = new DashboardAuth();
	});

	it("allows loopback requests with a loopback Host", async () => {
		const decision = await auth.authenticate(LOCAL_REQUEST);
		expect(decision).toEqual({ allowed: true, mode: "local" });
	});

	it("rejects loopback requests with a foreign Host header", async () => {
		const decision = await auth.authenticate({ ...LOCAL_REQUEST, hostHeader: "attacker.example:5343" });
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.status).toBe(403);
			expect(decision.reason).toContain("DNS-rebinding");
		}
	});

	it("rejects loopback requests with a missing Host header", async () => {
		const decision = await auth.authenticate({ ...LOCAL_REQUEST, hostHeader: undefined });
		expect(decision.allowed).toBe(false);
	});

	it("rejects loopback requests with a cross-site Origin", async () => {
		const decision = await auth.authenticate({ ...LOCAL_REQUEST, originHeader: "https://evil.example" });
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.reason).toContain("Origin");
	});

	it("allows loopback requests with a loopback Origin", async () => {
		const decision = await auth.authenticate({ ...LOCAL_REQUEST, originHeader: "http://127.0.0.1:5343" });
		expect(decision.allowed).toBe(true);
	});

	it("denies non-loopback requests when remote is disabled — no LAN mode", async () => {
		const decision = await auth.authenticate({
			remoteAddress: "192.168.1.50",
			hostHeader: "192.168.1.2:5343",
			originHeader: undefined,
			deviceToken: undefined,
		});
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.status).toBe(403);
			expect(decision.reason).toContain("disabled");
		}
	});
});

describe("DashboardAuth — remote mode", () => {
	const alice: TailscaleIdentity = { loginName: "alice@example.com", device: "phone" };
	const TEST_SECRET = Buffer.from("dashboard-auth-test-secret");
	const REMOTE = {
		remoteAddress: "100.64.0.9",
		hostHeader: "host.tailnet:5343",
		originHeader: undefined,
		deviceToken: undefined,
	};

	function makeAuth(overrides: Partial<ConstructorParameters<typeof DashboardAuth>[0]> = {}) {
		return new DashboardAuth({
			remoteEnabled: true,
			allowedIdentities: ["alice@example.com"],
			resolver: new StubResolver({ "100.64.0.9": alice, "100.64.0.66": { loginName: "mallory@example.com" } }),
			storage: new MemoryPairingStorage(),
			secret: TEST_SECRET,
			...overrides,
		});
	}

	it("denies unknown peers", async () => {
		const auth = makeAuth();
		const decision = await auth.authenticate({ ...REMOTE, remoteAddress: "100.64.0.250" });
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.reason).toContain("not a known Tailscale peer");
	});

	it("coalesces parallel page-load authentication without false unknown-peer denials", async () => {
		const pending = deferred<{ stdout: string }>();
		const runner = vi.fn(async () => pending.promise);
		const auth = makeAuth({ resolver: new TailscaleWhoisResolver(runner) });
		const decisions = [auth.authenticate(REMOTE), auth.authenticate(REMOTE), auth.authenticate(REMOTE)];
		await Promise.resolve();
		expect(runner).toHaveBeenCalledOnce();
		pending.resolve({
			stdout: JSON.stringify({ Node: { Name: "phone" }, UserProfile: { LoginName: "alice@example.com" } }),
		});
		const resolved = await Promise.all(decisions);
		expect(resolved).toHaveLength(3);
		for (const decision of resolved) {
			expect(decision).toMatchObject({ allowed: false, status: 401, needsPairing: true });
			if (!decision.allowed) expect(decision.reason).not.toContain("not a known Tailscale peer");
		}
	});

	it("denies identities not on the allowlist, naming them", async () => {
		const auth = makeAuth();
		const decision = await auth.authenticate({ ...REMOTE, remoteAddress: "100.64.0.66" });
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.reason).toContain("mallory@example.com");
	});

	it("denies everyone when the allowlist is empty (fail-closed)", async () => {
		const auth = makeAuth({ allowedIdentities: [] });
		const decision = await auth.authenticate(REMOTE);
		expect(decision.allowed).toBe(false);
	});

	it("requires pairing for allowed identities without a device token", async () => {
		const auth = makeAuth();
		const decision = await auth.authenticate(REMOTE);
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.status).toBe(401);
			expect(decision.needsPairing).toBe(true);
			expect(decision.identity?.loginName).toBe("alice@example.com");
		}
	});

	it("reports the current rotating pairing code and expiry", () => {
		let now = 1_000_000;
		const auth = makeAuth({ now: () => now });
		const first = auth.currentPairingCode();
		expect(first.code).toMatch(/^\d{6}$/);
		expect(first.expiresInMs).toBe(20_000);

		now += 30_000;
		expect(auth.currentPairingCode().code).not.toBe(first.code);
	});

	it("pairs with the current rotating code and then authenticates with the device token", async () => {
		const auth = makeAuth({ now: () => 1_000_000 });
		const { code } = auth.currentPairingCode();
		const { token, device } = await auth.pair(REMOTE, code);
		expect(device.identity).toBe("alice@example.com");

		const decision = await auth.authenticate({ ...REMOTE, deviceToken: token });
		expect(decision.allowed).toBe(true);
		if (decision.allowed && decision.mode === "remote") {
			expect(decision.identity.loginName).toBe("alice@example.com");
		}
	});

	it("defaults future pairings to 180 days and persists a validated whole-day setting", async () => {
		let now = Date.parse("2030-01-01T00:00:00.000Z");
		const auth = makeAuth({ now: () => now });
		await expect(auth.getPairingSettings()).resolves.toEqual({ pairingTtlDays: 180 });

		const first = await auth.pair(REMOTE, auth.currentPairingCode().code);
		expect(Date.parse(first.device.expiresAt) - Date.parse(first.device.createdAt)).toBe(180 * 24 * 60 * 60 * 1000);

		await expect(auth.setPairingSettings(45)).resolves.toEqual({ pairingTtlDays: 45 });
		expect((await auth.listDevices()).find((device) => device.id === first.device.id)?.expiresAt).toBe(
			first.device.expiresAt,
		);

		now += 30_000;
		const second = await auth.pair(REMOTE, auth.currentPairingCode().code);
		expect(Date.parse(second.device.expiresAt) - Date.parse(second.device.createdAt)).toBe(45 * 24 * 60 * 60 * 1000);
		await expect(auth.getPairingSettings()).resolves.toEqual({ pairingTtlDays: 45 });
	});

	it("rejects out-of-range or fractional pairing lifetime settings", async () => {
		const auth = makeAuth();
		for (const value of [0, 3651, 1.5, Number.NaN]) {
			await expect(auth.setPairingSettings(value)).rejects.toMatchObject({ status: 400 });
		}
		await expect(auth.setPairingSettings(1)).resolves.toEqual({ pairingTtlDays: 1 });
		await expect(auth.setPairingSettings(3650)).resolves.toEqual({ pairingTtlDays: 3650 });
	});

	it("claims expiry warnings at the 10% boundary at most once per pairing per UTC day", async () => {
		let now = Date.parse("2030-01-01T00:00:00.000Z");
		const auth = makeAuth({ now: () => now });
		await auth.setPairingSettings(20);
		const { token, device } = await auth.pair(REMOTE, auth.currentPairingCode().code);
		const warningStartsAt = Date.parse(device.expiresAt) - 2 * 24 * 60 * 60 * 1000;
		const decision = await auth.authenticate({ ...REMOTE, deviceToken: token });
		expect(decision.allowed && decision.mode === "remote").toBe(true);
		if (!decision.allowed || decision.mode !== "remote") throw new Error("expected remote pairing");

		now = warningStartsAt - 1;
		await expect(auth.claimPairingExpiryStatus(decision.pairing.id)).resolves.toEqual({
			nextCheckAt: new Date(warningStartsAt).toISOString(),
		});

		now = warningStartsAt;
		const claims = await Promise.all([
			auth.claimPairingExpiryStatus(decision.pairing.id),
			auth.claimPairingExpiryStatus(decision.pairing.id),
			auth.claimPairingExpiryStatus(decision.pairing.id),
		]);
		expect(claims.filter((claim) => claim.warning).map((claim) => claim.warning)).toEqual([
			{ expiresAt: device.expiresAt },
		]);

		now += 24 * 60 * 60 * 1000;
		await expect(auth.claimPairingExpiryStatus(decision.pairing.id)).resolves.toMatchObject({
			warning: { expiresAt: device.expiresAt },
		});
		now = Date.parse(device.expiresAt);
		await expect(auth.claimPairingExpiryStatus(decision.pairing.id)).resolves.toEqual({});
	});

	it("persists pairing settings and daily warning suppression across restarts", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dreb-dashboard-auth-warning-"));
		let now = Date.parse("2030-01-01T00:00:00.000Z");
		try {
			const pairingsPath = join(dir, "pairings.json");
			const secret = Buffer.from(TEST_SECRET);
			const first = makeAuth({ storage: new FilePairingStorage(pairingsPath), secret, now: () => now });
			await first.setPairingSettings(10);
			const { token, device } = await first.pair(REMOTE, first.currentPairingCode().code);
			now = Date.parse(device.expiresAt) - 24 * 60 * 60 * 1000;
			const decision = await first.authenticate({ ...REMOTE, deviceToken: token });
			if (!decision.allowed || decision.mode !== "remote") throw new Error("expected remote pairing");
			await expect(first.claimPairingExpiryStatus(decision.pairing.id)).resolves.toHaveProperty("warning");

			const restarted = makeAuth({ storage: new FilePairingStorage(pairingsPath), secret, now: () => now });
			await expect(restarted.getPairingSettings()).resolves.toEqual({ pairingTtlDays: 10 });
			await expect(restarted.claimPairingExpiryStatus(decision.pairing.id)).resolves.not.toHaveProperty("warning");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("migrates legacy version-1 pairing files without changing recorded expiry", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dreb-dashboard-auth-v1-"));
		try {
			const path = join(dir, "pairings.json");
			const legacyPairing = {
				id: "legacy",
				identity: "alice@example.com",
				createdAt: "2030-01-01T00:00:00.000Z",
				expiresAt: "2030-02-01T00:00:00.000Z",
				tokenHmac: "abc",
			};
			writeFileSync(path, JSON.stringify({ version: 1, pairings: [legacyPairing], consumedPairingWindows: [] }));
			const auth = makeAuth({
				storage: new FilePairingStorage(path),
				now: () => Date.parse("2030-01-02T00:00:00.000Z"),
			});
			await expect(auth.getPairingSettings()).resolves.toEqual({ pairingTtlDays: 180 });
			await auth.setPairingSettings(90);
			const saved = JSON.parse(readFileSync(path, "utf8"));
			expect(saved).toMatchObject({ version: 2, pairingTtlDays: 90 });
			expect(saved.pairings[0].expiresAt).toBe(legacyPairing.expiresAt);
			expect(statSync(path).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects malformed persisted pairing settings instead of resetting them", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dreb-dashboard-auth-invalid-"));
		try {
			const path = join(dir, "pairings.json");
			writeFileSync(
				path,
				JSON.stringify({ version: 2, pairings: [], consumedPairingWindows: [], pairingTtlDays: 0 }),
			);
			const auth = makeAuth({ storage: new FilePairingStorage(path) });
			await expect(auth.getPairingSettings()).rejects.toThrow(/Unrecognized pairing file format/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects reusing a pairing code but accepts a fresh code after rotation", async () => {
		let now = 1_000_000;
		const auth = makeAuth({ now: () => now });
		const { code } = auth.currentPairingCode();

		await expect(auth.pair(REMOTE, code)).resolves.toMatchObject({
			device: { identity: "alice@example.com" },
		});
		await expect(auth.pair(REMOTE, code)).rejects.toMatchObject({ status: 401 });

		now += 30_000;
		await expect(auth.pair(REMOTE, auth.currentPairingCode().code)).resolves.toMatchObject({
			device: { identity: "alice@example.com" },
		});
	});

	it("file-backed pairings keep authenticating after a dashboard restart", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dreb-dashboard-auth-"));
		try {
			const pairingsPath = join(dir, "pairings.json");
			const secretPath = join(dir, "secret");
			const secret = loadOrCreateDashboardSecret(secretPath);
			const first = makeAuth({
				storage: new FilePairingStorage(pairingsPath),
				secret,
				now: () => 1_000_000,
			});
			const { token } = await first.pair(REMOTE, first.currentPairingCode().code);

			const restartedSecret = loadOrCreateDashboardSecret(secretPath);
			expect(restartedSecret.equals(secret)).toBe(true);
			const restarted = makeAuth({
				storage: new FilePairingStorage(pairingsPath),
				secret: restartedSecret,
				now: () => 1_000_000,
			});
			const decision = await restarted.authenticate({ ...REMOTE, deviceToken: token });
			expect(decision.allowed).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("file-backed consumed pairing codes cannot be reused after a dashboard restart", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dreb-dashboard-auth-"));
		try {
			const pairingsPath = join(dir, "pairings.json");
			const secretPath = join(dir, "secret");
			const secret = loadOrCreateDashboardSecret(secretPath);
			const first = makeAuth({
				storage: new FilePairingStorage(pairingsPath),
				secret,
				now: () => 1_000_000,
			});
			const code = first.currentPairingCode().code;
			await expect(first.pair(REMOTE, code)).resolves.toMatchObject({
				device: { identity: "alice@example.com" },
			});

			const restarted = makeAuth({
				storage: new FilePairingStorage(pairingsPath),
				secret: loadOrCreateDashboardSecret(secretPath),
				now: () => 1_000_000,
			});
			await expect(restarted.pair(REMOTE, code)).rejects.toMatchObject({ status: 401 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persistent dashboard secrets are unique per install", () => {
		const a = mkdtempSync(join(tmpdir(), "dreb-dashboard-auth-a-"));
		const b = mkdtempSync(join(tmpdir(), "dreb-dashboard-auth-b-"));
		try {
			const secretA = loadOrCreateDashboardSecret(join(a, "secret"));
			const secretB = loadOrCreateDashboardSecret(join(b, "secret"));
			expect(secretA).toHaveLength(32);
			expect(secretB).toHaveLength(32);
			expect(secretA.equals(secretB)).toBe(false);
		} finally {
			rmSync(a, { recursive: true, force: true });
			rmSync(b, { recursive: true, force: true });
		}
	});

	it("rejects an incorrect pairing code", async () => {
		const auth = makeAuth({ now: () => 1_000_000 });
		const valid = auth.currentPairingCode().code;
		const wrong = valid === "000000" ? "000001" : "000000";
		await expect(auth.pair(REMOTE, wrong)).rejects.toThrow(/Incorrect pairing code/);
	});

	it("locks out repeated incorrect pairing attempts and logs them", async () => {
		const logs: string[] = [];
		const auth = makeAuth({
			now: () => 1_000_000,
			pairingMaxAttempts: 2,
			pairingLockoutMs: 60_000,
			logger: (line) => logs.push(line),
		});
		const valid = auth.currentPairingCode().code;
		const wrong = valid === "000000" ? "000001" : "000000";

		await expect(auth.pair(REMOTE, wrong)).rejects.toMatchObject({ status: 401 });
		await expect(auth.pair(REMOTE, wrong)).rejects.toMatchObject({ status: 429 });
		await expect(auth.pair(REMOTE, valid)).rejects.toMatchObject({ status: 429 });
		expect(logs.join("\n")).toContain("pairing locked");
	});

	it("counts reusing a consumed pairing code toward lockout", async () => {
		const logs: string[] = [];
		const auth = makeAuth({
			now: () => 1_000_000,
			pairingMaxAttempts: 2,
			pairingLockoutMs: 60_000,
			logger: (line) => logs.push(line),
		});
		const code = auth.currentPairingCode().code;

		await auth.pair(REMOTE, code);
		await expect(auth.pair(REMOTE, code)).rejects.toMatchObject({ status: 401 });
		await expect(auth.pair(REMOTE, code)).rejects.toMatchObject({ status: 429 });
		await expect(auth.pair(REMOTE, auth.currentPairingCode().code)).rejects.toMatchObject({ status: 429 });
		expect(logs.join("\n")).toContain("pairing locked");
	});

	it("accepts pairing codes from the adjacent clock-skew windows", async () => {
		let now = 1_000_000;
		const auth = makeAuth({ now: () => now });
		const currentWindow = now;

		now = currentWindow - 30_000;
		const previousCode = auth.currentPairingCode().code;
		now = currentWindow;
		await expect(auth.pair(REMOTE, previousCode)).resolves.toMatchObject({
			device: { identity: "alice@example.com" },
		});

		now = currentWindow + 30_000;
		const nextCode = auth.currentPairingCode().code;
		now = currentWindow;
		await expect(auth.pair(REMOTE, nextCode)).resolves.toMatchObject({
			device: { identity: "alice@example.com" },
		});
	});

	it("rejects pairing codes outside the clock-skew window", async () => {
		let now = 1_000_000;
		const auth = makeAuth({ now: () => now });
		const currentWindow = now;
		const acceptedCodes = new Set<string>();
		for (const offset of [-1, 0, 1]) {
			now = currentWindow + offset * 30_000;
			acceptedCodes.add(auth.currentPairingCode().code);
		}

		let tooFarFutureCode: string | undefined;
		for (let offset = 2; offset < 20; offset++) {
			now = currentWindow + offset * 30_000;
			const candidate = auth.currentPairingCode().code;
			if (!acceptedCodes.has(candidate)) {
				tooFarFutureCode = candidate;
				break;
			}
		}
		expect(tooFarFutureCode).toBeDefined();
		now = currentWindow;

		await expect(auth.pair(REMOTE, tooFarFutureCode!)).rejects.toThrow(/Incorrect pairing code/);
	});

	it("expired pairings stop authenticating", async () => {
		let now = 1_000_000;
		const auth = makeAuth({ now: () => now, pairingTtlMs: 1000 });
		const { token } = await auth.pair(REMOTE, auth.currentPairingCode().code);
		now += 1001;
		const decision = await auth.authenticate({ ...REMOTE, deviceToken: token });
		expect(decision.allowed).toBe(false);
	});

	it("rejects a garbage device token", async () => {
		const auth = makeAuth();
		const decision = await auth.authenticate({ ...REMOTE, deviceToken: "forged-token" });
		expect(decision.allowed).toBe(false);
	});

	it("unpaired devices lose access", async () => {
		const auth = makeAuth({ now: () => 1_000_000 });
		const { token, device } = await auth.pair(REMOTE, auth.currentPairingCode().code);
		expect(await auth.unpair(device.id)).toBe(true);
		const decision = await auth.authenticate({ ...REMOTE, deviceToken: token });
		expect(decision.allowed).toBe(false);
	});

	it("loopback clients cannot pair", async () => {
		const auth = makeAuth();
		await expect(auth.pair(LOCAL_REQUEST, "123456")).rejects.toThrow(/do not pair/);
	});

	it("resolver failure denies (fail-closed)", async () => {
		const auth = makeAuth({ resolver: new ThrowingResolver() });
		const decision = await auth.authenticate(REMOTE);
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.reason).toContain("resolver exploded");
	});

	it("logs sanitized resolver failure categories without peer or command output", async () => {
		const logs: string[] = [];
		const auth = makeAuth({
			resolver: new TailscaleWhoisResolver(async () => {
				throw Object.assign(new Error("secret daemon detail"), { stderr: "secret daemon detail" });
			}),
			logger: (line) => logs.push(line),
		});
		const decision = await auth.authenticate(REMOTE);
		expect(decision).toMatchObject({ allowed: false, status: 500 });
		if (!decision.allowed) {
			expect(decision.reason).toContain("resolver execution failure");
			expect(decision.reason).not.toContain("secret daemon detail");
			expect(decision.reason).not.toContain(REMOTE.remoteAddress);
		}
		expect(logs).toEqual(["identity resolver execution failure — denying"]);
	});

	it("storage failure denies (fail-closed)", async () => {
		const auth = makeAuth({ storage: new ThrowingStorage(), now: () => 1_000_000 });
		await expect(auth.pair(REMOTE, auth.currentPairingCode().code)).rejects.toThrow(/storage exploded/);
		const decision = await auth.authenticate({ ...REMOTE, deviceToken: "whatever" });
		expect(decision.allowed).toBe(false);
	});
});
