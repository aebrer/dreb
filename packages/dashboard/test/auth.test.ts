import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	DashboardAuth,
	isAllowedLocalHost,
	isLoopbackAddress,
	MemoryPairingStorage,
	normalizeAddress,
	type TailscaleIdentity,
	type TailscaleResolver,
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

	it("storage failure denies (fail-closed)", async () => {
		const auth = makeAuth({ storage: new ThrowingStorage(), now: () => 1_000_000 });
		await expect(auth.pair(REMOTE, auth.currentPairingCode().code)).rejects.toThrow(/storage exploded/);
		const decision = await auth.authenticate({ ...REMOTE, deviceToken: "whatever" });
		expect(decision.allowed).toBe(false);
	});
});
